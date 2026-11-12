//! Owner exits: `close_rhea` and `unwind`.
//!
//! **Close.** One round sells collateral on the exchange and repays debt, as a promise chain:
//! position and oracle prices → `simple_withdraw` of the collateral to sell → deposit into the
//! exchange → `swap` (at least the debt to repay) → exchange `withdraw` of the debt token → repay
//! → read the position → when no debt is left, `simple_withdraw` of all the remaining collateral.
//! The lending contract lets collateral out only while health stays at or above 1, so the round
//! sells at most what keeps health at 1.02 after the withdrawal: when that is enough to buy the
//! whole debt (plus slippage), one call closes the position; otherwise the round repays what it
//! can, emits `close_progress`, and the next `close_rhea` continues from a smaller, healthier
//! position.
//!
//! Every failure up to the swap restores the round's collateral (`close_rolled_back` names the
//! step). After the swap the tokens are the account's own and only move between the exchange,
//! the account and the lending contract, so a failed later step waits as `stuck_<step>` for
//! `retry_close` (anyone may call it) instead of selling back at a loss.
//!
//! **Unwind.** Revokes the mandate, withdraws every lending supply and (when nothing is borrowed)
//! collateral, then sends each listed token's whole balance and the NEAR above the storage
//! reserve to the owner (or `to`). A step that fails for one token leaves that balance in the
//! account and emits `unwind_partial`; the others go through.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use parry_common::math::{apply_bps, mul_div, pow10, Rounding, BPS};
use parry_common::protocol::Owner;
use parry_common::rhea::{self, AccountLines, PricedAsset};
use parry_common::{now_secs, promise_bytes, wire, ONE_YOCTO};

use crate::guardian::{
    parse_result, require_gas, GAS_CALLBACK, GAS_DEX, GAS_ENVELOPE, GAS_VIEW, GAS_WITHDRAW,
};
use crate::{ft_transfer_call, load_runtime, save_runtime, Account, AccountExt, Event, GAS_TOKEN_CALL};

const CLOSING_KEY: &[u8] = b"close";
/// The owner's slippage bound for a close, 0.01% to 10%.
pub const MAX_CLOSE_SLIPPAGE_BPS: u16 = 1_000;
/// Health a round's withdrawal must leave: the lending contract refuses below 1.0.
pub const WITHDRAW_HEALTH_BPS: u128 = 10_200;
/// The last round repays the debt read plus 0.5 bps and one token unit, for the interest that
/// accrues before the repay lands; what it does not need stays supplied to lending.
const INTEREST_MARGIN_DIV: u128 = 20_000;
pub const MAX_UNWIND_TOKENS: usize = 16;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// NEAR an unwind leaves above the storage the account uses, for the state it may still write.
pub const UNWIND_NEAR_MARGIN: NearToken = NearToken::from_millinear(10);

/// Least prepaid gas for `close_rhea` with `tokens` protocol tokens: the position view and three
/// price views per token, two withdrawals from lending, two token transfers, the swap and the
/// exchange withdrawal, the position check, and eight callbacks, each at its static gas.
pub fn close_gas(tokens: usize) -> Gas {
    Gas::from_tgas(
        GAS_ENVELOPE.as_tgas()
            + (2 + 3 * tokens as u64) * GAS_VIEW.as_tgas()
            + 8 * GAS_CALLBACK.as_tgas()
            + 2 * GAS_WITHDRAW.as_tgas()
            + 2 * GAS_TOKEN_CALL.as_tgas()
            + 2 * GAS_DEX.as_tgas(),
    )
}

/// Least prepaid gas for `retry_close`: from a stuck exchange withdrawal to the end.
pub fn retry_close_gas() -> Gas {
    Gas::from_tgas(
        GAS_DEX.as_tgas()
            + GAS_TOKEN_CALL.as_tgas()
            + GAS_VIEW.as_tgas()
            + GAS_WITHDRAW.as_tgas()
            + 4 * GAS_CALLBACK.as_tgas(),
    )
}

