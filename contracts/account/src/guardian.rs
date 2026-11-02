//! The guardian: one enclave-signed protective action at a time, inside the owner's mandate.
//!
//! Synchronous checks (signature, nonce, time window, review hash, power, caps) panic, so a
//! refused envelope leaves no trace but a failed transaction. Checks that need a fresh mark (the
//! Hyperliquid band, the deleverage slippage bound) run in a callback and log a
//! `guardian_refused` event instead, because the envelope's nonce and counters are committed by
//! then.
//!
//! Deleverage is a promise chain on the lending contract and the exchange:
//! marks → `simple_withdraw` (resolves true once the collateral reached this account) →
//! deposit into the exchange → `swap` (resolves to the amount out) → exchange `withdraw` of the
//! debt token (resolves to the amount, 0 on failure) → repay → read the position and prices →
//! health check. Every failure before the repay puts the collateral back where it was.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json;
use near_sdk::{env, near, require, serde, AccountId, Gas, GasWeight, Promise, PromiseOrValue};
use parry_common::evm::{approve_calldata, eip1559_unsigned, parse_address, repay_calldata, signing_hash};
use parry_common::hyperliquid::{order_digest, parse_e8, HlOrder};
use parry_common::mandate::{
    envelope_digest, is_review_hash, GuardianEnvelope, Mandate, ENVELOPE_SKEW_SECS, ENVELOPE_TTL_SECS,
};
use parry_common::math::{apply_bps, deviation_bps, mul_div, pow10, Rounding, BPS};
use parry_common::protocol::{PATH_EVM, PATH_HYPERLIQUID};
use parry_common::pyth::PythPrice;
use parry_common::rhea::{self, AccountLines, PricedAsset};
use parry_common::{day_of, now_secs, promise_bytes, wire, ONE_YOCTO};

use crate::{
    ft_transfer_call, load_runtime, save_runtime, Account, AccountExt, Action, Event, Pending, Runtime,
};

const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(30);
const GAS_DEX: Gas = Gas::from_tgas(40);
const GAS_WITHDRAW: Gas = Gas::from_tgas(130);
/// A mark older than this cannot price a guard.
pub const MARK_MAX_AGE_SECS: u64 = 300;
/// Oracle prices for the final health check.
const PRICE_MAX_AGE_SECS: u64 = 180;
/// A deleverage that leaves health under the floor pauses the guardian this long.
const UNSAFE_PAUSE_SECS: u64 = 86_400;

/// A mark as the risk board returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Mark {
    pub asset: String,
    pub asset_index: u32,
    pub price_e8: U128,
    pub at: u64,
}

#[near(event_json(standard = "parry-account"))]
pub enum GuardEvent<'a> {
    #[event_version("1.0.0")]
    GuardianRefused { nonce: u64, action: &'a str, reason: &'a str },
}

fn refuse(nonce: u64, action: &str, reason: &str) {
    GuardEvent::GuardianRefused { nonce, action, reason }.emit();
}

fn roll_day(rt: &mut Runtime, now: u64) {
    let today = day_of(now);
    if rt.day != today {
        rt.day = today;
        rt.moved_today.clear();
        rt.actions_today = 0;
    }
}

fn add_to(list: &mut Vec<(AccountId, u128)>, token: &AccountId, amount: u128) -> u128 {
    if let Some(e) = list.iter_mut().find(|(t, _)| t == token) {
        e.1 += amount;
        e.1
    } else {
        list.push((token.clone(), amount));
        amount
    }
}

fn sub_from(list: &mut [(AccountId, u128)], token: &AccountId, amount: u128) {
    if let Some(e) = list.iter_mut().find(|(t, _)| t == token) {
        e.1 = e.1.saturating_sub(amount);
    }
}

