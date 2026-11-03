//! # Parry accounts factory
//!
//! Creates protected accounts as NEP-655 universal accounts (`0u...`). An account's address is
//! the hash of its initial state: the protected-account code by global code hash (immutable, so
//! nobody can swap a person's code underneath them), and `STATE` holding the owner, the network
//! and the protocol contracts. The same owner always maps to the same address, which the app
//! computes before anything exists (`account_id_of`).
//!
//! `create_account` sends one batch to that address: the state init, the attached NEAR, and
//! `bootstrap` (storage registrations with the protocol). A relayer usually pays, so a person
//! with a passkey and no NEAR gets a working account. If the batch fails, the runtime refunds the
//! deposit to this factory and `on_created` pays it back to whoever attached it (or records it
//! for `claim_refund` when the refund has not landed yet).

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128};
use near_sdk::universal_state_init::{UniversalStateInit, UniversalStateInitV1};
use near_sdk::{env, near, require, AccountId, Gas, GlobalContractId, NearToken, PanicOnDefault, Promise};
use parry_common::protocol::{AccountCore, Owner, Protocol};

/// Storage of the account itself plus its registrations with lending, the exchange and tokens.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(250);
const GAS_BOOTSTRAP: Gas = Gas::from_tgas(100);
const GAS_CHECK: Gas = Gas::from_tgas(5);
const GAS_AFTER: Gas = Gas::from_tgas(15);
/// Liquid NEAR the factory keeps when refunding a failed creation at once.
const REFUND_RESERVE: NearToken = NearToken::from_millinear(100);

#[near(event_json(standard = "parry-accounts"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    AccountCreated { account: &'a AccountId, owner: &'a Owner, deposit: U128, payer: &'a AccountId },
    #[event_version("1.0.0")]
    AccountCreationFailed { account: &'a AccountId },
    #[event_version("1.0.0")]
    DepositRefunded { payer: &'a AccountId, amount: U128, claimable: bool },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Accounts {
    owner: AccountId,
    network: String,
    protocol: Protocol,
    account_code: Base58CryptoHash,
    created: u64,
    refunds: near_sdk::store::LookupMap<AccountId, u128>,
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub owner: AccountId,
    pub network: String,
    pub protocol: Protocol,
    pub account_code: Base58CryptoHash,
    pub created: u64,
    pub min_deposit: U128,
}

#[near]
impl Accounts {
    #[init]
    pub fn new(
        owner: AccountId,
        network: String,
        protocol: Protocol,
        account_code: Base58CryptoHash,
    ) -> Self {
        require!(network == "testnet" || network == "mainnet", "network must be testnet or mainnet");
        Self {
            owner,
            network,
            protocol,
            account_code,
            created: 0,
            refunds: near_sdk::store::LookupMap::new(b"r"),
        }
    }

    /// Changes the code or protocol new accounts are born with, before the first account exists.
    /// Both are part of every address, so changing them later would move every owner to a new,
    /// empty address; existing accounts upgrade through their owner instead.
    #[payable]
    pub fn configure(&mut self, account_code: Option<Base58CryptoHash>, protocol: Option<Protocol>) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        near_sdk::assert_one_yocto();
        require!(self.created == 0, "accounts exist: their addresses commit to the code and protocol");
        if let Some(c) = account_code {
            self.account_code = c;
        }
        if let Some(p) = protocol {
            self.protocol = p;
        }
    }

    /// The address of the account a passkey (`p256:<base58>` or 66 hex characters, compressed)
    /// or a NEAR account owns.
    pub fn account_id_of(&self, passkey: Option<String>, near_account: Option<AccountId>) -> AccountId {
        self.state_init(&owner_from(passkey, near_account)).derive_account_id()
    }

    /// The raw state init behind `account_id_of`, so a client can check the address itself.
    pub fn state_init_of(&self, passkey: Option<String>, near_account: Option<AccountId>) -> Base64VecU8 {
        Base64VecU8(self.state_init(&owner_from(passkey, near_account)).to_raw().0)
    }

    pub fn config(&self) -> FactoryConfig {
        FactoryConfig {
            owner: self.owner.clone(),
            network: self.network.clone(),
            protocol: self.protocol.clone(),
            account_code: self.account_code,
            created: self.created,
            min_deposit: U128(MIN_DEPOSIT.as_yoctonear()),
        }
    }

    /// Creates (or tops up) the account of the given owner with the attached NEAR and registers
    /// it with the protocol. Anyone may pay; the relayer does for people without NEAR.
    #[payable]
    pub fn create_account(&mut self, passkey: Option<String>, near_account: Option<AccountId>) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "attach at least 0.25 NEAR");
        let owner = owner_from(passkey, near_account);
        let init = self.state_init(&owner);
        let account = init.derive_account_id();
        Promise::new(account.clone())
            .universal_state_init(init, NearToken::from_yoctonear(0))
            .transfer(deposit)
            .function_call("bootstrap", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_BOOTSTRAP)
            // The batch's result is its last action's: a plain view keeps it independent of the
            // registrations `bootstrap` starts, so a failure here means the batch reverted.
            .function_call("version", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_CHECK)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER).on_created(
                account,
                owner,
                env::predecessor_account_id(),
                U128(deposit.as_yoctonear()),
            ))
    }

    #[private]
    pub fn on_created(
        &mut self,
        account: AccountId,
        owner: Owner,
        payer: AccountId,
        deposit: U128,
    ) -> Option<AccountId> {
        if parry_common::promise_bytes(0).is_some() {
            self.created += 1;
            Event::AccountCreated { account: &account, owner: &owner, deposit, payer: &payer }.emit();
            return Some(account);
        }
        Event::AccountCreationFailed { account: &account }.emit();
        // The runtime's refund of the failed batch may land after this callback; pay at once only
        // when the factory can already cover it.
        let free = env::account_balance()
            .as_yoctonear()
            .saturating_sub(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
        if free >= deposit.0 + REFUND_RESERVE.as_yoctonear() {
            Event::DepositRefunded { payer: &payer, amount: deposit, claimable: false }.emit();
            Promise::new(payer).transfer(NearToken::from_yoctonear(deposit.0)).detach();
        } else {
            Event::DepositRefunded { payer: &payer, amount: deposit, claimable: true }.emit();
            let prev = self.refunds.get(&payer).copied().unwrap_or(0);
            self.refunds.insert(payer, prev + deposit.0);
        }
        None
    }

    /// Pays the caller the deposits of its failed creations that could not be refunded at once.
    pub fn claim_refund(&mut self) -> Promise {
        let payer = env::predecessor_account_id();
        let amount = self.refunds.remove(&payer).unwrap_or(0);
        require!(amount > 0, "nothing to refund");
        Promise::new(payer).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn refund_of(&self, account_id: AccountId) -> U128 {
        U128(self.refunds.get(&account_id).copied().unwrap_or(0))
    }

    /// Sends NEAR the factory holds beyond its storage to the owner (fees never accrue here,
    /// but refunds of failed batches can land after their callback paid out of free balance).
    #[payable]
    pub fn sweep(&mut self, amount: U128) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        near_sdk::assert_one_yocto();
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }
}

