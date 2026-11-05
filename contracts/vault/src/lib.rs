//! # Parry Earn vault
//!
//! Deposit NEAR (or wNEAR): the vault stakes it into LiNEAR and keeps a short NEAR perp on
//! Hyperliquid, signed by the vault's own Chain Signatures address, sized to a hedge ratio
//! (default 90%). A share then holds its dollar value and earns the staking yield plus funding,
//! and nobody who deposits can be liquidated. Shares are the NEP-141 token "Parry Earn" (`EARN`,
//! 24 decimals), valued in USD.
//!
//! ## Money model (testnet, stated honestly)
//!
//! - Depositors own the LiNEAR the vault tracks as `staked_linear` (L) and the hedge's PnL on
//!   Hyperliquid that has not been settled yet. On testnet the hedge margin is operator-funded
//!   faucet USDC, reported as `margin_baseline_e6` (B); it is not depositors' money.
//! - `settled_pnl_e6` (signed) is the hedge PnL already settled with leavers: a positive share
//!   is paid to the leaver in USDC from the settlement buffer, so the operator keeps that much of
//!   the hedge account; a negative share is borne by the leaver receiving less LiNEAR, and the
//!   LiNEAR kept back (`loss_backing_linear`) backs that loss for the operator's margin. Either
//!   way the settled amount no longer belongs to the remaining depositors.
//! - Hedge equity E = account value − B − settled (may be negative). With r the LiNEAR rate (NEAR per
//!   LiNEAR, 1e24) and P the NEAR/USD price (1e8):
//!   `NAV_e6 = L × r / 1e24 × P / 1e26 + E`, floored at 0.
//! - Share price: 1 USD per share (1e24 units) while no shares exist, else NAV / supply. A deposit
//!   worth V = D × P mints V × supply / NAV shares (rounded down, against the NAV rounded up), or
//!   V × 1e18 units for the first one.
//! - Exposure X = L × r / 1e24 NEAR. Target short S* = ratio × X × active / supply (active leaves
//!   out shares escrowed for withdrawal), capped so that S* × mark / account value stays within
//!   the maximum leverage (3x by default, 2x while the risk score is elevated).
//! - The USDC settlement buffer is operator money that pays positive hedge PnL to leavers on
//!   NEAR. It is never part of NAV. LiNEAR or USDC that failed to reach a leaver, and USDC the
//!   buffer could not cover yet, wait as the leaver's claim and are not part of NAV either.
//!
//! ## Flows
//!
//! - **Deposit** (`deposit`, or wNEAR through `ft_transfer_call`): checks the pause, the minimum,
//!   the cap and the report's age, registers the depositor (storage paid from the deposit), reads
//!   the oracle price and the LiNEAR rate, checks the price against the report's mark, stakes, and
//!   only once the stake succeeded mints the shares. Every failed step refunds.
//! - **Hedge** (`rebalance`, anyone): reads the LiNEAR rate, sizes the target, and when the short
//!   is out of band builds an IOC order, emits it with its agent digest, and asks Chain Signatures
//!   to sign it. At most one order per report: the next report must show what the last one did.
//! - **Withdraw** (`request_withdraw`, then `process_withdrawals` by anyone): shares wait in escrow
//!   until a report observed after the request (the keeper unwinds their hedge first), then pay
//!   LiNEAR plus the hedge PnL share. Failed transfers become claims (`claim`).
//! - **Reports** (`on_vault_report`, risk board only): the hedge, the reserves and the risk score,
//!   which pauses deposits, lowers leverage and flags margin in code.

mod deposit;
mod hedge;
pub mod nav;
pub mod order;
mod report;
#[cfg(test)]
mod tests;
mod wire;
mod withdraw;

pub use hedge::HedgeSignature;
pub use report::{HedgeReport, ReservesReport, StoredReport};
pub use withdraw::{Claim, Withdrawal};

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::{I128, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseOrValue,
};
use parry_common::hyperliquid::HlOrder;
use parry_common::math::Rounding;
use parry_common::now_secs;

