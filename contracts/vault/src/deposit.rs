//! Deposits: NEAR directly, or wNEAR through `ft_transfer_call` (unwrapped first).
//!
//! deposit / unwrapped wNEAR → oracle price & LiNEAR rate (joint) → `on_deposit_priced` →
//! LiNEAR `deposit_and_stake` → `on_staked` (mint).
//!
//! Synchronous checks panic, which returns the attached NEAR (or, for wNEAR, makes the token
//! refund the transfer). From the first callback on, the vault holds the depositor's NEAR, so
//! every refusal refunds it and logs `deposit_refunded`; no callback panics after funds moved.
//! Shares are minted only in `on_staked`, after LiNEAR confirmed the stake.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, serde, serde_json, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use parry_common::math::{deviation_bps, Rounding};
use parry_common::pyth::{PythPrice, NEAR_USD};
use parry_common::{now_secs, promise_bytes, ONE_YOCTO};

use crate::nav;
use crate::{wire, Event, Vault, VaultExt, GAS_VIEW, ORACLE_MAX_AGE_SECS, ORACLE_MAX_DEVIATION_BPS};

/// LiNEAR's `deposit_and_stake`.
const GAS_STAKE: Gas = Gas::from_tgas(50);
const GAS_ON_STAKED: Gas = Gas::from_tgas(20);
/// Own work, the stake and its callback.
const GAS_ON_PRICED: Gas = Gas::from_tgas(15 + 50 + 20);
const GAS_NEAR_WITHDRAW: Gas = Gas::from_tgas(10);
/// Own work, the two pricing views and `on_deposit_priced`.
const GAS_ON_UNWRAPPED: Gas = Gas::from_tgas(15 + 2 * 10 + 85);
/// Least prepaid gas for `deposit`: below it a callback could run out after the vault took the
/// NEAR, so the call is refused up front instead.
pub const GAS_DEPOSIT: Gas = Gas::from_tgas(10 + 2 * 10 + 85);
/// Least gas `ft_on_transfer` must have left for the wNEAR path.
pub const GAS_WNEAR_DEPOSIT: Gas = Gas::from_tgas(10 + 10 + 120);

/// Messages accepted with a wNEAR transfer.
const WNEAR_MSGS: [&str; 2] = ["", "deposit"];
/// Message the owner sends test USDC with to fund the settlement buffer.
pub const BUFFER_MSG: &str = "buffer";

pub(crate) fn parse_result<T: serde::de::DeserializeOwned>(index: u64) -> Option<T> {
    promise_bytes(index).and_then(|b| serde_json::from_slice(&b).ok())
}

/// The oracle price scaled 1e8, or None for a price the vault cannot use (non-positive, or an
/// exponent outside what a USD price can have, which would overflow the scaling).
fn usable_price_e8(p: &PythPrice) -> Option<u128> {
    if p.price.0 <= 0 || !(-18..=0).contains(&p.expo) {
        return None;
    }
    Some(p.price_e8()).filter(|v| *v > 0)
}

#[near]
impl Vault {
    /// Deposits the attached NEAR. Returns the shares minted (0 if the deposit was refunded).
    /// Attach at least 115 TGas; 200 TGas leaves room.
    #[payable]
    pub fn deposit(&mut self) -> Promise {
        require!(env::prepaid_gas() >= GAS_DEPOSIT, "attach at least 115 TGas to deposit");
        let account = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        self.start_deposit(&account, amount, "near").unwrap_or_else(|reason| env::panic_str(&reason))
    }

    /// After wNEAR's `near_withdraw`. Returns the unused wNEAR for the token's resolver: all of it
    /// if the unwrap failed (the token then refunds it), none once the vault holds the NEAR.
    #[private]
    pub fn on_unwrapped(&mut self, sender_id: AccountId, amount: U128) -> U128 {
        if promise_bytes(0).is_none() {
            Event::DepositRefunded {
                account: &sender_id,
                amount,
                reason: "wNEAR could not be unwrapped; returned as wNEAR",
            }
            .emit();
            return amount;
        }
        // The deposit continues detached, so its own result never reaches the wNEAR resolver
        // (which would read it as an amount to refund).
        match self.start_deposit(&sender_id, amount.0, "wnear") {
            Ok(promise) => promise.detach(),
            Err(reason) => self.refund_near(&sender_id, amount.0, &reason),
        }
        U128(0)
    }

