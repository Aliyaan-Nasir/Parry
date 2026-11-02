//! # Parry test token
//!
//! A NEP-141 fungible token (with NEP-145 storage management and NEP-148 metadata) for NEAR
//! testnet, where the assets Parry works with have no testnet issuer. The same code is deployed
//! once per asset: a 6-decimal test USDC and an 18-decimal booster token for the lending
//! contract's booster slot.
//!
//! Anyone registered with the token can draw a fixed amount from the public faucet, at most once
//! per period. The owner can mint freely and tune the faucet. Nothing here is meant to hold value.
//!
//! Storage model: an account pays once, at `storage_deposit`, for both its balance entry and its
//! faucet record, so the faucet never spends the contract's own balance on storage. The faucet
//! record outlives a claim on purpose: it is what enforces the period, so unregistering is refused
//! while a period is still running (otherwise unregister and register again would reset it).

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::{LazyOption, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    PromiseOrValue,
};

/// NEP-148 caps nothing, but 24 decimals is the most any NEAR token uses (the native token
/// itself), and more would only invite overflow in clients that scale amounts.
const MAX_DECIMALS: u8 = 24;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Metadata,
    LastClaim,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    token: FungibleToken,
    /// Kept out of the root state: the icon can be a few kilobytes and most calls never need it.
    metadata: LazyOption<FungibleTokenMetadata>,
    /// Block time (unix seconds) of each account's last faucet claim.
    last_claim: LookupMap<AccountId, u64>,
    /// Raw amount (in the token's smallest unit) minted per faucet claim.
    faucet_amount: u128,
    /// Minimum seconds between two claims by the same account.
    faucet_period_secs: u64,
}

/// What the faucet will do for one account.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaucetStatus {
    /// Earliest block time (unix seconds) at which `faucet` succeeds for this account; 0 when the
    /// account has never claimed. The faucet is open whenever `next_at` is not in the future.
    pub next_at: u64,
    /// Raw amount one claim mints.
    pub amount: U128,
    /// Seconds between two claims by the same account.
    pub period_secs: u64,
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

#[near]
impl Contract {
    // Every argument is a deploy-time choice of the token's public interface.
    #[allow(clippy::too_many_arguments)]
    #[init]
    pub fn new(
        owner_id: AccountId,
        name: String,
        symbol: String,
        decimals: u8,
        icon: Option<String>,
        faucet_amount: U128,
        faucet_period_secs: u64,
    ) -> Self {
        require!(!name.trim().is_empty(), "name must not be empty");
        require!(!symbol.trim().is_empty(), "symbol must not be empty");
        require!(decimals <= MAX_DECIMALS, "decimals must be at most 24");
        if let Some(icon) = &icon {
            // NEP-148: the icon is a data URL, so wallets never fetch a remote image.
            require!(icon.starts_with("data:"), "icon must be a data URL");
        }
        assert_faucet_config(faucet_amount.0, faucet_period_secs);

        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();

        let mut this = Self {
            owner_id,
            token: FungibleToken::new(StorageKey::Accounts),
            metadata: LazyOption::new(StorageKey::Metadata, Some(metadata)),
            last_claim: LookupMap::new(StorageKey::LastClaim),
            faucet_amount: faucet_amount.0,
            faucet_period_secs,
        };
        // The registration price covers the balance entry (measured by `FungibleToken::new`)
        // plus the faucet record, measured the same way on the longest possible account id.
        this.token.account_storage_usage += this.measure_claim_record();
        this
    }

    /// Mints `faucet_amount` to the caller, at most once per `faucet_period_secs`. The caller must
    /// already be registered (`storage_deposit`), which also prepays its faucet record.
    /// Returns the amount minted.
    pub fn faucet(&mut self) -> U128 {
        let account_id = env::predecessor_account_id();
        require!(
            self.token.accounts.contains_key(&account_id),
            format!("{account_id} is not registered with this token: call storage_deposit first")
        );
        let now = now_secs();
        if let Some(next_at) = self.next_claim_at(&account_id) {
            require!(
                now >= next_at,
                format!("faucet already claimed: next claim at {next_at} (unix seconds)")
            );
        }
        self.last_claim.insert(account_id.clone(), now);
        self.mint_to(&account_id, self.faucet_amount, "faucet");
        U128(self.faucet_amount)
    }