/// Deposits, rebalances and withdrawals need a report at most this old (15 minutes).
pub const REPORT_MAX_AGE_SECS: u64 = 900;
/// Oracle prices older than this cannot price a deposit.
pub const ORACLE_MAX_AGE_SECS: u64 = 120;
/// The oracle price must sit within this distance of the report's Hyperliquid mark.
pub const ORACLE_MAX_DEVIATION_BPS: u128 = 200;
/// Chain Signatures derivation path of the vault's Hyperliquid address.
pub const HEDGE_PATH: &str = "parry-vault-hedge";
pub const MIN_HEDGE_RATIO_BPS: u32 = 5_000;
pub const MAX_HEDGE_RATIO_BPS: u32 = 10_000;
pub const MAX_BAND_BPS: u32 = 300;
/// 1x to 10x: above that a short on a volatile asset sits too close to liquidation.
pub const MIN_LEVERAGE_X100: u32 = 100;
pub const MAX_LEVERAGE_X100: u32 = 1_000;
pub const SHARE_DECIMALS: u8 = 24;

const GAS_VIEW: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Shares,
    Withdrawals,
    Claims,
}

/// The hedge's market and sizing rules.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgeConfig {
    /// Hyperliquid asset name, "NEAR".
    pub asset: String,
    /// Hyperliquid asset index (54 for NEAR on testnet).
    pub asset_index: u32,
    /// Hyperliquid's szDecimals for the asset (1 for NEAR): the lot is 10^-szDecimals.
    pub sz_decimals: u8,
    /// Share of the staked exposure to hedge, 5000 to 10000.
    pub hedge_ratio_bps: u32,
    /// Maximum hedge leverage ×100 (300 is 3x).
    pub max_leverage_x100: u32,
    /// Limit price distance from the mark, at most 300.
    pub band_bps: u32,
}

impl HedgeConfig {
    fn assert_valid(&self) {
        require!(!self.asset.is_empty() && self.asset.len() <= 16, "hedge asset must be 1 to 16 bytes");
        require!(
            self.sz_decimals as u32 <= order::PERP_MAX_DECIMALS,
            "sz_decimals must be at most 6 (Hyperliquid perps)"
        );
        assert_hedge_ratio(self.hedge_ratio_bps);
        require!(
            (MIN_LEVERAGE_X100..=MAX_LEVERAGE_X100).contains(&self.max_leverage_x100),
            "max_leverage_x100 must be 100 to 1000"
        );
        require!(self.band_bps > 0 && self.band_bps <= MAX_BAND_BPS, "band_bps must be 1 to 300");
    }
}

fn assert_hedge_ratio(bps: u32) {
    require!(
        (MIN_HEDGE_RATIO_BPS..=MAX_HEDGE_RATIO_BPS).contains(&bps),
        "hedge ratio must be 5000 to 10000 bps"
    );
}

