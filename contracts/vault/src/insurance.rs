//! The insurance fund: a share of the depositors' positive yield, set aside to pay for what can
//! go wrong with the hedge.
//!
//! - **Inflow.** Staking yield is skimmed whenever the vault reads a LiNEAR rate above the highest
//!   it has seen: `share_bps` of the growth on the depositors' LiNEAR moves from `staked_linear`
//!   into the fund's LiNEAR. Funding is skimmed on each accepted report: `share_bps` of the
//!   funding received since the previous report becomes the fund's USDC, a claim on the hedge
//!   account that the depositors' hedge equity no longer includes. Each report emits one
//!   `insurance_inflow` with what moved since the previous one. The share price excludes the fund.
//! - **Payouts** (`insurance_pay`, keeper only) return value to the depositors (negative funding,
//!   hedge slippage) or earmark it for hedge margin (`margin_top_up`). Each kind has its own bound,
//!   and every payout checks the per-payout cap and the per-day cap (a share of the fund's value
//!   at the day's first payout). USDC is used first, then LiNEAR at the last known rate and price.

use near_sdk::json_types::{I128, U128};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, Gas, Promise};
use parry_common::math::{apply_bps, mul_div, Rounding, BPS};
use parry_common::{day_of, now_secs, promise_bytes, wire as common_wire, ONE_YOCTO};

use crate::nav::{self, E24};
use crate::{Event, StorageKey, Vault, VaultExt};

/// Defaults: 10% of positive yield, at most 25% of the fund paid per UTC day, at most 1000 USD
/// per payout.
pub const DEFAULT_SHARE_BPS: u32 = 1_000;
pub const DEFAULT_CAP_PER_DAY_BPS: u32 = 2_500;
pub const DEFAULT_MAX_PAYOUT_E6: u128 = 1_000_000_000;
/// The share of yield the fund may take is at most half.
pub const MAX_SHARE_BPS: u32 = 5_000;
/// Funding deltas kept to judge whether the last reports show net negative funding.
pub const FUNDING_WINDOW: usize = 12;
/// Insurance events kept for `insurance_history`; older ones are removed from storage.
pub const HISTORY: u64 = 500;
pub const DEFAULT_PAGE: u64 = 50;
pub const MAX_PAGE: u64 = 100;

pub const KIND_NEGATIVE_FUNDING: &str = "negative_funding";
pub const KIND_HEDGE_SLIPPAGE: &str = "hedge_slippage";
pub const KIND_MARGIN_TOP_UP: &str = "margin_top_up";

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ON_RELEASED: Gas = Gas::from_tgas(10);

/// The fund's state.
#[near(serializers = [borsh])]
pub struct Insurance {
    pub share_bps: u32,
    pub cap_per_day_bps: u32,
    pub max_payout_e6: u128,
    /// LiNEAR the fund owns (held by the vault, outside `staked_linear`).
    pub linear: u128,
    /// USD e6 the fund owns inside the hedge account (outside the depositors' hedge equity).
    pub usdc_e6: u128,
    pub paid_total_e6: u128,
    /// UTC day of the last payout, what was paid that day, and the fund's value at its first
    /// payout (what the day's cap is a share of).
    pub paid_day: u64,
    pub paid_today_e6: u128,
    pub day_value_e6: u128,
    /// Value earmarked for hedge margin by `margin_top_up`: LiNEAR held by the vault for the
    /// operator to route, and USDC already inside the hedge account.
    pub margin_reserved_linear: u128,
    pub margin_reserved_usdc_e6: u128,
    /// Highest LiNEAR rate seen: staking yield is skimmed only above it.
    pub rate_mark_e24: u128,
    /// LiNEAR skimmed since the last report, announced with the next `insurance_inflow`.
    pub pending_linear: u128,
    /// The hedge size and lifetime funding of the last report the fund measured, so a funding
    /// delta is only ever taken between two reports it saw (not across a migration, where the
    /// stored report may measure funding differently).
    pub funding_mark: Option<(i128, i128)>,
    /// Funding received minus paid between consecutive reports, newest last.
    pub funding_window: Vec<i128>,
    /// Funding the hedge paid (as a positive number) since the fund began, and how much of it
    /// payouts have covered.
    pub negative_funding_e6: u128,
    pub covered_negative_funding_e6: u128,
    /// The last hedge order the vault signed, for a slippage payout once a later report shows it.
    pub last_order: Option<SignedOrder>,
    history: LookupMap<u64, InsuranceEvent>,
    history_head: u64,
    history_tail: u64,
}