impl Accounts {
    fn state_init(&self, owner: &Owner) -> UniversalStateInit {
        let core = AccountCore {
            owner: owner.clone(),
            network: self.network.clone(),
            protocol: self.protocol.clone(),
        };
        let state =
            near_sdk::borsh::to_vec(&core).unwrap_or_else(|_| env::panic_str("state encoding failed"));
        UniversalStateInit::V1(
            UniversalStateInitV1::default()
                .with_code(GlobalContractId::CodeHash(self.account_code.into()))
                .with_data_entry(b"STATE".to_vec(), state),
        )
    }
}

fn owner_from(passkey: Option<String>, near_account: Option<AccountId>) -> Owner {
    match (passkey, near_account) {
        (Some(k), None) => Owner::Passkey { key: parse_p256(&k) },
        (None, Some(a)) => Owner::Near { account_id: a },
        _ => env::panic_str("give exactly one of passkey or near_account"),
    }
}

/// `p256:<base58>` or 66 hex characters, a compressed P-256 public key.
fn parse_p256(key: &str) -> Vec<u8> {
    let bytes = match key.strip_prefix("p256:") {
        Some(b58) => near_sdk::bs58::decode(b58).into_vec().unwrap_or_default(),
        None if key.len() == 66 => {
            (0..66).step_by(2).filter_map(|i| u8::from_str_radix(&key[i..i + 2], 16).ok()).collect()
        }
        None => vec![],
    };
    require!(bytes.len() == 33 && (bytes[0] == 2 || bytes[0] == 3), "passkey must be a compressed P-256 key");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use parry_common::protocol::TokenConfig;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn protocol() -> Protocol {
        Protocol {
            lending: id("lending.parry.testnet"),
            oracle: id("oracle.parry.testnet"),
            dex: id("ref-finance-101.testnet"),
            risk: id("risk.parry.testnet"),
            signer: id("v1.signer-prod.testnet"),
            factory: id("accounts.parry.testnet"),
            tokens: vec![TokenConfig {
                token_id: id("wrap.testnet"),
                symbol: "wNEAR".into(),
                decimals: 24,
                extra_decimals: 0,
                price_id: parry_common::pyth::NEAR_USD.into(),
                rate_call: None,
                mark: Some("NEAR".into()),
            }],
        }
    }

    const KEY: &str = "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc";

    fn setup(predecessor: &str, deposit: NearToken) -> Accounts {
        testing_env!(VMContextBuilder::new()
            .current_account_id(id("accounts.parry.testnet"))
            .predecessor_account_id(id(predecessor))
            .attached_deposit(deposit)
            .build());
        Accounts::new(id("parry.testnet"), "testnet".into(), protocol(), Base58CryptoHash::from([7u8; 32]))
    }

    #[test]
    fn addresses_are_deterministic_and_distinct() {
        let f = setup("anyone.testnet", NearToken::from_yoctonear(0));
        let a = f.account_id_of(Some(KEY.into()), None);
        assert!(a.as_str().starts_with("0u"), "{a}");
        assert_eq!(a, f.account_id_of(Some(KEY.into()), None));
        let b58 = format!("p256:{}", near_sdk::bs58::encode(hex_decode(KEY)).into_string());
        assert_eq!(a, f.account_id_of(Some(b58), None));
        let n = f.account_id_of(None, Some(id("alice.testnet")));
        assert_ne!(a, n);
        assert_ne!(n, f.account_id_of(None, Some(id("bob.testnet"))));
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn creation_sends_one_batch_to_the_derived_address() {
        let mut f = setup("relayer.parry.testnet", NearToken::from_millinear(300));
        let want = f.account_id_of(None, Some(id("alice.testnet")));
        let _ = f.create_account(None, Some(id("alice.testnet")));
        let receipts = get_created_receipts();
        assert_eq!(receipts[0].receiver_id, want);
        assert_eq!(receipts[1].receiver_id, id("accounts.parry.testnet"));
    }

    #[test]
    #[should_panic(expected = "attach at least 0.25 NEAR")]
    fn creation_needs_a_deposit() {
        let mut f = setup("relayer.parry.testnet", NearToken::from_millinear(100));
        let _ = f.create_account(None, Some(id("alice.testnet")));
    }

    #[test]
    #[should_panic(expected = "exactly one of passkey or near_account")]
    fn exactly_one_owner() {
        let f = setup("anyone.testnet", NearToken::from_yoctonear(0));
        f.account_id_of(Some(KEY.into()), Some(id("alice.testnet")));
    }

    #[test]
    #[should_panic(expected = "compressed P-256")]
    fn bad_passkey() {
        let f = setup("anyone.testnet", NearToken::from_yoctonear(0));
        f.account_id_of(Some("04abcd".into()), None);
    }

    #[test]
    fn configuration_is_frozen_once_accounts_exist() {
        let mut f = setup("parry.testnet", NearToken::from_yoctonear(1));
        f.configure(Some(Base58CryptoHash::from([9u8; 32])), None);
        assert_eq!(f.config().account_code, Base58CryptoHash::from([9u8; 32]));
        f.created = 1;
        let r =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.configure(None, Some(protocol()))));
        assert!(r.is_err());
    }

    #[test]
    fn failed_creation_is_refunded_or_claimable() {
        let mut f = setup("relayer.parry.testnet", NearToken::from_yoctonear(0));
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(id("accounts.parry.testnet"))
                .predecessor_account_id(id("accounts.parry.testnet"))
                .account_balance(NearToken::from_millinear(10))
                .build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        let owner = Owner::Near { account_id: id("alice.testnet") };
        let r = f.on_created(
            id("0uabc.testnet"),
            owner,
            id("relayer.parry.testnet"),
            U128(300_000_000_000_000_000_000_000),
        );
        assert!(r.is_none());
        assert!(get_logs().iter().any(|l| l.contains("\"claimable\":true")));
        assert_eq!(f.refund_of(id("relayer.parry.testnet")).0, 300_000_000_000_000_000_000_000);
        assert_eq!(f.created, 0);
    }
}