#[near(event_json(standard = "parry-vault"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    DepositStarted { account: &'a AccountId, amount: U128, storage: U128, source: &'a str },
    #[event_version("1.0.0")]
    DepositPriced {
        account: &'a AccountId,
        amount: U128,
        shares: U128,
        price_e8: U128,
        linear_rate_e24: U128,
    },
    #[event_version("1.0.0")]
    DepositStaked { account: &'a AccountId, amount: U128, linear: U128, shares: U128 },
    #[event_version("1.0.0")]
    DepositRefunded { account: &'a AccountId, amount: U128, reason: &'a str },
    #[event_version("1.0.0")]
    BufferFunded { amount: U128, buffer: U128 },
    #[event_version("1.0.0")]
    HedgeOrder { nonce: u64, order: &'a HlOrder, digest: &'a str, target_e8: U128, current_e8: I128 },
    #[event_version("1.0.0")]
    HedgeInBand { target_e8: U128, current_e8: I128 },
    #[event_version("1.0.0")]
    HedgeSkipped { reason: &'a str },
    #[event_version("1.0.0")]
    HedgeSignFailed { nonce: u64 },
    #[event_version("1.0.0")]
    WithdrawalRequested { id: u64, account: &'a AccountId, shares: U128 },
    #[event_version("1.0.0")]
    WithdrawalProcessed {
        id: u64,
        account: &'a AccountId,
        shares: U128,
        linear: U128,
        usdc: U128,
        usdc_owed: U128,
        pnl_e6: I128,
    },
    #[event_version("1.0.0")]
    WithdrawalsDeferred { reason: &'a str },
    #[event_version("1.0.0")]
    PayoutFailed { account: &'a AccountId, token: &'a str, amount: U128 },
    #[event_version("1.0.0")]
    Claimed { account: &'a AccountId, linear: U128, usdc: U128 },
    #[event_version("1.0.0")]
    ReportApplied { run_id: u64, at: u64, score: u8 },
    #[event_version("1.0.0")]
    DepositsPaused { score: u8 },
    #[event_version("1.0.0")]
    DepositsResumed { score: u8 },
    #[event_version("1.0.0")]
    LeverageReduced { score: u8, max_leverage_x100: u32 },
    #[event_version("1.0.0")]
    LeverageRestored { score: u8, max_leverage_x100: u32 },
    #[event_version("1.0.0")]
    MarginNeeded { score: u8 },
    #[event_version("1.0.0")]
    ConfigUpdated { key: &'a str },
    #[event_version("1.0.0")]
    LossBackingReleased { amount: U128 },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    network: String,
    /// The risk board: the only account whose `on_vault_report` calls are accepted.
    risk: AccountId,
    /// The operator's keeper, which usually calls `rebalance` and `process_withdrawals`. Both are
    /// open to anyone, so the role grants no power; it is recorded for dashboards and services.
    keeper: AccountId,
    linear: AccountId,
    wnear: AccountId,
    usdc: AccountId,
    oracle: AccountId,
    signer: AccountId,
    hedge: HedgeConfig,
    /// Most NEAR (staked equivalent plus in-flight deposits) the vault takes.
    deposit_cap: u128,
    min_deposit: u128,

    /// EARN shares (NEP-141). The vault's own account holds the shares escrowed for withdrawal.
    token: FungibleToken,

    /// LiNEAR owned by depositors.
    staked_linear: u128,
    /// NEAR of deposits being priced or staked, counted against the cap.
    pending_deposit_near: u128,
    /// Hedge PnL settled with leavers (USD e6, signed).
    settled_pnl_e6: i128,
    /// LiNEAR kept from leavers whose hedge share was negative; it backs that loss for the margin
    /// provider and is outside NAV.
    loss_backing_linear: u128,
    /// Operator test USDC for paying positive hedge PnL to leavers (6 decimals, USD e6).
    buffer_usdc: u128,

    /// Latest LiNEAR rate seen (NEAR per LiNEAR, 1e24) and the first one, for the yield view.
    linear_rate_e24: u128,
    first_linear_rate_e24: u128,
    /// Latest NEAR/USD seen (1e8): the oracle price of the last deposit or the mark of the last
    /// report, whichever came later.
    near_price_e8: u128,

    report: Option<StoredReport>,
    last_run_id: u64,
    /// True once a hedge order was signed against the current report; the next report clears
    /// it. One order per report means the vault never signs a second order before seeing what
    /// the first one did, so repeated `rebalance` calls cannot stack orders.
    hedge_order_signed: bool,
    /// Last Hyperliquid nonce signed (milliseconds); every new one is strictly larger.
    last_hedge_nonce: u64,

    manual_paused: bool,
    risk_paused: bool,
    leverage_reduced: bool,
    needs_margin: bool,

    withdrawals: LookupMap<u64, Withdrawal>,
    /// Id of the oldest unprocessed withdrawal; ids are sequential, so the queue is
    /// `withdrawal_head..next_withdrawal_id`.
    withdrawal_head: u64,
    next_withdrawal_id: u64,
    queued_shares: u128,
    claims: LookupMap<AccountId, Claim>,
}

/// Every setting, as `config()` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
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
    pub deposit_cap: U128,
    pub min_deposit: U128,
    pub hedge_path: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgeView {
    /// Short the vault aims for (NEAR, 1e8), at the last known LiNEAR rate.
    pub target_e8: U128,
    /// Short the last report observed (NEAR, 1e8; negative would be a long).
    pub current_e8: I128,
    pub entry_e8: U128,
    pub mark_e8: U128,
    pub liquidation_e8: U128,
    pub account_value_e6: U128,
    pub margin_baseline_e6: U128,
    pub unrealized_e6: I128,
    pub funding_e6: I128,
    /// Depositors' hedge equity: account value − operator margin − settled PnL.
    pub equity_e6: I128,
    pub leverage_x100: u32,
    pub effective_max_leverage_x100: u32,
    pub hedge_ratio_bps: u32,
    pub needs_margin: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservesView {
    pub root: String,
    pub leaves: u32,
    pub total_usd_e6: U128,
    pub liabilities_usd_e6: U128,
    pub ratio_bps: u32,
    pub at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultState {
    pub network: String,
    /// Deposits refused (owner pause or risk pause).
    pub paused: bool,
    pub manual_paused: bool,
    pub risk_paused: bool,
    pub risk_score: Option<u8>,
    pub report_at: Option<u64>,
    pub report_age_secs: Option<u64>,
    pub staked_linear: U128,
    pub linear_rate_e24: U128,
    pub near_price_e8: U128,
    pub nav_e6: U128,
    /// USD e6 per share (1e24 units).
    pub share_price_e6: U128,
    pub total_shares: U128,
    pub active_shares: U128,
    pub queued_shares: U128,
    pub hedge: HedgeView,
    pub reserves: Option<ReservesView>,
    pub buffer_usdc: U128,
    pub settled_pnl_e6: I128,
    pub loss_backing_linear: U128,
    pub pending_deposit_near: U128,
    pub deposit_cap: U128,
    pub min_deposit: U128,
    pub queue_length: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct YieldBreakdown {
    /// LiNEAR rate growth from the first rate the vault saw to the latest, in bps.
    pub staking_rate_growth_bps: i64,
    pub first_linear_rate_e24: U128,
    pub linear_rate_e24: U128,
    /// Funding the hedge account has received (negative: paid), USD e6.
    pub funding_e6: I128,
    /// The hedge account's PnL over its operator margin (includes funding and what was settled
    /// with leavers), USD e6.
    pub hedge_pnl_e6: I128,
}

#[near]
impl Vault {
    // Every argument is a deploy-time choice of the vault's counterparties and limits.
    #[allow(clippy::too_many_arguments)]
    #[init]
    pub fn new(
        owner_id: AccountId,
        network: String,
        risk: AccountId,
        keeper: AccountId,
        linear: AccountId,
        wnear: AccountId,
        usdc: AccountId,
        oracle: AccountId,
        signer: AccountId,
        hedge: HedgeConfig,
        deposit_cap: U128,
        min_deposit: U128,
    ) -> Self {
        require!(network == "testnet" || network == "mainnet", "network must be testnet or mainnet");
        hedge.assert_valid();
        let mut this = Self {
            owner_id,
            network,
            risk,
            keeper,
            linear,
            wnear,
            usdc,
            oracle,
            signer,
            hedge,
            deposit_cap: deposit_cap.0,
            min_deposit: min_deposit.0,
            token: FungibleToken::new(StorageKey::Shares),
            staked_linear: 0,
            pending_deposit_near: 0,
            settled_pnl_e6: 0,
            loss_backing_linear: 0,
            buffer_usdc: 0,
            linear_rate_e24: 0,
            first_linear_rate_e24: 0,
            near_price_e8: 0,
            report: None,
            last_run_id: 0,
            hedge_order_signed: false,
            last_hedge_nonce: 0,
            manual_paused: false,
            risk_paused: false,
            leverage_reduced: false,
            needs_margin: false,
            withdrawals: LookupMap::new(StorageKey::Withdrawals),
            withdrawal_head: 0,
            next_withdrawal_id: 0,
            queued_shares: 0,
            claims: LookupMap::new(StorageKey::Claims),
        };
        this.assert_caps();
        // The vault's own account holds escrowed shares.
        this.token.internal_register_account(&env::current_account_id());
        this
    }

    // -----------------------------------------------------------------------------------------
    // Owner (one yoctoNEAR, so only a full-access key can sign)
    // -----------------------------------------------------------------------------------------

    #[payable]
    pub fn set_hedge_ratio(&mut self, hedge_ratio_bps: u32) {
        self.assert_owner();
        assert_hedge_ratio(hedge_ratio_bps);
        self.hedge.hedge_ratio_bps = hedge_ratio_bps;
        Event::ConfigUpdated { key: "hedge_ratio_bps" }.emit();
    }

    #[payable]
    pub fn set_caps(&mut self, deposit_cap: U128, min_deposit: U128) {
        self.assert_owner();
        self.deposit_cap = deposit_cap.0;
        self.min_deposit = min_deposit.0;
        self.assert_caps();
        Event::ConfigUpdated { key: "caps" }.emit();
    }

    #[payable]
    pub fn set_keeper(&mut self, keeper: AccountId) {
        self.assert_owner();
        self.keeper = keeper;
        Event::ConfigUpdated { key: "keeper" }.emit();
    }

    /// Moves report intake to another risk board. Its run ids start their own sequence, so the
    /// run id floor starts over with it.
    #[payable]
    pub fn set_risk(&mut self, risk: AccountId) {
        self.assert_owner();
        self.risk = risk;
        self.last_run_id = 0;
        Event::ConfigUpdated { key: "risk" }.emit();
    }

    /// Stops deposits, independently of the risk pause (a calm score never lifts it).
    #[payable]
    pub fn pause_deposits(&mut self) {
        self.assert_owner();
        self.manual_paused = true;
        Event::ConfigUpdated { key: "paused" }.emit();
    }

    #[payable]
    pub fn unpause_deposits(&mut self) {
        self.assert_owner();
        self.manual_paused = false;
        Event::ConfigUpdated { key: "unpaused" }.emit();
    }

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    pub fn vault_state(&self) -> VaultState {
        let now = now_secs();
        let supply = self.token.total_supply;
        let nav = self.view_nav_e6();
        VaultState {
            network: self.network.clone(),
            paused: self.paused(),
            manual_paused: self.manual_paused,
            risk_paused: self.risk_paused,
            risk_score: self.report.as_ref().map(|r| r.score),
            report_at: self.report.as_ref().map(|r| r.at),
            report_age_secs: self.report.as_ref().map(|r| now.saturating_sub(r.at)),
            staked_linear: U128(self.staked_linear),
            linear_rate_e24: U128(self.linear_rate_e24),
            near_price_e8: U128(self.near_price_e8),
            nav_e6: U128(nav),
            share_price_e6: U128(nav::share_price_e6(nav, supply)),
            total_shares: U128(supply),
            active_shares: U128(self.active_shares()),
            queued_shares: U128(self.queued_shares),
            hedge: self.hedge_status(),
            reserves: self.reserves(),
            buffer_usdc: U128(self.buffer_usdc),
            settled_pnl_e6: I128(self.settled_pnl_e6),
            loss_backing_linear: U128(self.loss_backing_linear),
            pending_deposit_near: U128(self.pending_deposit_near),
            deposit_cap: U128(self.deposit_cap),
            min_deposit: U128(self.min_deposit),
            queue_length: self.next_withdrawal_id - self.withdrawal_head,
        }
    }

    /// USD e6 per share (1e24 units), at the last known rate and price.
    pub fn share_price(&self) -> U128 {
        U128(nav::share_price_e6(self.view_nav_e6(), self.token.total_supply))
    }

    pub fn hedge_status(&self) -> HedgeView {
        let max_leverage = self.effective_max_leverage_x100();
        let Some(r) = &self.report else {
            return HedgeView {
                target_e8: U128(0),
                current_e8: I128(0),
                entry_e8: U128(0),
                mark_e8: U128(0),
                liquidation_e8: U128(0),
                account_value_e6: U128(0),
                margin_baseline_e6: U128(0),
                unrealized_e6: I128(0),
                funding_e6: I128(0),
                equity_e6: I128(self.hedge_equity_e6()),
                leverage_x100: 0,
                effective_max_leverage_x100: max_leverage,
                hedge_ratio_bps: self.hedge.hedge_ratio_bps,
                needs_margin: self.needs_margin,
            };
        };
        let h = &r.hedge;
        let plan = self.hedge_plan(self.linear_rate_e24, r);
        HedgeView {
            target_e8: U128(plan.target_e8),
            current_e8: I128(plan.current_e8),
            entry_e8: h.entry_e8,
            mark_e8: h.mark_e8,
            liquidation_e8: h.liquidation_e8,
            account_value_e6: h.account_value_e6,
            margin_baseline_e6: h.margin_baseline_e6,
            unrealized_e6: h.unrealized_e6,
            funding_e6: h.funding_e6,
            equity_e6: I128(self.hedge_equity_e6()),
            leverage_x100: order::leverage_x100(
                h.size_e8.0.unsigned_abs(),
                h.mark_e8.0,
                h.account_value_e6.0,
            ),
            effective_max_leverage_x100: max_leverage,
            hedge_ratio_bps: self.hedge.hedge_ratio_bps,
            needs_margin: self.needs_margin,
        }
    }

    /// The reserves ratio the enclave last published (reserves / liabilities, bps).
    pub fn collateral_ratio(&self) -> Option<u32> {
        self.report.as_ref().map(|r| r.reserves.ratio_bps)
    }

    pub fn reserves(&self) -> Option<ReservesView> {
        self.report.as_ref().map(|r| ReservesView {
            root: r.reserves.root.clone(),
            leaves: r.reserves.leaves,
            total_usd_e6: r.reserves.total_usd_e6,
            liabilities_usd_e6: r.reserves.liabilities_usd_e6,
            ratio_bps: r.reserves.ratio_bps,
            at: r.at,
        })
    }

    pub fn yield_breakdown(&self) -> YieldBreakdown {
        let (first, last) = (self.first_linear_rate_e24, self.linear_rate_e24);
        let growth = if first == 0 {
            0
        } else {
            let diff = nav::to_i128(last) - nav::to_i128(first);
            (diff.saturating_mul(10_000) / nav::to_i128(first)) as i64
        };
        let (funding, pnl) = match &self.report {
            None => (0, 0),
            Some(r) => (
                r.hedge.funding_e6.0,
                nav::to_i128(r.hedge.account_value_e6.0) - nav::to_i128(r.hedge.margin_baseline_e6.0),
            ),
        };
        YieldBreakdown {
            staking_rate_growth_bps: growth,
            first_linear_rate_e24: U128(first),
            linear_rate_e24: U128(last),
            funding_e6: I128(funding),
            hedge_pnl_e6: I128(pnl),
        }
    }

    pub fn latest_report(&self) -> Option<StoredReport> {
        self.report.clone()
    }

    pub fn config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            network: self.network.clone(),
            risk: self.risk.clone(),
            keeper: self.keeper.clone(),
            linear: self.linear.clone(),
            wnear: self.wnear.clone(),
            usdc: self.usdc.clone(),
            oracle: self.oracle.clone(),
            signer: self.signer.clone(),
            hedge: self.hedge.clone(),
            deposit_cap: U128(self.deposit_cap),
            min_deposit: U128(self.min_deposit),
            hedge_path: HEDGE_PATH.to_string(),
        }
    }
}

impl Vault {
    pub(crate) fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    /// The minimum must cover the share registration a first deposit pays for, so a deposit
    /// that passes the minimum always stakes something.
    fn assert_caps(&self) {
        require!(
            self.min_deposit > self.storage_cost(),
            "min_deposit must exceed the share registration cost"
        );
        require!(self.deposit_cap >= self.min_deposit, "deposit_cap must be at least min_deposit");
    }

    /// NEAR one share registration costs (NEP-145 minimum).
    pub(crate) fn storage_cost(&self) -> u128 {
        self.token.storage_balance_bounds().min.as_yoctonear()
    }

    pub(crate) fn paused(&self) -> bool {
        self.manual_paused || self.risk_paused
    }

    pub(crate) fn effective_max_leverage_x100(&self) -> u32 {
        if self.leverage_reduced {
            self.hedge.max_leverage_x100.min(report::REDUCED_LEVERAGE_X100)
        } else {
            self.hedge.max_leverage_x100
        }
    }

    pub(crate) fn active_shares(&self) -> u128 {
        self.token.total_supply.saturating_sub(self.queued_shares)
    }

    /// Records a LiNEAR rate read from the LiNEAR contract.
    pub(crate) fn observe_rate(&mut self, rate_e24: u128) {
        self.linear_rate_e24 = rate_e24;
        if self.first_linear_rate_e24 == 0 {
            self.first_linear_rate_e24 = rate_e24;
        }
    }

    /// NAV for views, at the last known rate and price, rounded down.
    fn view_nav_e6(&self) -> u128 {
        nav::nav_e6(
            self.staked_linear,
            self.linear_rate_e24,
            self.near_price_e8,
            self.hedge_equity_e6(),
            Rounding::Down,
        )
    }
}

// ---------------------------------------------------------------------------------------------
// NEP-141 / NEP-145 / NEP-148
// ---------------------------------------------------------------------------------------------

#[near]
impl FungibleTokenCore for Vault {
    /// Standard transfer, except to the vault itself: shares sent there would sit with the
    /// escrow without a queue entry. `request_withdraw` is the way to hand shares back.
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(receiver_id != env::current_account_id(), "use request_withdraw to return shares");
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(receiver_id != env::current_account_id(), "use request_withdraw to return shares");
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Vault {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Vault {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// Unregisters the caller and refunds its registration. With `force`, a positive balance is
    /// burned (and reported as `ft_burn`), which leaves its value to the other holders.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        require!(env::predecessor_account_id() != env::current_account_id(), "the vault keeps its escrow");
        match self.token.internal_storage_unregister(force) {
            Some((account_id, burned)) => {
                if burned > 0 {
                    near_contract_standards::fungible_token::events::FtBurn {
                        owner_id: &account_id,
                        amount: U128(burned),
                        memo: Some("storage_unregister"),
                    }
                    .emit();
                }
                true
            }
            None => false,
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Vault {
    /// Fixed metadata, built in code rather than stored.
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Parry Earn".to_string(),
            symbol: "EARN".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: SHARE_DECIMALS,
        }
    }
}