/// A hedge order the vault signed: against which report, its size and the mark and band it was
/// priced with.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedOrder {
    pub report_at: u64,
    pub size_e8: U128,
    pub mark_e8: U128,
    pub band_bps: u32,
    pub compensated: bool,
}

/// One inflow or payout, as `insurance_history` returns it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsuranceEvent {
    /// "insurance_inflow" or "insurance_paid".
    pub event: String,
    pub at: u64,
    /// Inflow: LiNEAR and USD e6 that moved into the fund, and the report that moved them.
    pub linear: Option<U128>,
    pub usdc_e6: Option<U128>,
    pub report_at: Option<u64>,
    /// Payout: its kind, value and why it was payable.
    pub kind: Option<String>,
    pub amount_usd_e6: Option<U128>,
    pub reason: Option<String>,
}

/// The fund as `insurance()` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsuranceView {
    pub share_bps: u32,
    pub linear: U128,
    pub usdc_e6: U128,
    /// The fund at the last known LiNEAR rate and NEAR price.
    pub value_usd_e6: U128,
    pub paid_total_e6: U128,
    pub paid_today_e6: U128,
    pub cap_per_day_bps: u32,
    pub max_payout_e6: U128,
    pub margin_reserved_usd_e6: U128,
    pub margin_reserved_linear: U128,
    pub margin_reserved_usdc_e6: U128,
    pub negative_funding_e6: U128,
    pub covered_negative_funding_e6: U128,
    /// Funding over the kept window of report deltas (negative: the hedge paid).
    pub recent_funding_e6: I128,
}

impl Default for Insurance {
    fn default() -> Self {
        Self::new()
    }
}

impl Insurance {
    pub fn new() -> Self {
        Insurance {
            share_bps: DEFAULT_SHARE_BPS,
            cap_per_day_bps: DEFAULT_CAP_PER_DAY_BPS,
            max_payout_e6: DEFAULT_MAX_PAYOUT_E6,
            linear: 0,
            usdc_e6: 0,
            paid_total_e6: 0,
            paid_day: 0,
            paid_today_e6: 0,
            day_value_e6: 0,
            margin_reserved_linear: 0,
            margin_reserved_usdc_e6: 0,
            rate_mark_e24: 0,
            pending_linear: 0,
            funding_mark: None,
            funding_window: Vec::new(),
            negative_funding_e6: 0,
            covered_negative_funding_e6: 0,
            last_order: None,
            history: LookupMap::new(StorageKey::InsuranceHistory),
            history_head: 0,
            history_tail: 0,
        }
    }

    fn record(&mut self, e: InsuranceEvent) {
        self.history.insert(self.history_tail, e);
        self.history_tail += 1;
        if self.history_tail - self.history_head > HISTORY {
            self.history.remove(&self.history_head);
            self.history_head += 1;
        }
    }

    pub fn recent_funding_e6(&self) -> i128 {
        self.funding_window.iter().fold(0i128, |a, d| a.saturating_add(*d))
    }
}

pub(crate) fn assert_settings(share_bps: u32, cap_per_day_bps: u32, max_payout_e6: u128) {
    require!(share_bps <= MAX_SHARE_BPS, "insurance_share_bps must be at most 5000");
    require!(
        cap_per_day_bps > 0 && cap_per_day_bps as u128 <= BPS,
        "insurance_cap_per_day_bps must be 1 to 10000"
    );
    require!(max_payout_e6 > 0, "insurance_max_payout_e6 must be positive");
}

