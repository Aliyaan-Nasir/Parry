//! State migration from the layout deployed before the insurance fund.
//!
//! `migrate` reads that layout field by field (`VaultV1` is the deployed `Vault` struct, unchanged)
//! and adds the new fields with their defaults. A raw storage key records the layout version, so
//! `migrate` runs once and a vault created by `new` never needs it.

use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};

use crate::report::StoredReport;
use crate::{insurance, Claim, HedgeConfig, Vault, VaultExt, Withdrawal, DEFAULT_HEDGE_RATIO_MIN_BPS};

const LAYOUT_KEY: &[u8] = b"layout";
const LAYOUT_VERSION: u8 = 2;

/// Records that the state has the current layout.
pub(crate) fn mark_current() {
    env::storage_write(LAYOUT_KEY, &[LAYOUT_VERSION]);
}

/// The vault's state as deployed before the insurance fund.
#[near(serializers = [borsh])]
pub(crate) struct VaultV1 {
    pub owner_id: AccountId,
    pub network: String,
    pub risk: AccountId,
    pub keeper: AccountId,
    pub linear: AccountId,
    pub wnear: AccountId,
    pub usdc: AccountId,
    pub oracle: AccountId,
    pub signer: AccountId,
    pub hedge: HedgeConfig,
    pub deposit_cap: u128,
    pub min_deposit: u128,
    pub token: FungibleToken,
    pub staked_linear: u128,
    pub pending_deposit_near: u128,
    pub settled_pnl_e6: i128,
    pub loss_backing_linear: u128,
    pub buffer_usdc: u128,
    pub linear_rate_e24: u128,
    pub first_linear_rate_e24: u128,
    pub near_price_e8: u128,
    pub report: Option<StoredReport>,
    pub last_run_id: u64,
    pub hedge_order_signed: bool,
    pub last_hedge_nonce: u64,
    pub manual_paused: bool,
    pub risk_paused: bool,
    pub leverage_reduced: bool,
    pub needs_margin: bool,
    pub withdrawals: LookupMap<u64, Withdrawal>,
    pub withdrawal_head: u64,
    pub next_withdrawal_id: u64,
    pub queued_shares: u128,
    pub claims: LookupMap<AccountId, Claim>,
}

#[near]
impl Vault {
    /// Moves the deployed state to this layout. Every balance, share, queue entry and claim stays
    /// where it is; the insurance fund starts empty with its defaults, its staking mark at the
    /// last LiNEAR rate seen (so no yield from before is skimmed), and the hedge ratio floor at
    /// 70% (or the configured ratio, if lower). Claim totals start at 0: claims recorded before
    /// are paid as usual and never take the totals below 0. Called by the owner, or by the vault's
    /// own account in the batch that deploys the code.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        require!(env::storage_read(LAYOUT_KEY).is_none(), "the state is already migrated");
        let old: VaultV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("no deployed state to migrate"));
        let caller = env::predecessor_account_id();
        require!(caller == old.owner_id || caller == env::current_account_id(), "owner only");
        mark_current();
        let mut fund = insurance::Insurance::new();
        fund.rate_mark_e24 = old.linear_rate_e24;
        Vault {
            hedge_ratio_min_bps: DEFAULT_HEDGE_RATIO_MIN_BPS.min(old.hedge.hedge_ratio_bps),
            owner_id: old.owner_id,
            network: old.network,
            risk: old.risk,
            keeper: old.keeper,
            linear: old.linear,
            wnear: old.wnear,
            usdc: old.usdc,
            oracle: old.oracle,
            signer: old.signer,
            hedge: old.hedge,
            deposit_cap: old.deposit_cap,
            min_deposit: old.min_deposit,
            token: old.token,
            staked_linear: old.staked_linear,
            pending_deposit_near: old.pending_deposit_near,
            settled_pnl_e6: old.settled_pnl_e6,
            loss_backing_linear: old.loss_backing_linear,
            buffer_usdc: old.buffer_usdc,
            linear_rate_e24: old.linear_rate_e24,
            first_linear_rate_e24: old.first_linear_rate_e24,
            near_price_e8: old.near_price_e8,
            report: old.report,
            last_run_id: old.last_run_id,
            hedge_order_signed: old.hedge_order_signed,
            last_hedge_nonce: old.last_hedge_nonce,
            manual_paused: old.manual_paused,
            risk_paused: old.risk_paused,
            leverage_reduced: old.leverage_reduced,
            needs_margin: old.needs_margin,
            withdrawals: old.withdrawals,
            withdrawal_head: old.withdrawal_head,
            next_withdrawal_id: old.next_withdrawal_id,
            queued_shares: old.queued_shares,
            claims: old.claims,
            insurance: fund,
            report_hedge_ratio_bps: None,
            hedge_ratio_reason: String::new(),
            margin_ratio_bps: None,
            claims_linear: 0,
            claims_usdc_e6: 0,
        }
    }
}
