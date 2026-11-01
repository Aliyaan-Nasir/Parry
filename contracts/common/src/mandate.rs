//! The mandate (what a person allows the guardian to do) and the guardian's signed envelope.
//!
//! The mandate is public and enforced by the account contract. The person's trigger thresholds
//! and strategy are not in it: they travel in `sealed`, encrypted to the guardian enclave, so
//! nobody else can tell when the guardian will act.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, require, AccountId};

use crate::evm::EvmTxParams;
use crate::hyperliquid::HlOrder;

/// The protective powers a mandate can grant. Nothing else exists: there is no power to move
/// funds to another account.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Power {
    Repay,
    AddCollateral,
    Deleverage,
    HlReduce,
    HlHedge,
    EvmRepay,
}

/// How much of one token the guardian may use.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenLimit {
    pub token: AccountId,
    /// Total the guardian may spend from the account's own balance over the mandate's life
    /// (repay, add collateral).
    pub reserve: U128,
    /// Most the guardian may move per UTC day (repay, add collateral, collateral sold by a
    /// deleverage).
    pub daily: U128,
}

/// The Hyperliquid guard.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HlGuard {
    /// Risk board mark ticker, for example "NEAR".
    pub asset: String,
    pub asset_index: u32,
    /// Largest order size, scaled by 1e8.
    pub max_size_e8: U128,
    /// Largest distance of the order price from the mark, in bps (at most 300).
    pub band_bps: u32,
    /// Side a hedge may take: false = sell (a short against a long collateral position).
    pub hedge_is_buy: bool,
}

/// The EVM guard: the one lending pool and debt asset the guardian may repay, for the person's
/// own Chain Signatures address.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmGuard {
    pub chain_id: u64,
    /// 0x addresses.
    pub pool: String,
    pub asset: String,
    /// The person's derived address (`PATH_EVM`), which the repay is on behalf of.
    pub address: String,
    /// Largest repay (or approval) per action, in the asset's units.
    pub max_amount: U128,
}

/// What the owner allows.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mandate {
    /// The enclave's ed25519 key (`ed25519:<base58>`), published on the risk board.
    pub guardian_key: String,
    pub powers: Vec<Power>,
    pub limits: Vec<TokenLimit>,
    pub max_actions_per_day: u32,
    /// Health a deleverage must leave, in bps (at least 10500).
    pub min_health_after_bps: u32,
    /// Largest slippage of a rescue swap against the mark, in bps (at most 300).
    pub max_slippage_bps: u32,
    pub hl: Option<HlGuard>,
    pub evm: Option<EvmGuard>,
    /// Trigger thresholds and strategy, encrypted to the enclave's sealing key (at most 2 KiB).
    pub sealed: Option<Base64VecU8>,
    /// Seconds since the Unix epoch.
    pub expires_at: u64,
}

pub const MAX_SEALED_BYTES: usize = 2048;
pub const MIN_HEALTH_AFTER_BPS: u32 = 10_500;
pub const MAX_BAND_BPS: u32 = 300;
pub const MAX_SLIPPAGE_BPS: u32 = 300;
pub const MAX_LIMITS: usize = 8;
pub const MAX_MANDATE_SECS: u64 = 180 * 86_400;

impl Mandate {
    /// Checks the mandate's own consistency, as the owner sets it.
    pub fn assert_valid(&self, now: u64) {
        let key: near_sdk::PublicKey =
            self.guardian_key.parse().unwrap_or_else(|_| env::panic_str("bad guardian key"));
        require!(key.curve_type() == near_sdk::CurveType::ED25519, "guardian key must be ed25519");
        require!(!self.powers.is_empty(), "a mandate needs at least one power");
        require!(self.limits.len() <= MAX_LIMITS, "too many token limits");
        require!(self.expires_at > now, "mandate already expired");
        require!(self.expires_at <= now + MAX_MANDATE_SECS, "a mandate lasts at most 180 days");
        require!(self.max_actions_per_day > 0 && self.max_actions_per_day <= 48, "1 to 48 actions per day");
        require!(
            self.min_health_after_bps >= MIN_HEALTH_AFTER_BPS,
            "deleverage must leave health of at least 1.05"
        );
        require!(self.max_slippage_bps <= MAX_SLIPPAGE_BPS, "slippage is capped at 3%");
        if let Some(hl) = &self.hl {
            require!(hl.band_bps > 0 && hl.band_bps <= MAX_BAND_BPS, "price band is 1 to 300 bps");
            require!(hl.max_size_e8.0 > 0, "Hyperliquid size cap must be positive");
        }
        let hl_power = self.powers.iter().any(|p| matches!(p, Power::HlReduce | Power::HlHedge));
        require!(!hl_power || self.hl.is_some(), "Hyperliquid powers need a Hyperliquid guard");
        if let Some(evm) = &self.evm {
            for a in [&evm.pool, &evm.asset, &evm.address] {
                require!(crate::evm::parse_address(a).is_some(), "bad EVM address in the guard");
            }
            require!(evm.max_amount.0 > 0, "EVM repay cap must be positive");
        }
        require!(
            !self.powers.contains(&Power::EvmRepay) || self.evm.is_some(),
            "EVM repay needs an EVM guard"
        );
        if let Some(s) = &self.sealed {
            require!(s.0.len() <= MAX_SEALED_BYTES, "sealed policy too large");
        }
        let mut seen: Vec<&AccountId> = vec![];
        for l in &self.limits {
            require!(!seen.contains(&&l.token), "duplicate token limit");
            seen.push(&l.token);
        }
    }