    /// Prices the deposit (oracle price, LiNEAR rate) and stakes it.
    #[private]
    pub fn on_deposit_priced(&mut self, account: AccountId, amount: U128) -> PromiseOrValue<U128> {
        match self.price_deposit(amount.0) {
            Err(reason) => {
                self.pending_deposit_near = self.pending_deposit_near.saturating_sub(amount.0);
                self.refund_near(&account, amount.0, reason);
                PromiseOrValue::Value(U128(0))
            }
            Ok(priced) => {
                Event::DepositPriced {
                    account: &account,
                    amount,
                    shares: U128(priced.shares),
                    price_e8: U128(priced.price_e8),
                    linear_rate_e24: U128(priced.rate_e24),
                }
                .emit();
                PromiseOrValue::Promise(
                    Promise::new(self.linear.clone())
                        .function_call(
                            "deposit_and_stake",
                            wire::NO_ARGS.to_vec(),
                            NearToken::from_yoctonear(amount.0),
                            GAS_STAKE,
                        )
                        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_STAKED).on_staked(
                            account,
                            amount,
                            U128(priced.shares),
                            U128(priced.rate_e24),
                        )),
                )
            }
        }
    }

    /// Mints the shares once LiNEAR took the NEAR, or refunds it. Returns the shares minted.
    #[private]
    pub fn on_staked(&mut self, account: AccountId, amount: U128, shares: U128, rate: U128) -> U128 {
        self.pending_deposit_near = self.pending_deposit_near.saturating_sub(amount.0);
        let Some(result) = promise_bytes(0) else {
            self.refund_near(&account, amount.0, "LiNEAR staking failed");
            return U128(0);
        };
        // LiNEAR mints amount / r; when it reports the amount it minted, the vault never credits
        // more than that (the rate can tick up between pricing and staking).
        let mut linear = nav::near_to_linear(amount.0, rate.0);
        if let Ok(U128(minted)) = serde_json::from_slice::<U128>(&result) {
            if minted > 0 {
                linear = linear.min(minted);
            }
        }
        self.staked_linear += linear;
        // The depositor may have unregistered while the stake was in flight; the shares are
        // theirs regardless, so the vault registers them again at its own cost.
        if !self.token.accounts.contains_key(&account) {
            self.token.internal_register_account(&account);
        }
        self.token.internal_deposit(&account, shares.0);
        FtMint { owner_id: &account, amount: shares, memo: Some("deposit") }.emit();
        Event::DepositStaked { account: &account, amount, linear: U128(linear), shares }.emit();
        shares
    }
}

#[near]
impl FungibleTokenReceiver for Vault {
    /// wNEAR (msg "" or "deposit") is unwrapped and deposited for `sender_id`. Test USDC with msg
    /// "buffer" from the owner funds the settlement buffer. Anything else is refused, which makes
    /// the token return the transfer.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if token == self.usdc {
            require!(
                msg == BUFFER_MSG,
                "test USDC is only taken as a settlement buffer top-up (msg \"buffer\")"
            );
            require!(sender_id == self.owner_id, "only the owner funds the settlement buffer");
            self.buffer_usdc += amount.0;
            Event::BufferFunded { amount, buffer: U128(self.buffer_usdc) }.emit();
            return PromiseOrValue::Value(U128(0));
        }
        require!(token == self.wnear, "the vault takes wNEAR deposits and the owner's test USDC only");
        require!(WNEAR_MSGS.contains(&msg.as_str()), "unknown msg: send wNEAR with msg \"deposit\"");
        require!(
            env::prepaid_gas().saturating_sub(env::used_gas()) >= GAS_WNEAR_DEPOSIT,
            "a wNEAR deposit needs at least 140 TGas for the vault: attach 300 TGas"
        );
        if let Err(reason) = self.check_deposit(&sender_id, amount.0) {
            env::panic_str(&reason);
        }
        PromiseOrValue::Promise(
            Promise::new(self.wnear.clone())
                .function_call("near_withdraw", wire::near_withdraw(amount.0), ONE_YOCTO, GAS_NEAR_WITHDRAW)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_UNWRAPPED)
                        .on_unwrapped(sender_id, amount),
                ),
        )
    }
}

/// A priced deposit.
struct Priced {
    shares: u128,
    rate_e24: u128,
    price_e8: u128,
}