/// Least prepaid gas for `unwind`: the position view, a withdrawal per protocol token, a balance
/// view and a transfer per listed token, and four callbacks.
pub fn unwind_gas(protocol_tokens: usize, tokens: usize) -> Gas {
    Gas::from_tgas(
        GAS_ENVELOPE.as_tgas()
            + GAS_VIEW.as_tgas()
            + protocol_tokens as u64 * GAS_WITHDRAW.as_tgas()
            + tokens as u64 * (GAS_VIEW.as_tgas() + GAS_FT_TRANSFER.as_tgas())
            + 4 * GAS_CALLBACK.as_tgas(),
    )
}

/// A close round in flight.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Closing {
    /// The block height it started at.
    pub id: u64,
    pub collateral: AccountId,
    pub debt: AccountId,
    pub pool_id: u64,
    pub slippage_bps: u16,
    /// Collateral token units sold, the swap's minimum and output, and the most the round repays
    /// (debt token units).
    pub sell: U128,
    pub min_out: U128,
    pub out: U128,
    pub repay: U128,
    /// True when the round repays the whole debt.
    pub last: bool,
    pub stage: String,
    /// The step whose failure is being rolled back.
    pub failed: Option<String>,
    pub started_at: u64,
}

/// One round's sizes (token units).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClosePlan {
    pub sell: u128,
    pub min_out: u128,
    pub repay: u128,
    pub last: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenAmount {
    pub token: AccountId,
    pub amount: U128,
}

#[near(event_json(standard = "parry-account"))]
pub enum CloseEvent<'a> {
    #[event_version("1.0.0")]
    CloseStage { id: u64, stage: &'a str },
    #[event_version("1.0.0")]
    CloseRolledBack { id: u64, stage: &'a str, reason: &'a str },
    #[event_version("1.0.0")]
    CloseStuck { id: u64, stage: &'a str },
    #[event_version("1.0.0")]
    CloseProgress {
        id: u64,
        debt_repaid: U128,
        collateral_sold: U128,
        debt_left: U128,
        collateral_left: U128,
    },
    #[event_version("1.0.0")]
    PositionClosed {
        id: u64,
        collateral: &'a AccountId,
        debt: &'a AccountId,
        debt_repaid: U128,
        collateral_sold: U128,
        collateral_returned: U128,
    },
    #[event_version("1.0.0")]
    UnwindPartial { token: &'a AccountId, reason: &'a str },
    #[event_version("1.0.0")]
    Unwound { to: &'a AccountId, tokens: &'a [TokenAmount], near: U128 },
}

pub(crate) fn load_closing() -> Option<Closing> {
    env::storage_read(CLOSING_KEY)
        .map(|b| near_sdk::borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("bad close state")))
}

fn save_closing(c: &Closing) {
    let bytes = near_sdk::borsh::to_vec(c).unwrap_or_else(|_| env::panic_str("close encoding failed"));
    env::storage_write(CLOSING_KEY, &bytes);
}

pub(crate) fn clear_closing() {
    env::storage_remove(CLOSING_KEY);
}