    pub fn limit(&self, token: &AccountId) -> Option<&TokenLimit> {
        self.limits.iter().find(|l| &l.token == token)
    }

    pub fn allows(&self, p: Power) -> bool {
        self.powers.contains(&p)
    }
}

/// What the guardian saw when it decided.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trigger {
    pub score: u8,
    pub tier: String,
    pub health_bps: u32,
}

/// One protective action.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuardianAction {
    /// Repays debt in `token` from the account's own balance.
    Repay { token: AccountId, amount: U128 },
    /// Adds `token` from the account's own balance as collateral.
    AddCollateral { token: AccountId, amount: U128 },
    /// Withdraws `amount` of `collateral`, swaps it on the exchange pool for `debt`, repays, then
    /// checks health; every failed step restores the position.
    Deleverage { collateral: AccountId, amount: U128, pool_id: u64, debt: AccountId, min_out: U128 },
    /// A reduce-only Hyperliquid order inside the guard.
    HlReduce { order: HlOrder, nonce: u64 },
    /// A hedging Hyperliquid order (the guard's side only) inside the guard.
    HlHedge { order: HlOrder, nonce: u64 },
    /// ERC-20 approval of the guard's pool, for a following repay.
    EvmApprove { params: EvmTxParams, amount: U128 },
    /// Aave repay on behalf of the person's own address.
    EvmRepay { params: EvmTxParams, amount: U128 },
}

impl GuardianAction {
    pub fn power(&self) -> Power {
        match self {
            GuardianAction::Repay { .. } => Power::Repay,
            GuardianAction::AddCollateral { .. } => Power::AddCollateral,
            GuardianAction::Deleverage { .. } => Power::Deleverage,
            GuardianAction::HlReduce { .. } => Power::HlReduce,
            GuardianAction::HlHedge { .. } => Power::HlHedge,
            GuardianAction::EvmApprove { .. } | GuardianAction::EvmRepay { .. } => Power::EvmRepay,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            GuardianAction::Repay { .. } => "repay",
            GuardianAction::AddCollateral { .. } => "add_collateral",
            GuardianAction::Deleverage { .. } => "deleverage",
            GuardianAction::HlReduce { .. } => "hl_reduce",
            GuardianAction::HlHedge { .. } => "hl_hedge",
            GuardianAction::EvmApprove { .. } => "evm_approve",
            GuardianAction::EvmRepay { .. } => "evm_repay",
        }
    }
}

/// What the enclave signs: SHA-256(`ENVELOPE_DOMAIN` || exact JSON text).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardianEnvelope {
    pub account: AccountId,
    pub network: String,
    /// Strictly increasing per account.
    pub nonce: u64,
    /// Seconds; the envelope is valid for `ENVELOPE_TTL_SECS` after it.
    pub issued_at: u64,
    /// SHA-256 (hex) of the AI review record this action was approved by.
    pub review_hash: String,
    pub trigger: Trigger,
    pub action: GuardianAction,
}

pub const ENVELOPE_DOMAIN: &[u8] = b"parry-guardian:v1:";
pub const ENVELOPE_TTL_SECS: u64 = 120;
pub const ENVELOPE_SKEW_SECS: u64 = 30;

/// The digest the enclave signs for `envelope_json`.
pub fn envelope_digest(envelope_json: &str) -> [u8; 32] {
    let mut data = ENVELOPE_DOMAIN.to_vec();
    data.extend_from_slice(envelope_json.as_bytes());
    env::sha256_array(&data)
}

/// True for a 64-character lowercase hex string that is not all zeros.
pub fn is_review_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && s.bytes().any(|c| c != b'0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_json_shape() {
        let e = GuardianEnvelope {
            account: "alice.testnet".parse().unwrap(),
            network: "testnet".into(),
            nonce: 3,
            issued_at: 100,
            review_hash: "ab".repeat(32),
            trigger: Trigger { score: 81, tier: "critical".into(), health_bps: 10_420 },
            action: GuardianAction::Repay { token: "usdc.parry.testnet".parse().unwrap(), amount: U128(5) },
        };
        let j = near_sdk::serde_json::to_string(&e).unwrap();
        assert!(j.contains(r#""action":{"repay":{"token":"usdc.parry.testnet","amount":"5"}}"#), "{j}");
        let back: GuardianEnvelope = near_sdk::serde_json::from_str(&j).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn there_is_no_withdraw_power_or_action() {
        assert!(near_sdk::serde_json::from_str::<Power>(r#""withdraw""#).is_err());
        assert!(near_sdk::serde_json::from_str::<GuardianAction>(
            r#"{"withdraw":{"token":"usdc.parry.testnet","amount":"5","receiver":"eve.testnet"}}"#
        )
        .is_err());
        assert!(near_sdk::serde_json::from_str::<GuardianAction>(
            r#"{"transfer":{"receiver":"eve.testnet","amount":"5"}}"#
        )
        .is_err());
    }

    #[test]
    fn review_hash_format() {
        assert!(is_review_hash(&"0a".repeat(32)));
        assert!(!is_review_hash(&"0".repeat(64)));
        assert!(!is_review_hash(&"AB".repeat(32)));
        assert!(!is_review_hash("abc"));
    }
}