/// Counts `amount` of `token` against the daily cap (and the reserve when `from_reserve`).
fn charge(rt: &mut Runtime, m: &Mandate, token: &AccountId, amount: u128, from_reserve: bool) {
    require!(amount > 0, "amount must be positive");
    let limit = m.limit(token).unwrap_or_else(|| env::panic_str("the mandate sets no limit for this token"));
    require!(add_to(&mut rt.moved_today, token, amount) <= limit.daily.0, "daily cap reached for this token");
    if from_reserve {
        require!(
            add_to(&mut rt.spent, token, amount) <= limit.reserve.0,
            "rescue reserve exhausted for this token"
        );
    }
}

fn decode_ed25519(key: &str) -> [u8; 32] {
    let pk: near_sdk::PublicKey = key.parse().unwrap_or_else(|_| env::panic_str("bad guardian key"));
    pk.as_bytes()[1..].try_into().unwrap_or_else(|_| env::panic_str("bad guardian key"))
}

fn parse_result<T: serde::de::DeserializeOwned>(index: u64) -> Option<T> {
    promise_bytes(index).and_then(|b| serde_json::from_slice(&b).ok())
}

#[near]
impl Account {
    /// Runs one enclave-signed protective action. Anyone may relay the envelope; the enclave's
    /// signature, the nonce, the time window and the mandate are the guards.
    pub fn guardian_execute(&mut self, envelope: String, signature: Base64VecU8) -> Promise {
        let now = now_secs();
        let mut rt = load_runtime();
        let m = rt.mandate.clone().unwrap_or_else(|| env::panic_str("no mandate"));
        require!(m.expires_at > now, "mandate expired");
        require!(rt.paused_until <= now, "guardian paused by the owner");
        require!(rt.pending.is_none(), "a deleverage is in flight");

        let sig: [u8; 64] =
            signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("bad signature length"));
        require!(
            env::ed25519_verify(&sig, envelope_digest(&envelope), &decode_ed25519(&m.guardian_key)),
            "guardian signature does not verify"
        );
        let e: GuardianEnvelope =
            serde_json::from_slice(envelope.as_bytes()).unwrap_or_else(|_| env::panic_str("bad envelope"));
        require!(e.account == env::current_account_id(), "envelope is for another account");
        require!(e.network == self.core.network, "envelope is for another network");
        require!(e.nonce > rt.guardian_nonce, "envelope nonce already used");
        require!(
            e.issued_at + ENVELOPE_TTL_SECS >= now && e.issued_at <= now + ENVELOPE_SKEW_SECS,
            "envelope expired"
        );
        require!(is_review_hash(&e.review_hash), "every guardian action needs an AI review hash");
        require!(m.allows(e.action.power()), "the mandate does not grant this power");

        roll_day(&mut rt, now);
        require!(rt.actions_today < m.max_actions_per_day, "daily action limit reached");
        rt.actions_today += 1;
        rt.guardian_nonce = e.nonce;
        rt.guardian_actions += 1;

        let p = self.core.protocol.clone();
        let name = e.action.name();
        let (token, amount) = match &e.action {
            Action::Repay { token, amount } | Action::AddCollateral { token, amount } => {
                require!(p.token(token).is_some(), "token not in the protocol");
                charge(&mut rt, &m, token, amount.0, true);
                (Some(token.clone()), Some(*amount))
            }
            Action::Deleverage { collateral, amount, debt, min_out, .. } => {
                require!(
                    p.token(collateral).is_some() && p.token(debt).is_some(),
                    "token not in the protocol"
                );
                require!(collateral != debt, "collateral and debt must differ");
                require!(min_out.0 > 0, "a deleverage needs a minimum output");
                charge(&mut rt, &m, collateral, amount.0, false);
                (Some(collateral.clone()), Some(*amount))
            }
            Action::HlReduce { order, .. } | Action::HlHedge { order, .. } => {
                let g = m.hl.as_ref().unwrap_or_else(|| env::panic_str("no Hyperliquid guard"));
                require!(order.asset_index == g.asset_index, "order is for another asset");
                let size = parse_e8(&order.size).unwrap_or_else(|| env::panic_str("bad order size"));
                require!(size <= g.max_size_e8.0, "order larger than the guard's size cap");
                match &e.action {
                    Action::HlReduce { .. } => {
                        require!(order.reduce_only, "a reduce order must be reduce-only")
                    }
                    _ => require!(order.is_buy == g.hedge_is_buy, "a hedge must take the guard's side"),
                }
                (None, Some(U128(size)))
            }
            Action::EvmApprove { amount, .. } | Action::EvmRepay { amount, .. } => {
                let g = m.evm.as_ref().unwrap_or_else(|| env::panic_str("no EVM guard"));
                require!(amount.0 > 0 && amount.0 <= g.max_amount.0, "amount outside the EVM guard");
                (None, Some(*amount))
            }
        };
        Event::GuardianActed {
            nonce: e.nonce,
            action: name,
            review_hash: &e.review_hash,
            trigger: &e.trigger,
            token: token.as_ref(),
            amount,
        }
        .emit();