/// Sizes one round. `collateral` and `debt` are priced (oracle price, rate, volatility ratio);
/// balances are in inner units, `extra_*` are the assets' extra decimals.
///
/// The round may withdraw collateral worth at most what keeps health at `WITHDRAW_HEALTH_BPS`.
/// When the debt plus its interest margin, plus slippage, fits in that, it sells exactly that
/// (rounded up to a token unit), asks the swap for the whole repay, and is the last round.
/// Otherwise it sells the most it may and asks for its oracle value less slippage.
pub fn plan_close(
    collateral_inner: u128,
    debt_inner: u128,
    collateral: &PricedAsset,
    extra_c: u8,
    debt: &PricedAsset,
    extra_d: u8,
    slippage_bps: u16,
) -> Result<ClosePlan, &'static str> {
    let (unit_c, unit_d) = (pow10(collateral.inner_decimals as u32), pow10(debt.inner_decimals as u32));
    let (xc, xd) = (pow10(extra_c as u32), pow10(extra_d as u32));
    // USD e18 per whole token.
    let (vc, vd) = (rhea::value_e18(unit_c, collateral), rhea::value_e18(unit_d, debt));
    if vc == 0 || vd == 0 {
        return Err("no usable price for the position");
    }
    let slip = slippage_bps as u128;
    let coll_val = mul_div(collateral_inner, vc, unit_c, Rounding::Down);
    let debt_val = mul_div(debt_inner, vd, unit_d, Rounding::Up);
    let adj_debt = mul_div(debt_val, BPS, (debt.volatility_ratio_bps as u128).max(1), Rounding::Up);
    let keep = mul_div(
        adj_debt,
        WITHDRAW_HEALTH_BPS,
        (collateral.volatility_ratio_bps as u128).max(1),
        Rounding::Up,
    );
    let max_sell_val = coll_val.saturating_sub(keep);

    let repay_inner = debt_inner + debt_inner / INTEREST_MARGIN_DIV + xd;
    let repay = repay_inner.div_ceil(xd);
    let need_val = apply_bps(mul_div(repay * xd, vd, unit_d, Rounding::Up), BPS + slip, Rounding::Up);
    if need_val <= max_sell_val {
        let sell = mul_div(need_val, unit_c, vc, Rounding::Up).div_ceil(xc);
        if sell * xc > collateral_inner {
            return Err("the collateral does not cover the debt");
        }
        return Ok(ClosePlan { sell, min_out: repay, repay, last: true });
    }
    let sell = mul_div(max_sell_val, unit_c, vc, Rounding::Down) / xc;
    if sell == 0 {
        return Err("health is too close to 1 to sell collateral: repay or deleverage first");
    }
    let sell_val = mul_div(sell * xc, vc, unit_c, Rounding::Down);
    let decimals_d = (debt.inner_decimals - extra_d) as u32;
    let min_out =
        mul_div(apply_bps(sell_val, BPS - slip, Rounding::Down), pow10(decimals_d), vd, Rounding::Down);
    if min_out == 0 {
        return Err("the round is too small to swap");
    }
    Ok(ClosePlan { sell, min_out, repay, last: false })
}

#[near]
impl Account {
    // -----------------------------------------------------------------------------------------
    // Close
    // -----------------------------------------------------------------------------------------

