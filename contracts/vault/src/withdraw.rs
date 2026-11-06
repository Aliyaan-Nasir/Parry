//! Withdrawals: escrow, queue, settle, pay, and claims for what could not be paid.
//!
//! `request_withdraw` moves the shares into the vault's own account (an ordinary NEP-141
//! transfer, with its event) and queues them. Their hedge is no longer targeted, so the keeper
//! unwinds it; an entry is paid once a report observed after the request, which is the vault's
//! evidence that the hedge moved. `process_withdrawals` (anyone) reads the LiNEAR rate and pays
//! from the head of the queue.
//!
//! Each payment is an `ft_transfer` with its own callback. A failed transfer (for example a
//! receiver not registered with LiNEAR) leaves the tokens with the vault and records them as the
//! leaver's claim, which `claim` retries; nothing is lost and nothing panics after funds moved.

use near_contract_standards::fungible_token::events::FtBurn;
use near_sdk::json_types::{I128, U128};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use parry_common::{now_secs, promise_bytes, wire as common_wire, ONE_YOCTO};

use crate::deposit::parse_result;
use crate::nav;
use crate::{wire, Event, Vault, VaultExt, GAS_VIEW};

/// NEP-141 `ft_transfer` on LiNEAR or test USDC.
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(10);
/// Two transfers with their callbacks, plus the settlement itself.
const GAS_PER_WITHDRAWAL: u64 = 2 * (15 + 10) + 5;
/// Withdrawals settled per call, so the call fits in one transaction's gas.
pub const MAX_WITHDRAWALS_PER_CALL: u32 = 4;
pub const DEFAULT_PAGE: u64 = 50;
pub const MAX_PAGE: u64 = 100;

pub const TOKEN_LINEAR: &str = "linear";
pub const TOKEN_USDC: &str = "usdc";

/// One queued withdrawal.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    pub id: u64,
    pub account: AccountId,
    pub shares: U128,
    /// Unix seconds; paid once a report with a later `at` arrived.
    pub requested_at: u64,
}

/// What the vault owes one account outside NEP-141 shares.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Claim {
    /// LiNEAR whose transfer failed.
    pub linear: U128,
    /// USDC whose transfer failed (already taken from the buffer).
    pub usdc: U128,
    /// USDC hedge PnL the buffer could not cover yet; paid by `claim` as the buffer allows.
    pub usdc_owed: U128,
}

impl Claim {
    fn is_empty(&self) -> bool {
        self.linear.0 == 0 && self.usdc.0 == 0 && self.usdc_owed.0 == 0
    }
}

#[near]
impl Vault {
    /// Escrows `shares` of the caller and queues their withdrawal. Returns the withdrawal id.
    /// One yoctoNEAR, so only a full-access key can start it.
    #[payable]
    pub fn request_withdraw(&mut self, shares: U128) -> u64 {
        assert_one_yocto();
        require!(shares.0 > 0, "shares must be positive");
        let account = env::predecessor_account_id();
        self.token.internal_transfer(
            &account,
            &env::current_account_id(),
            shares.0,
            Some("withdrawal escrow".to_string()),
        );
        let id = self.next_withdrawal_id;
        self.next_withdrawal_id += 1;
        self.queued_shares += shares.0;
        Event::WithdrawalRequested { id, account: &account, shares }.emit();
        self.withdrawals.insert(id, Withdrawal { id, account, shares, requested_at: now_secs() });
        id
    }

