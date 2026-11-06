//! Rebalancing the short: `rebalance` (anyone) → LiNEAR `ft_price` → `on_rebalance_rate` →
//! Chain Signatures `sign` → `on_hedge_signed` → `{ r, s, v }`.
//!
//! The vault builds the order itself from the latest report and its own state, so the caller
//! chooses nothing: not the side, not the size, not the price. The signature is only usable for
//! that exact order and nonce, and one order is signed per report, so calling `rebalance` again
//! before the next report cannot stack orders.

use near_sdk::json_types::{I128, U128};
use near_sdk::{env, near, require, serde_json, Gas, GasWeight, NearToken, Promise, PromiseOrValue};
use parry_common::hyperliquid::{order_digest, HlOrder};
use parry_common::{now_secs, promise_bytes, wire as common_wire, ONE_YOCTO};

use crate::deposit::parse_result;
use crate::order::{leverage_cap_e8, order_for, target_short_e8};
use crate::report::StoredReport;
use crate::{wire, Event, Vault, VaultExt, GAS_VIEW, HEDGE_PATH};

/// Chain Signatures `sign` (it also gets the unused gas).
const GAS_SIGN: Gas = Gas::from_tgas(60);
const GAS_ON_SIGNED: Gas = Gas::from_tgas(10);
/// Own work, the sign call and its callback.
const GAS_ON_RATE: Gas = Gas::from_tgas(15 + 60 + 10);
/// Least prepaid gas for `rebalance`.
pub const GAS_REBALANCE: Gas = Gas::from_tgas(10 + 10 + 85);

/// A signature from Chain Signatures, in the `{ r, s, v }` form Hyperliquid takes.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgeSignature {
    pub r: String,
    pub s: String,
    pub v: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Scalar {
    pub scalar: String,
}

/// The MPC contract's answer for a secp256k1 request.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignatureResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

/// `{ r, s, v }` from the MPC response: r is the x coordinate of R (its compressed point minus
/// the prefix byte), v is the recovery id + 27.
pub fn to_hedge_signature(r: SignatureResponse) -> Option<HedgeSignature> {
    if r.scheme != "Secp256k1" || r.big_r.affine_point.len() != 66 || r.recovery_id > 1 {
        return None;
    }
    let x = r.big_r.affine_point.get(2..)?.to_string();
    Some(HedgeSignature { r: x, s: r.s.scalar, v: r.recovery_id + 27 })
}

/// What the hedge should be and the order that gets it there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgePlan {
    /// Target short (NEAR, 1e8), after the leverage cap.
    pub target_e8: u128,
    /// Short the report observed (NEAR, 1e8); negative would be a long.
    pub current_e8: i128,
    pub order: Option<HlOrder>,
}

#[near]
impl Vault {
    /// Signs the order that brings the short back to target, if it is out of band. Anyone may
    /// call it (the keeper usually does); the result is the signature, or null when the hedge is
    /// in band. Needs a fresh report, and at most one order is signed per report.
    pub fn rebalance(&mut self) -> Promise {
        require!(env::prepaid_gas() >= GAS_REBALANCE, "attach at least 105 TGas to rebalance");
        require!(
            self.fresh_report(now_secs()).is_some(),
            "the latest vault report is older than 15 minutes: rebalance waits for a fresh report"
        );
        require!(
            !self.hedge_order_signed,
            "a hedge order was already signed for this report: wait for the next report"
        );
        Promise::new(self.linear.clone())
            .function_call("ft_price", wire::NO_ARGS.to_vec(), NearToken::from_yoctonear(0), GAS_VIEW)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RATE)
                    .with_unused_gas_weight(1)
                    .on_rebalance_rate(),
            )
    }

    /// Sizes the hedge with the LiNEAR rate just read and signs the order if one is due.
    #[private]
    pub fn on_rebalance_rate(&mut self) -> PromiseOrValue<Option<HedgeSignature>> {
        let Some(rate) = parse_result::<U128>(0).map(|r| r.0).filter(|r| *r > 0) else {
            Event::HedgeSkipped { reason: "LiNEAR rate unavailable" }.emit();
            return PromiseOrValue::Value(None);
        };
        self.observe_rate(rate);
        let now = now_secs();
        let Some(report) = self.fresh_report(now).cloned() else {
            Event::HedgeSkipped { reason: "the vault report went stale" }.emit();
            return PromiseOrValue::Value(None);
        };
        if self.hedge_order_signed {
            Event::HedgeSkipped { reason: "a hedge order was already signed for this report" }.emit();
            return PromiseOrValue::Value(None);
        }
        let plan = self.hedge_plan(rate, &report);
        let Some(order) = plan.order else {
            Event::HedgeInBand { target_e8: U128(plan.target_e8), current_e8: I128(plan.current_e8) }.emit();
            return PromiseOrValue::Value(None);
        };
        let nonce = (env::block_timestamp_ms()).max(self.last_hedge_nonce + 1);
        self.last_hedge_nonce = nonce;
        self.hedge_order_signed = true;
        let digest = hex::encode(order_digest(&order, nonce, self.network == "mainnet"));
        Event::HedgeOrder {
            nonce,
            order: &order,
            digest: &digest,
            target_e8: U128(plan.target_e8),
            current_e8: I128(plan.current_e8),
        }
        .emit();
        PromiseOrValue::Promise(
            Promise::new(self.signer.clone())
                .function_call_weight(
                    "sign",
                    common_wire::mpc_sign(HEDGE_PATH, &digest),
                    ONE_YOCTO,
                    GAS_SIGN,
                    GasWeight(1),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_SIGNED)
                        .on_hedge_signed(report.run_id, nonce),
                ),
        )
    }

    /// The signature for the order emitted in `hedge_order`. When signing failed, the report may
    /// be used for one more attempt, since no order exists.
    #[private]
    pub fn on_hedge_signed(&mut self, run_id: u64, nonce: u64) -> Option<HedgeSignature> {
        let signature = promise_bytes(0)
            .and_then(|b| serde_json::from_slice::<SignatureResponse>(&b).ok())
            .and_then(to_hedge_signature);
        if signature.is_none() {
            if self.report.as_ref().is_some_and(|r| r.run_id == run_id) {
                self.hedge_order_signed = false;
            }
            Event::HedgeSignFailed { nonce }.emit();
        }
        signature
    }
}

impl Vault {
    /// The target short for `rate` and the latest report, and the order to reach it.
    pub(crate) fn hedge_plan(&self, rate_e24: u128, report: &StoredReport) -> HedgePlan {
        let h = &report.hedge;
        let raw = target_short_e8(
            self.staked_linear,
            rate_e24,
            self.active_shares(),
            self.token.total_supply,
            self.hedge.hedge_ratio_bps,
        );
        let cap = leverage_cap_e8(h.account_value_e6.0, self.effective_max_leverage_x100(), h.mark_e8.0);
        let target_e8 = raw.min(cap);
        let current_e8 = h.size_e8.0.saturating_neg();
        let order = order_for(&self.hedge, target_e8, current_e8, h.mark_e8.0);
        HedgePlan { target_e8, current_e8, order }
    }
}