    /// Reads the position with the prices, and sizes and starts the round.
    #[private]
    pub fn on_close_read(
        &mut self,
        id: u64,
        slippage_bps: u16,
        pool_id: u64,
        tokens: Vec<AccountId>,
    ) -> PromiseOrValue<bool> {
        let refuse = |reason: &str| {
            CloseEvent::CloseRolledBack { id, stage: "read", reason }.emit();
            PromiseOrValue::Value(false)
        };
        if load_closing().is_some() {
            return refuse("another close is in flight");
        }
        if load_runtime().pending.is_some() {
            return refuse("a deleverage is in flight");
        }
        let Some(lines) = promise_bytes(0).and_then(|b| AccountLines::parse(&b)) else {
            return refuse("the lending position could not be read");
        };
        let p = self.core.protocol.clone();
        let borrowed: Vec<_> = lines.borrowed.iter().filter(|l| l.balance.0 > 0).collect();
        let collateral: Vec<_> = lines.collateral.iter().filter(|l| l.balance.0 > 0).collect();
        if borrowed.is_empty() {
            return refuse("nothing is borrowed: withdraw the collateral instead");
        }
        if borrowed.len() != 1 || collateral.len() != 1 {
            return refuse("a close takes one collateral and one debt asset");
        }
        let (c, d) = (collateral[0].token_id.clone(), borrowed[0].token_id.clone());
        let (Some(cc), Some(dc)) = (p.token(&c), p.token(&d)) else {
            return refuse("the position holds a token the protocol does not list");
        };
        if c == d {
            return refuse("the collateral and the debt are the same token");
        }
        let quotes = self.read_prices_from(&tokens, true, 1);
        let priced = |t: &AccountId| -> Option<PricedAsset> {
            let i = tokens.iter().position(|x| x == t)?;
            let (price, ratio, rate) = (*quotes.get(i)?)?;
            let cfg = p.token(t)?;
            Some(PricedAsset {
                token_id: t.clone(),
                inner_decimals: cfg.decimals + cfg.extra_decimals,
                volatility_ratio_bps: ratio,
                price,
                rate_e24: rate,
            })
        };
        let (Some(pc), Some(pd)) = (priced(&c), priced(&d)) else {
            return refuse("no fresh oracle price for the position");
        };
        let plan = match plan_close(
            lines.collateral_of(&c),
            lines.borrowed_of(&d),
            &pc,
            cc.extra_decimals,
            &pd,
            dc.extra_decimals,
            slippage_bps,
        ) {
            Ok(plan) => plan,
            Err(reason) => return refuse(reason),
        };
        let inner = plan.sell * pow10(cc.extra_decimals as u32);
        let closing = Closing {
            id,
            collateral: c.clone(),
            debt: d,
            pool_id,
            slippage_bps,
            sell: U128(plan.sell),
            min_out: U128(plan.min_out),
            out: U128(0),
            repay: U128(plan.repay),
            last: plan.last,
            stage: String::new(),
            failed: None,
            started_at: now_secs(),
        };
        self.close_stage(closing, "withdraw");
        PromiseOrValue::Promise(
            Promise::new(p.lending.clone())
                .function_call(
                    "simple_withdraw",
                    rhea::simple_withdraw_args(&c, inner),
                    ONE_YOCTO,
                    GAS_WITHDRAW,
                )
                .then(self.cb().on_close_withdrawn(id)),
        )
    }