impl Vault {
    /// The checks every deposit passes before the vault takes the NEAR: not paused, at least the
    /// minimum, a fresh report, and room under the cap. Returns (NEAR to stake, registration cost).
    pub(crate) fn check_deposit(&self, account: &AccountId, gross: u128) -> Result<(u128, u128), String> {
        if self.manual_paused {
            return Err("deposits are paused by the owner".into());
        }
        if self.risk_paused {
            return Err("deposits are paused: the vault risk score is high".into());
        }
        if gross < self.min_deposit {
            return Err(format!("deposit below the minimum of {} yoctoNEAR", self.min_deposit));
        }
        if self.fresh_report(now_secs()).is_none() {
            return Err(
                "the latest vault report is older than 15 minutes: deposits wait for a fresh report".into()
            );
        }
        let storage = if self.token.accounts.contains_key(account) { 0 } else { self.storage_cost() };
        let net = gross.saturating_sub(storage);
        if net == 0 {
            return Err("deposit does not cover the share registration".into());
        }
        let staked = nav::linear_to_near(self.staked_linear, self.linear_rate_e24, Rounding::Up);
        let used = staked.saturating_add(self.pending_deposit_near);
        if used.saturating_add(net) > self.deposit_cap {
            return Err(format!(
                "deposit cap reached: at most {} more yoctoNEAR",
                self.deposit_cap.saturating_sub(used)
            ));
        }
        Ok((net, storage))
    }

    /// Checks, registers the depositor (paid from the deposit), counts the NEAR as pending and
    /// starts pricing.
    fn start_deposit(&mut self, account: &AccountId, gross: u128, source: &str) -> Result<Promise, String> {
        let (net, storage) = self.check_deposit(account, gross)?;
        if storage > 0 {
            self.token.internal_register_account(account);
        }
        self.pending_deposit_near += net;
        Event::DepositStarted { account, amount: U128(net), storage: U128(storage), source }.emit();
        let zero = NearToken::from_yoctonear(0);
        let me = env::current_account_id();
        Ok(Promise::new(self.oracle.clone())
            .function_call(
                "get_price_no_older_than",
                parry_common::wire::price_no_older_than(NEAR_USD, ORACLE_MAX_AGE_SECS),
                zero,
                GAS_VIEW,
            )
            .and(Promise::new(self.linear.clone()).function_call(
                "ft_price",
                wire::NO_ARGS.to_vec(),
                zero,
                GAS_VIEW,
            ))
            .then(Self::ext(me).with_static_gas(GAS_ON_PRICED).on_deposit_priced(account.clone(), U128(net))))
    }

    /// Reads the joint pricing result and computes the shares. Results: 0 is the oracle's
    /// `Option<PythPrice>`, 1 is LiNEAR's `ft_price`.
    fn price_deposit(&mut self, amount: u128) -> Result<Priced, &'static str> {
        let now = now_secs();
        let price = parse_result::<Option<PythPrice>>(0).flatten();
        let Some(price) = price.filter(|p| p.is_fresh(now, ORACLE_MAX_AGE_SECS)) else {
            return Err("no fresh oracle price");
        };
        let Some(price_e8) = usable_price_e8(&price) else { return Err("oracle price is not usable") };
        let Some(rate) = parse_result::<U128>(1).map(|r| r.0).filter(|r| *r > 0) else {
            return Err("LiNEAR rate unavailable");
        };
        if self.paused() {
            return Err("deposits were paused while the deposit was priced");
        }
        let Some(mark) = self.fresh_report(now).map(|r| r.hedge.mark_e8.0) else {
            return Err("the vault report went stale while the deposit was priced");
        };
        if deviation_bps(price_e8, mark, mark) > ORACLE_MAX_DEVIATION_BPS {
            return Err("oracle price is more than 2% away from the hedge mark");
        }
        self.observe_rate(rate);
        self.near_price_e8 = price_e8;

        // NAV rounded up and value rounded down: the depositor never gets a sliver of value
        // that belongs to the existing holders.
        let nav = nav::nav_e6(self.staked_linear, rate, price_e8, self.hedge_equity_e6(), Rounding::Up);
        let value = nav::near_to_usd_e6(amount, price_e8, Rounding::Down);
        let supply = self.token.total_supply;
        if supply > 0 && nav == 0 {
            return Err("the vault has no net asset value: deposits wait for the hedge to recover");
        }
        let Some(shares) = nav::shares_for(value, supply, nav) else {
            return Err("deposit too large to price against the current NAV");
        };
        if shares == 0 {
            return Err("deposit too small to mint a share unit");
        }
        Ok(Priced { shares, rate_e24: rate, price_e8 })
    }

    /// Sends `amount` NEAR back to `account` and says why.
    pub(crate) fn refund_near(&self, account: &AccountId, amount: u128, reason: &str) {
        Event::DepositRefunded { account, amount: U128(amount), reason }.emit();
        if amount > 0 {
            Promise::new(account.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }
}
