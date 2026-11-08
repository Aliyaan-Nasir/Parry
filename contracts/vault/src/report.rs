//! Signed vault reports, as the risk board forwards them, and what the vault does with them.
//!
//! The hedge lives on Hyperliquid, which a contract cannot read. The enclave observes it, signs
//! a `vault_report`, and the risk board verifies that signature and forwards the exact JSON here.
//! The vault trusts only the configured board for this, so the enclave's key is the only source
//! of hedge and risk input. Fields the vault does not use (the score components) are ignored.

use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json;
use near_sdk::{env, near, require, AccountId};

use crate::nav::to_i128;
use crate::{Event, Vault, VaultExt};
use parry_common::math::Rounding;

/// Position size (1e8) × price (1e8) to USD e6.
const PNL_SCALE: i128 = 10_000_000_000;

/// The report JSON is a few hundred bytes; the bound keeps parsing gas predictable even if the
/// board were misconfigured to forward something else.
pub const MAX_REPORT_BYTES: usize = 8 * 1024;
/// Scores at or above this pause deposits...
pub const PAUSE_SCORE: u8 = 70;
/// ...until a later score falls below this. The gap keeps a score hovering around one line from
/// flapping deposits on and off.
pub const RESUME_SCORE: u8 = 60;
/// Scores at or above this lower the hedge's leverage cap to `REDUCED_LEVERAGE_X100`...
pub const REDUCE_LEVERAGE_SCORE: u8 = 50;
/// ...until a later score falls below this.
pub const RESTORE_LEVERAGE_SCORE: u8 = 40;
pub const REDUCED_LEVERAGE_X100: u32 = 200;
/// Scores at or above this ask the keeper to add margin to the hedge account.
pub const MARGIN_SCORE: u8 = 85;

/// The hedge position as the enclave observed it on Hyperliquid.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgeReport {
    pub asset_index: u32,
    /// Position size scaled 1e8; negative is short.
    pub size_e8: I128,
    pub entry_e8: U128,
    /// The hedge account's value (margin plus unrealized PnL), USD e6.
    pub account_value_e6: U128,
    pub unrealized_e6: I128,
    /// Funding the hedge account has received over its life (negative: paid), USD e6.
    pub funding_e6: I128,
    /// Operator-funded margin in the hedge account, which is not depositors' money and is left
    /// out of NAV.
    pub margin_baseline_e6: U128,
    pub mark_e8: U128,
    pub liquidation_e8: U128,
}

/// The proof-of-reserves summary: a Merkle root over the vault's balances and how they cover
/// its liabilities.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservesReport {
    /// 64 lowercase hex characters.
    pub root: String,
    pub leaves: u32,
    pub total_usd_e6: U128,
    pub liabilities_usd_e6: U128,
    pub ratio_bps: u32,
}

/// The report as received. Unknown fields are ignored on purpose: the board already checked the
/// full signed format, and the vault reads only what it acts on.
#[near(serializers = [json])]
struct ReportIn {
    kind: String,
    run_id: u64,
    at: u64,
    vault: AccountId,
    score: u8,
    hedge: HedgeReport,
    reserves: ReservesReport,
}

/// The latest accepted report.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredReport {
    pub run_id: u64,
    /// When the enclave observed the hedge (unix seconds).
    pub at: u64,
    pub score: u8,
    pub hedge: HedgeReport,
    pub reserves: ReservesReport,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[near]
