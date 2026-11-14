//! Reading the runtime state that code before the Hyperliquid and EVM daily caps wrote.
//!
//! That layout had no caps in the guards and no counters for them. A mandate set then keeps its
//! per-action caps, and gets the tightest caps that never refuse what it already allowed once a
//! day: one full order (and, with the hedge power, one full hedge) and one full repay per day,
//! three full repays in all. The owner widens them by setting the mandate again.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, AccountId};
use parry_common::mandate::{EvmGuard, HlGuard, Mandate, Power, TokenLimit};

use crate::{Pending, Runtime};

#[near(serializers = [borsh])]
pub(crate) struct HlGuardV1 {
    pub asset: String,
    pub asset_index: u32,
    pub max_size_e8: U128,
    pub band_bps: u32,
    pub hedge_is_buy: bool,
}

#[near(serializers = [borsh])]
pub(crate) struct EvmGuardV1 {
    pub chain_id: u64,
    pub pool: String,
    pub asset: String,
    pub address: String,
    pub max_amount: U128,
}

#[near(serializers = [borsh])]
pub(crate) struct MandateV1 {
    pub guardian_key: String,
    pub powers: Vec<Power>,
    pub limits: Vec<TokenLimit>,
    pub max_actions_per_day: u32,
    pub min_health_after_bps: u32,
    pub max_slippage_bps: u32,
    pub hl: Option<HlGuardV1>,
    pub evm: Option<EvmGuardV1>,
    pub sealed: Option<Base64VecU8>,
    pub expires_at: u64,
}

#[near(serializers = [borsh])]
pub(crate) struct RuntimeV1 {
    pub owner_nonce: u64,
    pub bootstrapped: bool,
    pub mandate: Option<MandateV1>,
    pub mandate_set_at: u64,
    pub guardian_nonce: u64,
    pub paused_until: u64,
    pub spent: Vec<(AccountId, u128)>,
    pub day: u64,
    pub moved_today: Vec<(AccountId, u128)>,
    pub actions_today: u32,
    pub pending: Option<Pending>,
    pub deleverages: u64,
    pub guardian_actions: u64,
}

impl From<MandateV1> for Mandate {
    fn from(m: MandateV1) -> Self {
        let hedge = m.powers.contains(&Power::HlHedge);
        Mandate {
            hl: m.hl.map(|g| HlGuard {
                daily_size_e8: g.max_size_e8,
                max_hedge_e8: if hedge { g.max_size_e8 } else { U128(0) },
                asset: g.asset,
                asset_index: g.asset_index,
                max_size_e8: g.max_size_e8,
                band_bps: g.band_bps,
                hedge_is_buy: g.hedge_is_buy,
            }),
            evm: m.evm.map(|g| EvmGuard {
                daily_amount: g.max_amount,
                total_amount: U128(g.max_amount.0.saturating_mul(3)),
                chain_id: g.chain_id,
                pool: g.pool,
                asset: g.asset,
                address: g.address,
                max_amount: g.max_amount,
            }),
            guardian_key: m.guardian_key,
            powers: m.powers,
            limits: m.limits,
            max_actions_per_day: m.max_actions_per_day,
            min_health_after_bps: m.min_health_after_bps,
            max_slippage_bps: m.max_slippage_bps,
            sealed: m.sealed,
            expires_at: m.expires_at,
        }
    }
}

/// The runtime stored by code before the daily caps, in today's layout. Guardian Hyperliquid and
/// EVM actions taken under it were not counted, so the new counters start at zero.
pub(crate) fn runtime_from_v1(bytes: &[u8]) -> Runtime {
    let old: RuntimeV1 =
        near_sdk::borsh::from_slice(bytes).unwrap_or_else(|_| env::panic_str("bad runtime state"));
    Runtime {
        owner_nonce: old.owner_nonce,
        bootstrapped: old.bootstrapped,
        mandate: old.mandate.map(Mandate::from),
        mandate_set_at: old.mandate_set_at,
        guardian_nonce: old.guardian_nonce,
        paused_until: old.paused_until,
        spent: old.spent,
        day: old.day,
        moved_today: old.moved_today,
        actions_today: old.actions_today,
        pending: old.pending,
        deleverages: old.deleverages,
        guardian_actions: old.guardian_actions,
        hl_size_today: 0,
        hl_hedged: 0,
        evm_repaid_today: 0,
        evm_repaid: 0,
    }
}