    /// Pays up to `max` withdrawals (at most 4) from the head of the queue whose request is older
    /// than the latest report. Anyone may call it. Returns how many were paid (0 when none is
    /// ready).
    pub fn process_withdrawals(&mut self, max: u32) -> PromiseOrValue<u32> {
        let report_at = self.fresh_report(now_secs()).map(|r| r.at).unwrap_or_else(|| {
            env::panic_str(
                "the latest vault report is older than 15 minutes: withdrawals wait for a fresh report",
            )
        });
        let n = self.ready_count(report_at, max.min(MAX_WITHDRAWALS_PER_CALL));
        if n == 0 {
            return PromiseOrValue::Value(0);
        }
        let callback_gas = Gas::from_tgas(10 + GAS_PER_WITHDRAWAL * n as u64);
        require!(
            env::prepaid_gas() >= Gas::from_tgas(20).saturating_add(callback_gas),
            "attach 300 TGas to process withdrawals"
        );
        PromiseOrValue::Promise(
            Promise::new(self.linear.clone())
                .function_call("ft_price", wire::NO_ARGS.to_vec(), NearToken::from_yoctonear(0), GAS_VIEW)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(callback_gas)
                        .with_unused_gas_weight(1)
                        .on_withdraw_rate(n),
                ),
        )
    }

    /// Settles up to `max` ready withdrawals at the rate just read and the report's mark.
    #[private]
    pub fn on_withdraw_rate(&mut self, max: u32) -> u32 {
        let Some(rate) = parse_result::<U128>(0).map(|r| r.0).filter(|r| *r > 0) else {
            Event::WithdrawalsDeferred { reason: "LiNEAR rate unavailable" }.emit();
            return 0;
        };
        self.observe_rate(rate);
        let Some((report_at, mark)) = self.fresh_report(now_secs()).map(|r| (r.at, r.hedge.mark_e8.0)) else {
            Event::WithdrawalsDeferred { reason: "the vault report went stale" }.emit();
            return 0;
        };
        let mut done = 0;
        while done < max {
            let Some(w) = self.withdrawals.get(&self.withdrawal_head).cloned() else { break };
            if w.requested_at >= report_at {
                break;
            }
            self.settle(w, rate, mark);
            self.withdrawal_head += 1;
            done += 1;
        }
        done
    }

    /// Records a failed payout as the account's claim.
    #[private]
    pub fn on_payout(&mut self, account: AccountId, token: String, amount: U128) -> bool {
        if promise_bytes(0).is_some() {
            return true;
        }
        let mut c = self.claims.get(&account).cloned().unwrap_or_default();
        if token == TOKEN_LINEAR {
            c.linear = U128(c.linear.0 + amount.0);
        } else {
            c.usdc = U128(c.usdc.0 + amount.0);
        }
        self.claims.insert(account.clone(), c);
        Event::PayoutFailed { account: &account, token: &token, amount }.emit();
        false
    }

    /// Pays the caller's claims: LiNEAR and USDC whose transfer failed, and owed USDC as far as
    /// the buffer covers it. Returns what was sent; what still fails becomes a claim again.
    pub fn claim(&mut self) -> Claim {
        require!(env::prepaid_gas() >= Gas::from_tgas(60), "attach at least 60 TGas to claim");
        let account = env::predecessor_account_id();
        let mut c = self.claims.get(&account).cloned().unwrap_or_else(|| env::panic_str("nothing to claim"));
        let from_buffer = c.usdc_owed.0.min(self.buffer_usdc);
        let sent = Claim { linear: c.linear, usdc: U128(c.usdc.0 + from_buffer), usdc_owed: U128(0) };
        require!(sent.linear.0 > 0 || sent.usdc.0 > 0, "nothing to claim yet: the USDC buffer is empty");
        self.buffer_usdc -= from_buffer;
        c = Claim { linear: U128(0), usdc: U128(0), usdc_owed: U128(c.usdc_owed.0 - from_buffer) };
        if c.is_empty() {
            self.claims.remove(&account);
        } else {
            self.claims.insert(account.clone(), c);
        }
        Event::Claimed { account: &account, linear: sent.linear, usdc: sent.usdc }.emit();
        self.pay(&account, TOKEN_LINEAR, sent.linear.0);
        self.pay(&account, TOKEN_USDC, sent.usdc.0);
        sent
    }

    /// Queued withdrawals, oldest first, from `from_index` (0 is the head).
    pub fn queue(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Withdrawal> {
        let start = self.withdrawal_head.saturating_add(from_index.unwrap_or(0));
        let end =
            start.saturating_add(limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE)).min(self.next_withdrawal_id);
        (start..end).filter_map(|id| self.withdrawals.get(&id).cloned()).collect()
    }

    /// A withdrawal still in the queue (paid ones are reported by `withdrawal_processed`).
    pub fn withdrawal(&self, id: u64) -> Option<Withdrawal> {
        self.withdrawals.get(&id).cloned()
    }

    pub fn claimable(&self, account_id: AccountId) -> Claim {
        self.claims.get(&account_id).cloned().unwrap_or_default()
    }

    /// Sends loss-backing LiNEAR to the owner: it was kept from leavers whose hedge share was
    /// negative, and it compensates the margin provider, whose margin carries that loss. Owner
    /// only, with one yoctoNEAR.
    #[payable]
    pub fn release_loss_backing(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0 && amount.0 <= self.loss_backing_linear, "amount exceeds the loss backing");
        self.loss_backing_linear -= amount.0;
        Event::LossBackingReleased { amount }.emit();
        Promise::new(self.linear.clone())
            .function_call(
                "ft_transfer",
                common_wire::ft_transfer(&self.owner_id, amount.0),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAYOUT)
                    .on_loss_backing_released(amount),
            )
    }

    /// Puts the LiNEAR back into the loss backing if the transfer failed.
    #[private]
    pub fn on_loss_backing_released(&mut self, amount: U128) -> bool {
        if promise_bytes(0).is_some() {
            return true;
        }
        self.loss_backing_linear += amount.0;
        false
    }
}