#[near]
impl Vault {
    /// Pays `amount_usd_e6` from the fund for `kind` (keeper only). `report_at` names the report
    /// that shows the loss: the latest report, or for `hedge_slippage` the report the order was
    /// signed against (a later report must have arrived). Returns the reason it was payable.
    pub fn insurance_pay(&mut self, kind: String, amount_usd_e6: U128, report_at: u64) -> String {
        require!(env::predecessor_account_id() == self.keeper, "keeper only");
        let amount = amount_usd_e6.0;
        require!(amount > 0, "amount must be positive");
        require!(amount <= self.insurance.max_payout_e6, "amount above the per-payout cap");
        let now = now_secs();
        let latest = self
            .fresh_report(now)
            .map(|r| r.at)
            .unwrap_or_else(|| env::panic_str("the latest vault report is older than 15 minutes"));

        let value = self.insurance_value_e6();
        require!(amount <= value, "amount above the fund's value");
        let today = day_of(now);
        if self.insurance.paid_day != today {
            self.insurance.paid_day = today;
            self.insurance.paid_today_e6 = 0;
            self.insurance.day_value_e6 = value;
        }
        let day_cap =
            apply_bps(self.insurance.day_value_e6, self.insurance.cap_per_day_bps as u128, Rounding::Down);
        require!(self.insurance.paid_today_e6 + amount <= day_cap, "amount above the per-day cap");

        let reason = match kind.as_str() {
            KIND_NEGATIVE_FUNDING => {
                require!(report_at == latest, "report_at must be the latest report");
                let recent = self.insurance.recent_funding_e6();
                require!(recent < 0, "the last reports show no net negative funding");
                let open = self
                    .insurance
                    .negative_funding_e6
                    .saturating_sub(self.insurance.covered_negative_funding_e6);
                require!(amount <= open, "amount above the negative funding not yet covered");
                self.insurance.covered_negative_funding_e6 += amount;
                format!(
                    "the last reports show {} USD e6 of net funding paid; {open} USD e6 was not covered yet",
                    recent.unsigned_abs()
                )
            }
            KIND_HEDGE_SLIPPAGE => {
                let order = self
                    .insurance
                    .last_order
                    .clone()
                    .filter(|o| o.report_at == report_at)
                    .unwrap_or_else(|| env::panic_str("no hedge order was signed against that report"));
                require!(!order.compensated, "that hedge order was already compensated");
                require!(latest > order.report_at, "the order's fill shows only in a later report");
                // The most an immediate-or-cancel fill can slip from the mark it was priced at.
                let notional = mul_div(order.size_e8.0, order.mark_e8.0, 10_000_000_000, Rounding::Down);
                let bound = apply_bps(notional, order.band_bps as u128, Rounding::Down);
                require!(amount <= bound, "amount above the order's band");
                self.insurance.last_order = Some(SignedOrder { compensated: true, ..order });
                format!("hedge order against the report at {report_at} filled beyond its mark; bound {bound} USD e6")
            }
            KIND_MARGIN_TOP_UP => {
                require!(report_at == latest, "report_at must be the latest report");
                require!(self.needs_margin, "the hedge does not need margin");
                "the risk score asks for hedge margin".to_string()
            }
            _ => env::panic_str("kind must be negative_funding, hedge_slippage or margin_top_up"),
        };

        let (usdc, linear) = self.debit_fund(amount);
        if kind == KIND_MARGIN_TOP_UP {
            self.insurance.margin_reserved_usdc_e6 += usdc;
            self.insurance.margin_reserved_linear += linear;
        } else {
            // Back to the depositors: USDC by no longer being the fund's, LiNEAR into the book.
            self.staked_linear += linear;
        }
        self.insurance.paid_today_e6 += amount;
        self.insurance.paid_total_e6 += amount;
        Event::InsurancePaid { kind: &kind, amount_usd_e6, reason: &reason }.emit();
        self.insurance.record(InsuranceEvent {
            event: "insurance_paid".into(),
            at: now,
            linear: None,
            usdc_e6: None,
            report_at: Some(report_at),
            kind: Some(kind),
            amount_usd_e6: Some(amount_usd_e6),
            reason: Some(reason.clone()),
        });
        reason
    }