impl Vault {
    /// Accepts the enclave's vault report, forwarded by the risk board after it verified the
    /// signature. Refused unless it comes from the board, names this vault, carries a newer run
    /// id, and describes the configured hedge asset.
    pub fn on_vault_report(&mut self, report_json: String) {
        require!(env::predecessor_account_id() == self.risk, "only the risk board reports to the vault");
        require!(report_json.len() <= MAX_REPORT_BYTES, "report too large");
        let r: ReportIn = serde_json::from_slice(report_json.as_bytes())
            .unwrap_or_else(|_| env::panic_str("malformed vault report"));
        require!(r.kind == "vault_report", "not a vault report");
        require!(r.vault == env::current_account_id(), "report is for another vault");
        require!(r.run_id > self.last_run_id, "report run id must be newer than the last one");
        require!(r.score <= 100, "score must be at most 100");
        require!(r.hedge.asset_index == self.hedge.asset_index, "report hedge is for another asset index");
        require!(r.hedge.mark_e8.0 > 0, "report carries no mark");
        require!(is_hex64(&r.reserves.root), "reserves root must be 64 lowercase hex characters");
        if let Some(prev) = &self.report {
            require!(r.at >= prev.at, "report observed before the last one");
        }

        self.last_run_id = r.run_id;
        self.near_price_e8 = r.hedge.mark_e8.0;
        self.hedge_order_signed = false;
        Event::ReportApplied { run_id: r.run_id, at: r.at, score: r.score }.emit();
        self.apply_score(r.score);
        self.report = Some(StoredReport {
            run_id: r.run_id,
            at: r.at,
            score: r.score,
            hedge: r.hedge,
            reserves: r.reserves,
        });
    }
}

impl Vault {
    /// Applies the score in code, with hysteresis on both levers. A manual owner pause is a
    /// separate flag, so a calm score never lifts it.
    pub(crate) fn apply_score(&mut self, score: u8) {
        if score >= PAUSE_SCORE && !self.risk_paused {
            self.risk_paused = true;
            Event::DepositsPaused { score }.emit();
        } else if score < RESUME_SCORE && self.risk_paused {
            self.risk_paused = false;
            Event::DepositsResumed { score }.emit();
        }
        if score >= REDUCE_LEVERAGE_SCORE && !self.leverage_reduced {
            self.leverage_reduced = true;
            Event::LeverageReduced { score, max_leverage_x100: self.effective_max_leverage_x100() }.emit();
        } else if score < RESTORE_LEVERAGE_SCORE && self.leverage_reduced {
            self.leverage_reduced = false;
            Event::LeverageRestored { score, max_leverage_x100: self.effective_max_leverage_x100() }.emit();
        }
        // Re-evaluated on every report, and announced on every report while it holds, so a
        // keeper that missed one event still sees the next.
        self.needs_margin = score >= MARGIN_SCORE;
        if self.needs_margin {
            Event::MarginNeeded { score }.emit();
        }
    }

    /// The latest report if it is at most `REPORT_MAX_AGE_SECS` old at `now`.
    pub(crate) fn fresh_report(&self, now: u64) -> Option<&StoredReport> {
        self.report.as_ref().filter(|r| now.saturating_sub(r.at) <= crate::REPORT_MAX_AGE_SECS)
    }

    /// The depositors' hedge equity valued at `price_e8` rather than at the report's mark: the
    /// reported equity plus the position's PnL from the mark to that price, size × (price −
    /// mark) (1e8 × 1e8 / 1e10 = USD e6), rounded as asked. A report can be 15 minutes old, and
    /// pricing a deposit against equity the market has already moved would let a depositor who
    /// times a move take value from the holders (or overpay).
    pub(crate) fn hedge_equity_at(&self, price_e8: u128, rounding: Rounding) -> i128 {
        let equity = self.hedge_equity_e6();
        let Some(r) = &self.report else { return equity };
        let move_e16 = r.hedge.size_e8.0.saturating_mul(to_i128(price_e8) - to_i128(r.hedge.mark_e8.0));
        let pnl = match rounding {
            Rounding::Down => move_e16.div_euclid(PNL_SCALE),
            Rounding::Up => -(move_e16.saturating_neg().div_euclid(PNL_SCALE)),
        };
        equity.saturating_add(pnl)
    }

    /// The depositors' hedge equity, USD e6: account value − operator margin − PnL already
    /// settled with leavers. Negative when the hedge has lost more than it has earned.
    pub(crate) fn hedge_equity_e6(&self) -> i128 {
        match &self.report {
            None => 0,
            Some(r) => {
                crate::nav::to_i128(r.hedge.account_value_e6.0)
                    - crate::nav::to_i128(r.hedge.margin_baseline_e6.0)
                    - self.settled_pnl_e6
            }
        }
    }
}