impl Vault {
    /// Queue entries from the head, up to `max`, whose request predates the report.
    fn ready_count(&self, report_at: u64, max: u32) -> u32 {
        let mut n = 0;
        let mut id = self.withdrawal_head;
        while n < max {
            match self.withdrawals.get(&id) {
                Some(w) if w.requested_at < report_at => {
                    n += 1;
                    id += 1;
                }
                _ => break,
            }
        }
        n
    }

    /// Burns the escrowed shares and pays the leaver (see `nav::payout`).
    fn settle(&mut self, w: Withdrawal, rate_e24: u128, price_e8: u128) {
        let me = env::current_account_id();
        let p = nav::payout(
            w.shares.0,
            self.token.total_supply,
            self.staked_linear,
            rate_e24,
            price_e8,
            self.hedge_equity_e6(),
        );
        self.token.internal_withdraw(&me, w.shares.0);
        FtBurn { owner_id: &me, amount: w.shares, memo: Some("withdrawal") }.emit();
        self.queued_shares -= w.shares.0;
        self.staked_linear -= p.linear + p.retained;
        self.loss_backing_linear += p.retained;
        self.settled_pnl_e6 += p.pnl_e6;
        let (usdc, owed) = if p.pnl_e6 > 0 {
            let due = p.pnl_e6 as u128;
            let now = due.min(self.buffer_usdc);
            self.buffer_usdc -= now;
            (now, due - now)
        } else {
            (0, 0)
        };
        if owed > 0 {
            let mut c = self.claims.get(&w.account).cloned().unwrap_or_default();
            c.usdc_owed = U128(c.usdc_owed.0 + owed);
            self.claims.insert(w.account.clone(), c);
        }
        self.withdrawals.remove(&w.id);
        Event::WithdrawalProcessed {
            id: w.id,
            account: &w.account,
            shares: w.shares,
            linear: U128(p.linear),
            usdc: U128(usdc),
            usdc_owed: U128(owed),
            pnl_e6: I128(p.pnl_e6),
        }
        .emit();
        self.pay(&w.account, TOKEN_LINEAR, p.linear);
        self.pay(&w.account, TOKEN_USDC, usdc);
    }

    /// `ft_transfer` of `amount` of `token` to `account`, with a callback that turns a failure
    /// into a claim. Nothing for a zero amount.
    fn pay(&self, account: &AccountId, token: &str, amount: u128) {
        if amount == 0 {
            return;
        }
        let token_id = if token == TOKEN_LINEAR { &self.linear } else { &self.usdc };
        Promise::new(token_id.clone())
            .function_call(
                "ft_transfer",
                common_wire::ft_transfer(account, amount),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAYOUT).on_payout(
                account.clone(),
                token.to_string(),
                U128(amount),
            ))
            .detach();
    }
}