    /// Sends LiNEAR earmarked for hedge margin to the owner, who routes it to the hedge account.
    /// Owner only, with one yoctoNEAR.
    #[payable]
    pub fn release_margin_reserve(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.insurance.margin_reserved_linear,
            "amount exceeds the LiNEAR earmarked for margin"
        );
        self.insurance.margin_reserved_linear -= amount.0;
        Event::MarginReserveReleased { amount }.emit();
        Promise::new(self.linear.clone())
            .function_call(
                "ft_transfer",
                common_wire::ft_transfer(&self.owner_id, amount.0),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RELEASED)
                    .on_margin_released(amount),
            )
    }

    /// Puts the LiNEAR back into the margin earmark if the transfer failed.
    #[private]
    pub fn on_margin_released(&mut self, amount: U128) -> bool {
        if promise_bytes(0).is_some() {
            return true;
        }
        self.insurance.margin_reserved_linear += amount.0;
        false
    }

    /// Owner only, with one yoctoNEAR.
    #[payable]
    pub fn set_insurance(&mut self, share_bps: u32, cap_per_day_bps: u32, max_payout_e6: U128) {
        self.assert_owner();
        assert_settings(share_bps, cap_per_day_bps, max_payout_e6.0);
        self.insurance.share_bps = share_bps;
        self.insurance.cap_per_day_bps = cap_per_day_bps;
        self.insurance.max_payout_e6 = max_payout_e6.0;
        Event::ConfigUpdated { key: "insurance" }.emit();
    }

    pub fn insurance(&self) -> InsuranceView {
        let i = &self.insurance;
        let today = day_of(now_secs());
        let margin_linear_e6 = self.linear_usd_e6(i.margin_reserved_linear);
        InsuranceView {
            share_bps: i.share_bps,
            linear: U128(i.linear),
            usdc_e6: U128(i.usdc_e6),
            value_usd_e6: U128(self.insurance_value_e6()),
            paid_total_e6: U128(i.paid_total_e6),
            paid_today_e6: U128(if i.paid_day == today { i.paid_today_e6 } else { 0 }),
            cap_per_day_bps: i.cap_per_day_bps,
            max_payout_e6: U128(i.max_payout_e6),
            margin_reserved_usd_e6: U128(margin_linear_e6.saturating_add(i.margin_reserved_usdc_e6)),
            margin_reserved_linear: U128(i.margin_reserved_linear),
            margin_reserved_usdc_e6: U128(i.margin_reserved_usdc_e6),
            negative_funding_e6: U128(i.negative_funding_e6),
            covered_negative_funding_e6: U128(i.covered_negative_funding_e6),
            recent_funding_e6: I128(i.recent_funding_e6()),
        }
    }

    /// Inflows and payouts, newest first, skipping the `from` newest.
    pub fn insurance_history(&self, from: Option<u64>, limit: Option<u64>) -> Vec<InsuranceEvent> {
        let i = &self.insurance;
        let len = i.history_tail - i.history_head;
        let from = from.unwrap_or(0);
        let end = len.min(from.saturating_add(limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE)));
        (from..end).filter_map(|k| i.history.get(&(i.history_tail - 1 - k)).cloned()).collect()
    }
}

impl Vault {
    /// USD e6 that `linear` LiNEAR is worth at the last known rate and price, rounded down.
    pub(crate) fn linear_usd_e6(&self, linear: u128) -> u128 {
        let near = nav::linear_to_near(linear, self.linear_rate_e24, Rounding::Down);
        nav::near_to_usd_e6(near, self.near_price_e8, Rounding::Down)
    }