        let me = env::current_account_id();
        let promise = match e.action {
            Action::Repay { token, amount } => {
                ft_transfer_call(&token, &p.lending, amount.0, rhea::MSG_ONLY_REPAY).then(
                    Self::ext(me).with_static_gas(GAS_CALLBACK).on_guardian_settled(
                        e.nonce,
                        "repay".into(),
                        token,
                        amount,
                    ),
                )
            }
            Action::AddCollateral { token, amount } => {
                ft_transfer_call(&token, &p.lending, amount.0, rhea::MSG_ONLY_INCREASE_COLLATERAL).then(
                    Self::ext(me).with_static_gas(GAS_CALLBACK).on_guardian_settled(
                        e.nonce,
                        "add_collateral".into(),
                        token,
                        amount,
                    ),
                )
            }
            Action::Deleverage { collateral, amount, pool_id, debt, min_out } => {
                rt.deleverages += 1;
                let id = rt.deleverages;
                rt.pending = Some(Pending {
                    id,
                    guardian_nonce: e.nonce,
                    collateral,
                    amount,
                    pool_id,
                    debt,
                    min_out,
                    out: U128(0),
                    stage: "pricing".into(),
                    started_at: now,
                });
                Event::DeleverageStage { id, stage: "pricing" }.emit();
                Promise::new(p.risk.clone())
                    .function_call("marks", b"{}".to_vec(), near_sdk::NearToken::from_yoctonear(0), GAS_VIEW)
                    .then(
                        Self::ext(me)
                            .with_static_gas(GAS_CALLBACK)
                            .with_unused_gas_weight(1)
                            .on_delev_marks(id),
                    )
            }
            Action::HlReduce { order, nonce } => self.hl_mark_then_sign(e.nonce, "reduce", order, nonce),
            Action::HlHedge { order, nonce } => self.hl_mark_then_sign(e.nonce, "hedge", order, nonce),
            Action::EvmApprove { params, amount } => {
                let g = m.evm.as_ref().unwrap_or_else(|| env::panic_str("no EVM guard"));
                let (pool, asset) = (parse_address(&g.pool).unwrap(), parse_address(&g.asset).unwrap());
                let tx = eip1559_unsigned(g.chain_id, &params, &asset, 0, &approve_calldata(&pool, amount.0));
                self.evm_sign(e.nonce, "approve", tx)
            }
            Action::EvmRepay { params, amount } => {
                let g = m.evm.as_ref().unwrap_or_else(|| env::panic_str("no EVM guard"));
                let pool = parse_address(&g.pool).unwrap();
                let asset = parse_address(&g.asset).unwrap();
                let me_evm = parse_address(&g.address).unwrap();
                let tx = eip1559_unsigned(
                    g.chain_id,
                    &params,
                    &pool,
                    0,
                    &repay_calldata(&asset, amount.0, &me_evm),
                );
                self.evm_sign(e.nonce, "repay", tx)
            }
        };
        save_runtime(&rt);
        promise
    }

    /// Settles a repay or collateral top-up: what the lending contract did not use came back to
    /// this account, so it no longer counts against the caps.
    #[private]
    pub fn on_guardian_settled(
        &mut self,
        nonce: u64,
        action: String,
        token: AccountId,
        amount: U128,
    ) -> U128 {
        let used: u128 = parse_result::<U128>(0).map(|u| u.0).unwrap_or(0).min(amount.0);
        let returned = amount.0 - used;
        if returned > 0 {
            let mut rt = load_runtime();
            sub_from(&mut rt.moved_today, &token, returned);
            sub_from(&mut rt.spent, &token, returned);
            save_runtime(&rt);
        }
        Event::GuardianSettled { nonce, action: &action, used: U128(used), returned: U128(returned) }.emit();
        U128(used)
    }

    // -----------------------------------------------------------------------------------------
    // Hyperliquid
    // -----------------------------------------------------------------------------------------

    fn hl_mark_then_sign(&self, nonce: u64, kind: &str, order: HlOrder, hl_nonce: u64) -> Promise {
        let rt = load_runtime();
        let g = rt.mandate.and_then(|m| m.hl).unwrap_or_else(|| env::panic_str("no Hyperliquid guard"));
        Promise::new(self.core.protocol.risk.clone())
            .function_call("mark_of", wire::asset(&g.asset), near_sdk::NearToken::from_yoctonear(0), GAS_VIEW)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(1)
                    .on_hl_mark(nonce, kind.to_string(), order, hl_nonce),
            )
    }

    /// Checks the order against a fresh mark for the very asset index it signs, then asks Chain
    /// Signatures to sign the agent digest built here.
    #[private]
    pub fn on_hl_mark(
        &mut self,
        nonce: u64,
        kind: String,
        order: HlOrder,
        hl_nonce: u64,
    ) -> PromiseOrValue<Option<crate::EvmSignature>> {
        let action = if kind == "reduce" { "hl_reduce" } else { "hl_hedge" };
        let rt = load_runtime();
        let Some(g) = rt.mandate.and_then(|m| m.hl) else {
            refuse(nonce, action, "mandate revoked");
            return PromiseOrValue::Value(None);
        };
        let Some(mark) = parse_result::<Option<Mark>>(0).flatten() else {
            refuse(nonce, action, "no mark for the guarded asset");
            return PromiseOrValue::Value(None);
        };
        if mark.asset_index != order.asset_index || now_secs().saturating_sub(mark.at) > MARK_MAX_AGE_SECS {
            refuse(nonce, action, "mark is stale or for another asset index");
            return PromiseOrValue::Value(None);
        }
        let price = parse_e8(&order.price).unwrap_or(0);
        if price == 0 || deviation_bps(price, mark.price_e8.0, mark.price_e8.0) > g.band_bps as u128 {
            refuse(nonce, action, "order price outside the band around the mark");
            return PromiseOrValue::Value(None);
        }
        let digest = hex::encode(order_digest(&order, hl_nonce, self.core.network == "mainnet"));
        Event::HyperliquidSigned { nonce, kind: &kind, digest: digest.clone() }.emit();
        PromiseOrValue::Promise(self.mpc_sign(PATH_HYPERLIQUID, &digest).then(
            Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_guardian_signed(),
        ))
    }

    #[private]
    pub fn on_guardian_signed(
        #[callback_result] r: Result<crate::SignatureResponse, near_sdk::PromiseError>,
    ) -> Option<crate::EvmSignature> {
        Some(crate::to_evm_signature(r))
    }

    fn evm_sign(&self, nonce: u64, kind: &str, unsigned: Vec<u8>) -> Promise {
        let hash = hex::encode(signing_hash(&unsigned));
        Event::EvmSigned { nonce, kind, hash: hash.clone(), unsigned_tx: hex::encode(&unsigned) }.emit();
        self.mpc_sign(PATH_EVM, &hash).then(
            Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_guardian_signed(),
        )
    }

    // -----------------------------------------------------------------------------------------
    // Deleverage
    // -----------------------------------------------------------------------------------------

    /// Prices the swap with the enclave's marks: `min_out` must be within the mandate's slippage
    /// of the marked value, so a signed envelope cannot sell collateral cheaply.
    #[private]
    pub fn on_delev_marks(&mut self, id: u64) -> PromiseOrValue<bool> {
        let (mut rt, pd) = match self.pending_for(id) {
            Some(x) => x,
            None => return PromiseOrValue::Value(false),
        };
        let m = rt.mandate.clone();
        let marks: Vec<Mark> = parse_result(0).unwrap_or_default();
        let p = &self.core.protocol;
        let price_of = |token: &AccountId| -> Option<u128> {
            match &p.token(token)?.mark {
                None => Some(100_000_000),
                Some(asset) => marks
                    .iter()
                    .find(|mk| &mk.asset == asset && now_secs().saturating_sub(mk.at) <= MARK_MAX_AGE_SECS)
                    .map(|mk| mk.price_e8.0),
            }
        };
        let (Some(pc), Some(pd_price), Some(m)) = (price_of(&pd.collateral), price_of(&pd.debt), m) else {
            return self.abort_delev(&mut rt, pd, "pricing", Some("no fresh mark for the swap"));
        };
        let (dc, dd) = (p.token(&pd.collateral).unwrap().decimals, p.token(&pd.debt).unwrap().decimals);
        // expected = amount × pc / pd, converted from collateral decimals to debt decimals.
        let value = mul_div(pd.amount.0, pc, pd_price, Rounding::Down);
        let expected =
            if dd >= dc { value * pow10((dd - dc) as u32) } else { value / pow10((dc - dd) as u32) };
        let floor = apply_bps(expected, BPS - m.max_slippage_bps as u128, Rounding::Up);
        if pd.min_out.0 < floor {
            return self.abort_delev(&mut rt, pd, "pricing", Some("minimum output below the slippage bound"));
        }
        let inner = pd.amount.0 * pow10(p.token(&pd.collateral).unwrap().extra_decimals as u32);
        self.set_stage(&mut rt, "withdraw");
        PromiseOrValue::Promise(
            Promise::new(p.lending.clone())
                .function_call(
                    "simple_withdraw",
                    rhea::simple_withdraw_args(&pd.collateral, inner),
                    ONE_YOCTO,
                    GAS_WITHDRAW,
                )
                .then(self.cb().on_delev_withdrawn(id)),
        )
    }

    #[private]
    pub fn on_delev_withdrawn(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some((mut rt, pd)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<bool>(0) != Some(true) {
            // If the token transfer failed after the collateral was decreased, the lending
            // contract kept the tokens as supply: move exactly that amount back to collateral.
            let p = &self.core.protocol;
            let inner = pd.amount.0 * pow10(p.token(&pd.collateral).unwrap().extra_decimals as u32);
            Promise::new(p.lending.clone())
                .function_call(
                    "execute",
                    rhea::increase_collateral_args(&pd.collateral, Some(inner)),
                    ONE_YOCTO,
                    GAS_WITHDRAW,
                )
                .detach();
            return self.abort_delev(&mut rt, pd, "withdraw", Some("collateral could not be withdrawn"));
        }
        self.set_stage(&mut rt, "deposit");
        PromiseOrValue::Promise(
            ft_transfer_call(&pd.collateral, &self.core.protocol.dex, pd.amount.0, "")
                .then(self.cb().on_delev_deposited(id)),
        )
    }

    #[private]
    pub fn on_delev_deposited(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some((mut rt, pd)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        let used = parse_result::<U128>(0).map(|u| u.0).unwrap_or(0);
        if used != pd.amount.0 {
            // What the exchange did not take came back here; take the rest out and re-supply all.
            return self.restore(&mut rt, pd, used, "deposit");
        }
        self.set_stage(&mut rt, "swap");
        let p = &self.core.protocol;
        PromiseOrValue::Promise(
            Promise::new(p.dex.clone())
                .function_call(
                    "swap",
                    wire::dex_swap(pd.pool_id, &pd.collateral, pd.amount.0, &pd.debt, pd.min_out.0),
                    ONE_YOCTO,
                    GAS_DEX,
                )
                .then(self.cb().on_delev_swapped(id)),
        )
    }

    #[private]
    pub fn on_delev_swapped(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some((mut rt, mut pd)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        let Some(out) = parse_result::<U128>(0).filter(|o| o.0 >= pd.min_out.0) else {
            let amount = pd.amount.0;
            return self.restore(&mut rt, pd, amount, "swap");
        };
        pd.out = out;
        rt.pending = Some(pd.clone());
        self.set_stage(&mut rt, "withdraw_out");
        PromiseOrValue::Promise(self.dex_withdraw(&pd.debt, out.0).then(self.cb().on_delev_out(id)))
    }

    #[private]
    pub fn on_delev_out(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some((mut rt, pd)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<U128>(0).map(|u| u.0) != Some(pd.out.0) {
            // The debt tokens are still the account's, as an exchange deposit; anyone can retry.
            self.set_stage(&mut rt, "stuck_withdraw_out");
            Event::DeleverageStuck { id, stage: "withdraw_out" }.emit();
            return PromiseOrValue::Value(false);
        }
        self.set_stage(&mut rt, "repay");
        PromiseOrValue::Promise(
            ft_transfer_call(&pd.debt, &self.core.protocol.lending, pd.out.0, rhea::MSG_ONLY_REPAY)
                .then(self.cb().on_delev_repaid(id)),
        )
    }

    #[private]
    pub fn on_delev_repaid(&mut self, id: u64) -> PromiseOrValue<bool> {
        let Some((mut rt, _)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        let repaid = parse_result::<U128>(0).map(|u| u.0).unwrap_or(0);
        self.set_stage(&mut rt, "verify");
        PromiseOrValue::Promise(
            Promise::new(self.core.protocol.lending.clone())
                .function_call(
                    "get_account",
                    wire::account_id(&env::current_account_id()),
                    near_sdk::NearToken::from_yoctonear(0),
                    GAS_VIEW,
                )
                .then(self.cb().on_delev_position(id, U128(repaid))),
        )
    }

    /// Reads the prices and asset configs health needs, for every asset of the position.
    #[private]
    pub fn on_delev_position(&mut self, id: u64, repaid: U128) -> PromiseOrValue<bool> {
        let Some((mut rt, pd)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        let raw = promise_bytes(0).unwrap_or_default();
        let Some(lines) = AccountLines::parse(&raw) else {
            return self.finish_delev(&mut rt, pd, repaid.0, None);
        };
        let p = &self.core.protocol;
        let mut tokens: Vec<AccountId> = vec![];
        for l in lines.collateral.iter().chain(lines.borrowed.iter()) {
            if p.token(&l.token_id).is_some() && !tokens.contains(&l.token_id) {
                tokens.push(l.token_id.clone());
            }
        }
        if tokens.is_empty() {
            return self.finish_delev(&mut rt, pd, repaid.0, None);
        }
        let zero = near_sdk::NearToken::from_yoctonear(0);
        let mut joint: Option<Promise> = None;
        for t in &tokens {
            let cfg = p.token(t).unwrap();
            let mut calls = vec![
                Promise::new(p.oracle.clone()).function_call(
                    "get_price_no_older_than",
                    wire::price_no_older_than(&cfg.price_id, PRICE_MAX_AGE_SECS),
                    zero,
                    GAS_VIEW,
                ),
                Promise::new(p.lending.clone()).function_call("get_asset", wire::token_id(t), zero, GAS_VIEW),
            ];
            if let Some(rate) = &cfg.rate_call {
                calls.push(Promise::new(t.clone()).function_call(
                    rate.clone(),
                    b"{}".to_vec(),
                    zero,
                    GAS_VIEW,
                ));
            }
            for c in calls {
                joint = Some(match joint {
                    None => c,
                    Some(j) => j.and(c),
                });
            }
        }
        let lines_json = String::from_utf8(raw).unwrap_or_default();
        PromiseOrValue::Promise(
            joint.unwrap().then(self.cb().on_delev_health(id, repaid, lines_json, tokens)),
        )
    }

    #[private]
    pub fn on_delev_health(
        &mut self,
        id: u64,
        repaid: U128,
        lines_json: String,
        tokens: Vec<AccountId>,
    ) -> bool {
        let Some((mut rt, pd)) = self.pending_for(id) else { return false };
        let lines = AccountLines::parse(lines_json.as_bytes()).unwrap_or_default();
        let p = self.core.protocol.clone();
        let mut assets = vec![];
        let mut i = 0u64;
        for t in &tokens {
            let cfg = p.token(t).unwrap();
            let price: Option<PythPrice> = parse_result::<Option<PythPrice>>(i).flatten();
            let asset: Option<rhea::AssetView> = parse_result::<Option<rhea::AssetView>>(i + 1).flatten();
            i += 2;
            let rate = if cfg.rate_call.is_some() {
                i += 1;
                parse_result::<U128>(i - 1).map(|r| r.0)
            } else {
                None
            };
            let ratio = asset.as_ref().map(|a| a.config.volatility_ratio);
            if let (Some(price), Some(ratio)) = (price, ratio) {
                if price.price.0 > 0 && (cfg.rate_call.is_none() || rate.is_some()) {
                    assets.push(PricedAsset {
                        token_id: t.clone(),
                        inner_decimals: cfg.decimals + cfg.extra_decimals,
                        volatility_ratio_bps: ratio,
                        price,
                        rate_e24: rate,
                    });
                }
            }
        }
        let health = rhea::health_bps(&lines, &assets).ok().map(|h| h.unwrap_or(u128::MAX));
        match self.finish_delev(&mut rt, pd, repaid.0, health) {
            PromiseOrValue::Value(v) => v,
            PromiseOrValue::Promise(p) => {
                p.detach();
                true
            }
        }
    }

    /// Retries a deleverage step that got stuck after the swap (the debt tokens sit in the
    /// account's exchange deposit) or during a restore (the collateral sits there). Anyone may
    /// call it: every step only moves the account's own tokens between the exchange, the account
    /// and the lending contract.
    pub fn retry_deleverage(&mut self) -> Promise {
        let rt = load_runtime();
        let pd = rt.pending.clone().unwrap_or_else(|| env::panic_str("no deleverage in flight"));
        match pd.stage.as_str() {
            "stuck_withdraw_out" => self.dex_withdraw(&pd.debt, pd.out.0).then(self.cb().on_delev_out(pd.id)),
            "stuck_restore" => {
                let amount = pd.amount.0;
                self.dex_withdraw(&pd.collateral, amount)
                    .then(self.cb().on_restore_withdrawn(pd.id, U128(amount)))
            }
            _ => env::panic_str("the deleverage is not stuck"),
        }
    }

    #[private]
    pub fn on_restore_withdrawn(&mut self, id: u64, from_dex: U128) -> PromiseOrValue<bool> {
        let Some((mut rt, pd)) = self.pending_for(id) else { return PromiseOrValue::Value(false) };
        if parse_result::<U128>(0).map(|u| u.0) != Some(from_dex.0) {
            self.set_stage(&mut rt, "stuck_restore");
            Event::DeleverageStuck { id, stage: "restore" }.emit();
            return PromiseOrValue::Value(false);
        }
        PromiseOrValue::Promise(
            ft_transfer_call(
                &pd.collateral,
                &self.core.protocol.lending,
                pd.amount.0,
                rhea::MSG_ONLY_INCREASE_COLLATERAL,
            )
            .then(self.cb().on_restored(id)),
        )
    }

    #[private]
    pub fn on_restored(&mut self, id: u64) -> bool {
        let Some((mut rt, pd)) = self.pending_for(id) else { return false };
        let stage = pd.stage.clone();
        matches!(self.abort_delev(&mut rt, pd, &stage, None), PromiseOrValue::Value(true))
    }
}

impl Account {
    fn cb(&self) -> AccountExt {
        Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).with_unused_gas_weight(1)
    }

    fn pending_for(&self, id: u64) -> Option<(Runtime, Pending)> {
        let rt = load_runtime();
        let pd = rt.pending.clone().filter(|p| p.id == id)?;
        Some((rt, pd))
    }

    fn set_stage(&self, rt: &mut Runtime, stage: &str) {
        if let Some(p) = rt.pending.as_mut() {
            p.stage = stage.to_string();
            Event::DeleverageStage { id: p.id, stage }.emit();
        }
        save_runtime(rt);
    }

    fn dex_withdraw(&self, token: &AccountId, amount: u128) -> Promise {
        Promise::new(self.core.protocol.dex.clone()).function_call_weight(
            "withdraw",
            wire::dex_withdraw(token, amount),
            ONE_YOCTO,
            GAS_DEX,
            GasWeight(0),
        )
    }

    /// Takes `from_dex` of the collateral out of the exchange, then re-supplies the whole amount
    /// as collateral.
    fn restore(&self, rt: &mut Runtime, pd: Pending, from_dex: u128, stage: &str) -> PromiseOrValue<bool> {
        refuse(pd.guardian_nonce, "deleverage", &format!("{stage} failed: restoring the collateral"));
        self.set_stage(rt, &format!("restore_{stage}"));
        if from_dex == 0 {
            return PromiseOrValue::Promise(
                ft_transfer_call(
                    &pd.collateral,
                    &self.core.protocol.lending,
                    pd.amount.0,
                    rhea::MSG_ONLY_INCREASE_COLLATERAL,
                )
                .then(self.cb().on_restored(pd.id)),
            );
        }
        PromiseOrValue::Promise(
            self.dex_withdraw(&pd.collateral, from_dex)
                .then(self.cb().on_restore_withdrawn(pd.id, U128(from_dex))),
        )
    }

    /// Ends a deleverage that did not happen: the position is as it was, so the collateral no
    /// longer counts against the daily cap.
    fn abort_delev(
        &self,
        rt: &mut Runtime,
        pd: Pending,
        stage: &str,
        reason: Option<&str>,
    ) -> PromiseOrValue<bool> {
        if rt.day == day_of(pd.started_at) {
            sub_from(&mut rt.moved_today, &pd.collateral, pd.amount.0);
        }
        if let Some(reason) = reason {
            refuse(pd.guardian_nonce, "deleverage", reason);
        }
        Event::DeleverageRolledBack { id: pd.id, stage }.emit();
        rt.pending = None;
        save_runtime(rt);
        PromiseOrValue::Value(true)
    }

    fn finish_delev(
        &self,
        rt: &mut Runtime,
        pd: Pending,
        repaid: u128,
        health: Option<u128>,
    ) -> PromiseOrValue<bool> {
        let floor = rt.mandate.as_ref().map(|m| m.min_health_after_bps).unwrap_or(u32::MAX);
        let safe = health.is_some_and(|h| h >= floor as u128);
        let health_view = health.map(|h| U128(h.min(u64::MAX as u128)));
        if safe {
            Event::DeleverageCompleted { id: pd.id, repaid: U128(repaid), health_bps: health_view }.emit();
        } else {
            // Health could not be verified, or is still under the owner's floor: stop the
            // guardian for a day and let the owner look.
            Event::DeleverageUnsafe { id: pd.id, health_bps: health_view, floor_bps: floor }.emit();
            rt.paused_until = rt.paused_until.max(now_secs() + UNSAFE_PAUSE_SECS);
            Event::GuardianPaused { until: rt.paused_until }.emit();
        }
        rt.pending = None;
        save_runtime(rt);
        PromiseOrValue::Value(safe)
    }
}