    /// The faucet's amount and period, and when `account_id` may claim next.
    pub fn faucet_status(&self, account_id: AccountId) -> FaucetStatus {
        FaucetStatus {
            next_at: self.next_claim_at(&account_id).unwrap_or(0),
            amount: U128(self.faucet_amount),
            period_secs: self.faucet_period_secs,
        }
    }

    /// Mints `amount` to a registered account. Owner only, with 1 yoctoNEAR attached so it can
    /// only be signed with a full-access key.
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        require!(
            self.token.accounts.contains_key(&account_id),
            format!("{account_id} is not registered with this token: call storage_deposit first")
        );
        self.mint_to(&account_id, amount.0, "mint");
    }

    /// Changes the faucet's amount and period. A shorter period applies at once to accounts that
    /// claimed under the longer one, since the next claim time is always derived from it.
    #[payable]
    pub fn set_faucet(&mut self, amount: U128, period_secs: u64) {
        self.assert_owner();
        assert_faucet_config(amount.0, period_secs);
        self.faucet_amount = amount.0;
        self.faucet_period_secs = period_secs;
    }

    /// The account allowed to mint and to change the faucet.
    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn next_claim_at(&self, account_id: &AccountId) -> Option<u64> {
        self.last_claim.get(account_id).map(|last| last.saturating_add(self.faucet_period_secs))
    }

    fn mint_to(&mut self, account_id: &AccountId, amount: u128, memo: &str) {
        self.token.internal_deposit(account_id, amount);
        FtMint { owner_id: account_id, amount: U128(amount), memo: Some(memo) }.emit();
    }

    /// Bytes one faucet record takes, measured by writing a record for a 64-character account
    /// id (the longest NEAR allows) and removing it again.
    fn measure_claim_record(&mut self) -> u64 {
        let before = env::storage_usage();
        let probe: AccountId = "a".repeat(64).parse().unwrap_or_else(|_| env::abort());
        self.last_claim.insert(probe.clone(), u64::MAX);
        self.last_claim.flush();
        let used = env::storage_usage() - before;
        self.last_claim.remove(&probe);
        self.last_claim.flush();
        used
    }
}