    /// The fund's value at the last known rate and price.
    pub(crate) fn insurance_value_e6(&self) -> u128 {
        self.linear_usd_e6(self.insurance.linear).saturating_add(self.insurance.usdc_e6)
    }

    /// Takes `amount` of value out of the fund, USDC first, then LiNEAR (rounded down, so the
    /// fund never pays more than `amount`). Returns (USDC, LiNEAR) taken.
    fn debit_fund(&mut self, amount: u128) -> (u128, u128) {
        let usdc = amount.min(self.insurance.usdc_e6);
        self.insurance.usdc_e6 -= usdc;
        let rest = amount - usdc;
        if rest == 0 || self.near_price_e8 == 0 || self.linear_rate_e24 == 0 {
            return (usdc, 0);
        }
        let near = nav::usd_e6_to_near(rest, self.near_price_e8);
        let linear = nav::near_to_linear(near, self.linear_rate_e24).min(self.insurance.linear);
        self.insurance.linear -= linear;
        (usdc, linear)
    }

    /// Skims the fund's share of the staking yield when `rate_e24` is above the highest rate seen:
    /// share × (rate − mark) × L / 1e24 NEAR, as LiNEAR at `rate_e24`.
    pub(crate) fn skim_staking(&mut self, rate_e24: u128) {
        let mark = self.insurance.rate_mark_e24;
        if rate_e24 <= mark {
            return;
        }
        self.insurance.rate_mark_e24 = rate_e24;
        if mark == 0 || self.staked_linear == 0 || self.insurance.share_bps == 0 {
            return;
        }
        let growth_near = mul_div(self.staked_linear, rate_e24 - mark, E24, Rounding::Down);
        let fund_near = apply_bps(growth_near, self.insurance.share_bps as u128, Rounding::Down);
        let linear = nav::near_to_linear(fund_near, rate_e24).min(self.staked_linear);
        self.staked_linear -= linear;
        self.insurance.linear += linear;
        self.insurance.pending_linear += linear;
    }

    /// On an accepted report: records the funding delta since the previous report, skims the
    /// fund's share of positive funding, and announces what moved into the fund since the
    /// previous report. A delta is only taken while both reports show a position, since a
    /// closed position reports no funding.
    pub(crate) fn insurance_on_report(&mut self, size_e8: i128, funding_e6: i128, at: u64) {
        let prev = self.insurance.funding_mark.replace((size_e8, funding_e6));
        let mut usdc = 0;
        if let Some((prev_size, prev_funding)) = prev {
            if prev_size != 0 && size_e8 != 0 {
                let delta = funding_e6.saturating_sub(prev_funding);
                let w = &mut self.insurance.funding_window;
                w.push(delta);
                if w.len() > FUNDING_WINDOW {
                    w.remove(0);
                }
                if delta > 0 {
                    usdc = apply_bps(delta as u128, self.insurance.share_bps as u128, Rounding::Down);
                    self.insurance.usdc_e6 += usdc;
                } else {
                    self.insurance.negative_funding_e6 += delta.unsigned_abs();
                }
            }
        }
        let linear = std::mem::take(&mut self.insurance.pending_linear);
        if linear == 0 && usdc == 0 {
            return;
        }
        Event::InsuranceInflow { linear: U128(linear), usdc_e6: U128(usdc), report_at: at }.emit();
        self.insurance.record(InsuranceEvent {
            event: "insurance_inflow".into(),
            at: now_secs(),
            linear: Some(U128(linear)),
            usdc_e6: Some(U128(usdc)),
            report_at: Some(at),
            kind: None,
            amount_usd_e6: None,
            reason: None,
        });
    }

    /// Notes the hedge order just signed against the report observed at `report_at`.
    pub(crate) fn insurance_on_order(&mut self, report_at: u64, size_e8: u128, mark_e8: u128) {
        self.insurance.last_order = Some(SignedOrder {
            report_at,
            size_e8: U128(size_e8),
            mark_e8: U128(mark_e8),
            band_bps: self.hedge.band_bps,
            compensated: false,
        });
    }
}