    #[private]
    pub fn on_close_withdrawn(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some(c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<bool>(0) != Some(true) {
            // If the token transfer failed after the collateral was decreased, the lending
            // contract kept the tokens as supply: move exactly that amount back to collateral.
            let p = &self.core.protocol;
            let inner = c.sell.0 * pow10(p.token(&c.collateral).unwrap().extra_decimals as u32);
            Promise::new(p.lending.clone())
                .function_call(
                    "execute",
                    rhea::increase_collateral_args(&c.collateral, Some(inner)),
                    ONE_YOCTO,
                    GAS_WITHDRAW,
                )
                .detach();
            return self.close_rolled_back(
                c,
                "withdraw",
                "the lending contract did not let the collateral out",
            );
        }
        let (token, amount) = (c.collateral.clone(), c.sell.0);
        self.close_stage(c, "deposit");
        PromiseOrValue::Promise(
            ft_transfer_call(&token, &self.core.protocol.dex, amount, "")
                .then(self.cb().on_close_deposited(id)),
        )
    }

    #[private]
    pub fn on_close_deposited(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some(c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        let used = parse_result::<U128>(0).map(|u| u.0).unwrap_or(0);
        if used != c.sell.0 {
            // What the exchange did not take came back here; take the rest out and re-supply all.
            return self.close_restore(c, used, "deposit");
        }
        let swap = wire::dex_swap(c.pool_id, &c.collateral, c.sell.0, &c.debt, c.min_out.0);
        self.close_stage(c, "swap");
        PromiseOrValue::Promise(
            Promise::new(self.core.protocol.dex.clone())
                .function_call("swap", swap, ONE_YOCTO, GAS_DEX)
                .then(self.cb().on_close_swapped(id)),
        )
    }

    #[private]
    pub fn on_close_swapped(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some(mut c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        let Some(out) = parse_result::<U128>(0).filter(|o| o.0 >= c.min_out.0) else {
            let sell = c.sell.0;
            return self.close_restore(c, sell, "swap");
        };
        c.out = out;
        let debt = c.debt.clone();
        self.close_stage(c, "withdraw_out");
        PromiseOrValue::Promise(self.dex_withdraw(&debt, out.0).then(self.cb().on_close_out(id)))
    }

    #[private]
    pub fn on_close_out(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some(c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<U128>(0).map(|u| u.0) != Some(c.out.0) {
            // The debt tokens are still the account's, as an exchange deposit.
            return self.close_stuck(c, "withdraw_out");
        }
        PromiseOrValue::Promise(self.close_repay(c))
    }

    #[private]
    pub fn on_close_repaid(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some(c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<U128>(0).map_or(0, |u| u.0) == 0 {
            // The lending contract refused the repay: the debt tokens came back to the account.
            return self.close_stuck(c, "repay");
        }
        PromiseOrValue::Promise(self.close_verify(c))
    }

    /// With no debt left, withdraws all the remaining collateral; otherwise ends the round.
    #[private]
    pub fn on_close_verified(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some(c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        let Some(lines) = promise_bytes(0).and_then(|b| AccountLines::parse(&b)) else {
            return self.close_stuck(c, "verify");
        };
        let p = &self.core.protocol;
        let xc = pow10(p.token(&c.collateral).unwrap().extra_decimals as u32);
        let xd = pow10(p.token(&c.debt).unwrap().extra_decimals as u32);
        let left = lines.collateral_of(&c.collateral) + lines.supplied_of(&c.collateral);
        if lines.borrowed.iter().any(|l| l.balance.0 > 0) {
            CloseEvent::CloseProgress {
                id,
                debt_repaid: c.repay.min(c.out),
                collateral_sold: c.sell,
                debt_left: U128(lines.borrowed_of(&c.debt).div_ceil(xd)),
                collateral_left: U128(left / xc),
            }
            .emit();
            clear_closing();
            return PromiseOrValue::Value(true);
        }
        if left == 0 {
            return PromiseOrValue::Value(self.close_done(c, 0));
        }
        let token = c.collateral.clone();
        self.close_stage(c, "withdraw_rest");
        PromiseOrValue::Promise(
            Promise::new(p.lending.clone())
                .function_call(
                    "simple_withdraw",
                    rhea::simple_withdraw_args(&token, left),
                    ONE_YOCTO,
                    GAS_WITHDRAW,
                )
                .then(self.cb().on_close_returned(id, U128(left))),
        )
    }

    #[private]
    pub fn on_close_returned(&mut self, id: u64, inner: U128) -> bool {
        let Some(c) = closing_for(id) else { return false };
        if parse_result::<bool>(0) != Some(true) {
            // No debt is left, so the collateral is safe where it is; a retry withdraws it.
            return matches!(self.close_stuck(c, "withdraw_rest"), PromiseOrValue::Value(true));
        }
        let xc = pow10(self.core.protocol.token(&c.collateral).unwrap().extra_decimals as u32);
        self.close_done(c, inner.0 / xc)
    }

    #[private]
    pub fn on_close_restore_withdrawn(&mut self, id: u64, from_dex: U128) -> PromiseOrValue<bool> {
        let Some(c) = closing_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<U128>(0).map(|u| u.0) != Some(from_dex.0) {
            return self.close_stuck(c, "restore");
        }
        PromiseOrValue::Promise(self.close_resupply(c))
    }

    /// Ends the rollback once the lending contract took the collateral back; when it did not,
    /// the collateral waits in the account as `stuck_resupply`.
    #[private]
    pub fn on_close_restored(&mut self, id: u64) -> bool {
        let Some(mut c) = closing_for(id) else { return false };
        let used = parse_result::<U128>(0).map_or(0, |u| u.0).min(c.sell.0);
        if used < c.sell.0 {
            c.sell = U128(c.sell.0 - used);
            return matches!(self.close_stuck(c, "resupply"), PromiseOrValue::Value(true));
        }
        let failed = c.failed.clone().unwrap_or_default();
        matches!(
            self.close_rolled_back(c, &failed, "the collateral was re-supplied"),
            PromiseOrValue::Value(true)
        )
    }

    /// Resumes a close stuck after its swap (or in its rollback). Anyone may call it: every step
    /// only moves the account's own tokens between the exchange, the account and the lending
    /// contract. It needs `retry_close_gas` of prepaid gas. Each step is marked in flight before it
    /// starts, so a second retry cannot run beside it.
    pub fn retry_close(&mut self) -> Promise {
        require_gas(retry_close_gas());
        let c = load_closing().unwrap_or_else(|| env::panic_str("no close in flight"));
        let id = c.id;
        match c.stage.as_str() {
            "stuck_withdraw_out" => {
                let (debt, out) = (c.debt.clone(), c.out.0);
                self.close_stage(c, "withdraw_out");
                self.dex_withdraw(&debt, out).then(self.cb().on_close_out(id))
            }
            "stuck_repay" => self.close_repay(c),
            "stuck_verify" | "stuck_withdraw_rest" => self.close_verify(c),
            "stuck_restore" => {
                let (token, sell) = (c.collateral.clone(), c.sell.0);
                self.close_stage(c, "restore_retry");
                self.dex_withdraw(&token, sell).then(self.cb().on_close_restore_withdrawn(id, U128(sell)))
            }
            "stuck_resupply" => {
                self.close_stage(c.clone(), "restore_retry");
                self.close_resupply(c)
            }
            _ => env::panic_str("the close is not stuck"),
        }
    }

    // -----------------------------------------------------------------------------------------
    // Unwind
    // -----------------------------------------------------------------------------------------

    /// Withdraws every supply, and the collateral when nothing is borrowed.
    #[private]
    pub fn on_unwind_read(&mut self, to: AccountId, tokens: Vec<AccountId>) -> PromiseOrValue<bool> {
        let p = self.core.protocol.clone();
        let Some(lines) = promise_bytes(0).and_then(|b| AccountLines::parse(&b)) else {
            CloseEvent::UnwindPartial { token: &p.lending, reason: "the lending position could not be read" }
                .emit();
            return self.unwind_balances(to, tokens);
        };
        let has_debt = lines.borrowed.iter().any(|l| l.balance.0 > 0);
        let mut withdrawn = vec![];
        let mut joint: Option<Promise> = None;
        for t in &p.tokens {
            let collateral = lines.collateral_of(&t.token_id);
            let mut amount = lines.supplied_of(&t.token_id);
            if has_debt && collateral > 0 {
                CloseEvent::UnwindPartial {
                    token: &t.token_id,
                    reason: "the collateral backs a loan: close the position first",
                }
                .emit();
            } else {
                amount += collateral;
            }
            if amount == 0 {
                continue;
            }
            let w = Promise::new(p.lending.clone()).function_call(
                "simple_withdraw",
                rhea::simple_withdraw_args(&t.token_id, amount),
                ONE_YOCTO,
                GAS_WITHDRAW,
            );
            joint = Some(match joint {
                None => w,
                Some(j) => j.and(w),
            });
            withdrawn.push(t.token_id.clone());
        }
        match joint {
            None => self.unwind_balances(to, tokens),
            Some(j) => PromiseOrValue::Promise(j.then(self.cb().on_unwind_withdrawn(to, tokens, withdrawn))),
        }
    }

    #[private]
    pub fn on_unwind_withdrawn(
        &mut self,
        to: AccountId,
        tokens: Vec<AccountId>,
        withdrawn: Vec<AccountId>,
    ) -> PromiseOrValue<bool> {
        for (i, t) in withdrawn.iter().enumerate() {
            if parse_result::<bool>(i as u64) != Some(true) {
                CloseEvent::UnwindPartial { token: t, reason: "the lending withdrawal failed" }.emit();
            }
        }
        self.unwind_balances(to, tokens)
    }

    /// Sends each listed token's whole balance.
    #[private]
    pub fn on_unwind_balances(&mut self, to: AccountId, tokens: Vec<AccountId>) -> PromiseOrValue<bool> {
        let mut sent = vec![];
        let mut joint: Option<Promise> = None;
        for (i, t) in tokens.iter().enumerate() {
            let Some(balance) = parse_result::<U128>(i as u64) else {
                CloseEvent::UnwindPartial { token: t, reason: "the balance could not be read" }.emit();
                continue;
            };
            if balance.0 == 0 {
                continue;
            }
            let transfer = Promise::new(t.clone()).function_call(
                "ft_transfer",
                wire::ft_transfer(&to, balance.0),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            );
            joint = Some(match joint {
                None => transfer,
                Some(j) => j.and(transfer),
            });
            sent.push(TokenAmount { token: t.clone(), amount: balance });
        }
        match joint {
            None => PromiseOrValue::Value(self.unwind_finish(&to, vec![])),
            Some(j) => PromiseOrValue::Promise(j.then(self.cb().on_unwind_sent(to, sent))),
        }
    }

    #[private]
    pub fn on_unwind_sent(&mut self, to: AccountId, sent: Vec<TokenAmount>) -> bool {
        let mut done = vec![];
        for (i, s) in sent.into_iter().enumerate() {
            if promise_bytes(i as u64).is_some() {
                done.push(s);
            } else {
                CloseEvent::UnwindPartial { token: &s.token, reason: "the transfer failed" }.emit();
            }
        }
        self.unwind_finish(&to, done)
    }

    pub fn closing(&self) -> Option<Closing> {
        load_closing()
    }
}

fn closing_for(id: u64) -> Option<Closing> {
    load_closing().filter(|c| c.id == id)
}

impl Account {
    /// Starts a close: one round, as the module docs describe.
    pub(crate) fn start_close(&mut self, slippage_bps: u16, pool_id: u64) -> Promise {
        require!(
            slippage_bps > 0 && slippage_bps <= MAX_CLOSE_SLIPPAGE_BPS,
            "slippage_bps must be 1 to 1000"
        );
        require!(load_closing().is_none(), "a close is in flight");
        require!(load_runtime().pending.is_none(), "a deleverage is in flight");
        let p = self.core.protocol.clone();
        require_gas(close_gas(p.tokens.len()));
        let tokens: Vec<AccountId> = p.tokens.iter().map(|t| t.token_id.clone()).collect();
        let read = Promise::new(p.lending.clone()).function_call(
            "get_account",
            wire::account_id(&env::current_account_id()),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        );
        let id = env::block_height();
        CloseEvent::CloseStage { id, stage: "read" }.emit();
        read.and(self.price_views(&tokens, true)).then(self.cb().on_close_read(
            id,
            slippage_bps,
            pool_id,
            tokens,
        ))
    }

    /// Starts an unwind: the mandate is revoked at once, then the chain.
    pub(crate) fn start_unwind(&mut self, tokens: Vec<AccountId>, to: Option<AccountId>) -> Promise {
        let to = match (&self.core.owner, to) {
            (_, Some(to)) => to,
            (Owner::Near { account_id }, None) => account_id.clone(),
            (Owner::Passkey { .. }, None) => env::panic_str("a passkey-owned account must name `to`"),
        };
        require!(tokens.len() <= MAX_UNWIND_TOKENS, "at most 16 tokens");
        for (i, t) in tokens.iter().enumerate() {
            require!(!tokens[..i].contains(t), "a token is listed twice");
        }
        require!(load_closing().is_none(), "a close is in flight");
        let mut rt = load_runtime();
        require!(rt.pending.is_none(), "a deleverage is in flight");
        let p = self.core.protocol.clone();
        require_gas(unwind_gas(p.tokens.len(), tokens.len()));
        if rt.mandate.take().is_some() {
            save_runtime(&rt);
            Event::MandateRevoked {}.emit();
        }
        Promise::new(p.lending.clone())
            .function_call(
                "get_account",
                wire::account_id(&env::current_account_id()),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(self.cb().on_unwind_read(to, tokens))
    }

    fn close_stage(&self, mut c: Closing, stage: &str) {
        c.stage = stage.to_string();
        CloseEvent::CloseStage { id: c.id, stage }.emit();
        save_closing(&c);
    }

    fn close_stuck(&self, c: Closing, step: &str) -> PromiseOrValue<bool> {
        CloseEvent::CloseStuck { id: c.id, stage: step }.emit();
        let stage = format!("stuck_{step}");
        self.close_stage(c, &stage);
        PromiseOrValue::Value(false)
    }

    fn close_rolled_back(&self, c: Closing, step: &str, reason: &str) -> PromiseOrValue<bool> {
        CloseEvent::CloseRolledBack { id: c.id, stage: step, reason }.emit();
        clear_closing();
        PromiseOrValue::Value(true)
    }

    fn close_done(&self, c: Closing, returned: u128) -> bool {
        CloseEvent::PositionClosed {
            id: c.id,
            collateral: &c.collateral,
            debt: &c.debt,
            debt_repaid: c.repay.min(c.out),
            collateral_sold: c.sell,
            collateral_returned: U128(returned),
        }
        .emit();
        clear_closing();
        true
    }

    /// Takes `from_dex` of the collateral out of the exchange, then re-supplies the whole sale.
    fn close_restore(&self, mut c: Closing, from_dex: u128, step: &str) -> PromiseOrValue<bool> {
        c.failed = Some(step.to_string());
        let id = c.id;
        let token = c.collateral.clone();
        self.close_stage(c.clone(), &format!("restore_{step}"));
        if from_dex == 0 {
            return PromiseOrValue::Promise(self.close_resupply(c));
        }
        PromiseOrValue::Promise(
            self.dex_withdraw(&token, from_dex)
                .then(self.cb().on_close_restore_withdrawn(id, U128(from_dex))),
        )
    }

    fn close_resupply(&self, c: Closing) -> Promise {
        ft_transfer_call(
            &c.collateral,
            &self.core.protocol.lending,
            c.sell.0,
            rhea::MSG_ONLY_INCREASE_COLLATERAL,
        )
        .then(self.cb().on_close_restored(c.id))
    }

    fn close_repay(&self, c: Closing) -> Promise {
        let (id, debt, amount) = (c.id, c.debt.clone(), c.repay.0.min(c.out.0));
        self.close_stage(c, "repay");
        ft_transfer_call(&debt, &self.core.protocol.lending, amount, rhea::MSG_ONLY_REPAY)
            .then(self.cb().on_close_repaid(id))
    }

    fn close_verify(&self, c: Closing) -> Promise {
        let id = c.id;
        self.close_stage(c, "verify");
        Promise::new(self.core.protocol.lending.clone())
            .function_call(
                "get_account",
                wire::account_id(&env::current_account_id()),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(self.cb().on_close_verified(id))
    }

    fn unwind_balances(&self, to: AccountId, tokens: Vec<AccountId>) -> PromiseOrValue<bool> {
        let me = env::current_account_id();
        let mut joint: Option<Promise> = None;
        for t in &tokens {
            let view = Promise::new(t.clone()).function_call(
                "ft_balance_of",
                wire::account_id(&me),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            );
            joint = Some(match joint {
                None => view,
                Some(j) => j.and(view),
            });
        }
        match joint {
            None => PromiseOrValue::Value(self.unwind_finish(&to, vec![])),
            Some(j) => PromiseOrValue::Promise(j.then(self.cb().on_unwind_balances(to, tokens))),
        }
    }

    /// Sends the NEAR above the storage reserve and reports what left the account.
    fn unwind_finish(&self, to: &AccountId, tokens: Vec<TokenAmount>) -> bool {
        let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        let keep = storage.saturating_add(UNWIND_NEAR_MARGIN);
        let near = env::account_balance().saturating_sub(keep);
        if !near.is_zero() {
            Promise::new(to.clone()).transfer(near).detach();
        }
        CloseEvent::Unwound { to, tokens: &tokens, near: U128(near.as_yoctonear()) }.emit();
        true
    }
}