fn assert_faucet_config(amount: u128, period_secs: u64) {
    require!(amount > 0, "faucet amount must be positive");
    require!(period_secs > 0, "faucet period must be at least one second");
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
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
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Contract {
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

    /// Unregisters the caller and refunds its whole registration (balance entry and faucet
    /// record). Refused while the caller's faucet period is running, because removing the
    /// record would let the caller claim again at once. With `force`, a positive balance is
    /// burned, and the burn is reported as a NEP-141 `ft_burn` event.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        if let Some(next_at) = self.next_claim_at(&account_id) {
            require!(
                now_secs() >= next_at,
                format!("faucet period runs until {next_at} (unix seconds): unregister after it")
            );
        }
        match self.token.internal_storage_unregister(force) {
            Some((account_id, burned)) => {
                self.last_claim.remove(&account_id);
                if burned > 0 {
                    FtBurn { owner_id: &account_id, amount: U128(burned), memo: Some("storage_unregister") }
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
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone().unwrap_or_else(|| env::abort())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const START: u64 = 1_800_000_000;
    const PERIOD: u64 = 86_400;
    const AMOUNT: u128 = 1_000 * 1_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn set_ctx(who: &str, secs: u64, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("usdc.parry.testnet"))
            .predecessor_account_id(account(who))
            .signer_account_id(account(who))
            .block_timestamp(secs * 1_000_000_000)
            .attached_deposit(deposit)
            .build());
    }

    fn call(who: &str, secs: u64) {
        set_ctx(who, secs, NearToken::from_yoctonear(0));
    }

    fn call_yocto(who: &str, secs: u64) {
        set_ctx(who, secs, NearToken::from_yoctonear(1));
    }

    fn deploy() -> Contract {
        call("owner.testnet", START);
        Contract::new(
            account("owner.testnet"),
            "Test USD Coin".into(),
            "USDC".into(),
            6,
            Some("data:image/svg+xml,%3Csvg%3E%3C/svg%3E".into()),
            U128(AMOUNT),
            PERIOD,
        )
    }

    fn register(c: &mut Contract, who: &str, secs: u64) {
        let min = c.storage_balance_bounds().min;
        set_ctx(who, secs, min);
        c.storage_deposit(None, None);
    }

    #[test]
    fn faucet_mints_once_and_emits_ft_mint() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START + 5);
        assert_eq!(c.faucet(), U128(AMOUNT));
        assert_eq!(c.ft_balance_of(account("alice.testnet")), U128(AMOUNT));
        assert_eq!(c.ft_total_supply(), U128(AMOUNT));
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        assert_eq!(
            logs[0],
            format!(
                "EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_mint\",\
                 \"data\":[{{\"owner_id\":\"alice.testnet\",\"amount\":\"{AMOUNT}\",\"memo\":\"faucet\"}}]}}"
            )
        );
        let status = c.faucet_status(account("alice.testnet"));
        assert_eq!(
            status,
            FaucetStatus { next_at: START + 5 + PERIOD, amount: U128(AMOUNT), period_secs: PERIOD }
        );
    }

    #[test]
    #[should_panic(expected = "faucet already claimed")]
    fn faucet_too_early_is_refused() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call("alice.testnet", START + PERIOD - 1);
        c.faucet();
    }

    #[test]
    fn faucet_after_period_is_allowed() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        // Exactly one period later is the first second the faucet opens again.
        call("alice.testnet", START + PERIOD);
        c.faucet();
        assert_eq!(c.ft_balance_of(account("alice.testnet")), U128(2 * AMOUNT));
    }

    #[test]
    #[should_panic(expected = "is not registered with this token: call storage_deposit first")]
    fn faucet_for_unregistered_account_is_refused() {
        let mut c = deploy();
        call("bob.testnet", START);
        c.faucet();
    }

    #[test]
    fn faucet_status_for_new_account_is_open() {
        let c = deploy();
        let status = c.faucet_status(account("nobody.testnet"));
        assert_eq!(status.next_at, 0);
        assert_eq!(status.amount, U128(AMOUNT));
    }

    #[test]
    fn faucet_periods_are_per_account() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        register(&mut c, "bob.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call("bob.testnet", START + 1);
        c.faucet();
        assert_eq!(c.ft_total_supply(), U128(2 * AMOUNT));
    }

    #[test]
    fn owner_mints_to_registered_account() {
        let mut c = deploy();
        register(&mut c, "vault.parry.testnet", START);
        call_yocto("owner.testnet", START);
        c.mint(account("vault.parry.testnet"), U128(5));
        assert_eq!(c.ft_balance_of(account("vault.parry.testnet")), U128(5));
        assert!(get_logs()[0].contains("\"memo\":\"mint\""));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_mint_is_refused() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call_yocto("alice.testnet", START);
        c.mint(account("alice.testnet"), U128(5));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn mint_without_one_yocto_is_refused() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("owner.testnet", START);
        c.mint(account("alice.testnet"), U128(5));
    }

    #[test]
    #[should_panic(expected = "is not registered with this token")]
    fn mint_to_unregistered_account_is_refused() {
        let mut c = deploy();
        call_yocto("owner.testnet", START);
        c.mint(account("alice.testnet"), U128(5));
    }

    #[test]
    fn transfers_move_balances_and_emit_ft_transfer() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        register(&mut c, "bob.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call_yocto("alice.testnet", START + 1);
        c.ft_transfer(account("bob.testnet"), U128(300), Some("rent".into()));
        assert_eq!(c.ft_balance_of(account("alice.testnet")), U128(AMOUNT - 300));
        assert_eq!(c.ft_balance_of(account("bob.testnet")), U128(300));
        assert_eq!(c.ft_total_supply(), U128(AMOUNT));
        assert!(get_logs()[0].contains("\"event\":\"ft_transfer\""));
    }

    #[test]
    #[should_panic(expected = "The account bob.testnet is not registered")]
    fn transfer_to_unregistered_account_is_refused() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call_yocto("alice.testnet", START + 1);
        c.ft_transfer(account("bob.testnet"), U128(300), None);
    }

    #[test]
    fn owner_changes_faucet() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call_yocto("owner.testnet", START + 10);
        c.set_faucet(U128(7), 60);
        call("alice.testnet", START + 60);
        assert_eq!(c.faucet(), U128(7));
        assert_eq!(c.faucet_status(account("alice.testnet")).next_at, START + 120);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_change_faucet() {
        let mut c = deploy();
        call_yocto("alice.testnet", START);
        c.set_faucet(U128(7), 60);
    }

    #[test]
    #[should_panic(expected = "faucet period must be at least one second")]
    fn faucet_period_must_be_positive() {
        let mut c = deploy();
        call_yocto("owner.testnet", START);
        c.set_faucet(U128(7), 0);
    }

    #[test]
    fn registration_prepays_the_faucet_record() {
        let mut c = deploy();
        let min = c.storage_balance_bounds().min;
        let balance_only = FungibleToken::new(b"probe".to_vec()).account_storage_usage;
        assert!(c.token.account_storage_usage > balance_only);
        assert_eq!(min, env::storage_byte_cost().saturating_mul(c.token.account_storage_usage.into()));

        // A claim stores no more than the registration paid for.
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        let before = env::storage_usage();
        c.faucet();
        c.last_claim.flush();
        let record = env::storage_usage() - before;
        assert!(record <= c.token.account_storage_usage - balance_only);
    }

    #[test]
    #[should_panic(expected = "faucet period runs until")]
    fn unregister_during_faucet_period_is_refused() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call_yocto("alice.testnet", START + 10);
        c.storage_unregister(Some(true));
    }

    #[test]
    fn forced_unregister_after_period_burns_and_clears_the_record() {
        let mut c = deploy();
        register(&mut c, "alice.testnet", START);
        call("alice.testnet", START);
        c.faucet();
        call_yocto("alice.testnet", START + PERIOD);
        assert!(c.storage_unregister(Some(true)));
        assert_eq!(c.ft_total_supply(), U128(0));
        assert_eq!(c.faucet_status(account("alice.testnet")).next_at, 0);
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"ft_burn\"")));
        assert!(c.storage_balance_of(account("alice.testnet")).is_none());
    }

    #[test]
    fn metadata_is_what_was_deployed() {
        let c = deploy();
        let m = c.ft_metadata();
        assert_eq!(m.spec, FT_METADATA_SPEC);
        assert_eq!(m.symbol, "USDC");
        assert_eq!(m.decimals, 6);
        assert!(m.icon.unwrap().starts_with("data:"));
    }

    #[test]
    fn booster_token_with_18_decimals_and_no_icon() {
        call("owner.testnet", START);
        let c = Contract::new(
            account("owner.testnet"),
            "Parry Boost".into(),
            "BOOST".into(),
            18,
            None,
            U128(10u128.pow(18)),
            3_600,
        );
        assert_eq!(c.ft_metadata().decimals, 18);
        assert!(c.ft_metadata().icon.is_none());
    }

    #[test]
    #[should_panic(expected = "icon must be a data URL")]
    fn remote_icon_is_refused() {
        call("owner.testnet", START);
        Contract::new(
            account("owner.testnet"),
            "X".into(),
            "X".into(),
            6,
            Some("https://example.com/x.png".into()),
            U128(1),
            1,
        );
    }

    #[test]
    #[should_panic(expected = "decimals must be at most 24")]
    fn too_many_decimals_are_refused() {
        call("owner.testnet", START);
        Contract::new(account("owner.testnet"), "X".into(), "X".into(), 25, None, U128(1), 1);
    }
}
