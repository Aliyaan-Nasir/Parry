//! # Parry protected account
//!
//! Every person's account runs this contract, referenced by global code hash from a NEP-655
//! universal account (`0u...`) whose address commits to the code and to the initial state: the
//! owner, the network and the protocol contracts. There are no access keys and no seed phrase.
//!
//! - **Owner.** A passkey (`owner_execute` checks a WebAuthn P-256 assertion on chain) or a NEAR
//!   account (`owner_call`, with one yoctoNEAR attached, which only a full-access key can attach).
//!   The owner can do anything: lend and borrow on Rhea, move funds, sign with Chain Signatures,
//!   set or revoke the guardian's mandate, pause the guardian, upgrade the code.
//! - **Guardian.** `guardian_execute` runs one protective action signed by the enclave key named
//!   in the mandate, and only within it: the powers it grants, the token reserve and daily caps,
//!   the daily action count, the expiry, the Hyperliquid and EVM guards. Each action carries the
//!   hash of the AI review that approved it, emitted in the `guardian_acted` event. No guardian
//!   action can send funds to another account: repays and collateral go to the protocol's lending
//!   contract, swap legs go through the protocol's exchange and come back here, Hyperliquid orders
//!   are reduce-only or hedge-side inside a price band and size cap, and EVM transactions can only
//!   approve or repay the guard's pool for the person's own address.
//! - **Deleverage.** Withdraw collateral, swap it, repay, check health: a promise chain in
//!   `guardian.rs` where every failed step restores the position.
//! - **Exits.** `close_rhea` sells collateral on the exchange to repay all debt and takes the rest
//!   back; `unwind` revokes the guardian and sends everything to the owner (`close.rs`).

pub mod close;
mod guardian;
pub mod passkey;
#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
use near_sdk::serde_json;
use near_sdk::{
    env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
};
use parry_common::hyperliquid::{order_digest, HlOrder};
use parry_common::mandate::{GuardianAction, Mandate, Power, Trigger};
use parry_common::math::pow10;
use parry_common::protocol::{AccountCore, Owner, Protocol, PATH_EVM, PATH_HYPERLIQUID};
use parry_common::{now_secs, rhea, wire, ONE_YOCTO};

pub const VERSION: u32 = 1;
/// Owner requests are valid from 10 minutes before to 5 minutes after `created_at`.
pub const REQUEST_WINDOW_SECS: u64 = 600;
pub const REQUEST_SKEW_SECS: u64 = 300;
const REQUEST_DOMAIN: &[u8] = b"parry-account:v1:";

const GAS_TOKEN_CALL: Gas = Gas::from_tgas(60);
const GAS_LENDING_PRICED: Gas = Gas::from_tgas(120);
const GAS_SIMPLE: Gas = Gas::from_tgas(15);
/// Static gas of each storage registration; unused gas of the call is shared among them too.
const GAS_REGISTER: Gas = Gas::from_tgas(6);
const GAS_SIGN: Gas = Gas::from_tgas(60);
const GAS_AFTER_SIGN: Gas = Gas::from_tgas(10);

/// Storage the protocol contracts want from a new account.
const LENDING_STORAGE: NearToken = NearToken::from_millinear(100);
const DEX_STORAGE: NearToken = NearToken::from_millinear(50);
/// Registration-only storage deposits refund what the token does not need.
const TOKEN_STORAGE: NearToken = NearToken::from_millinear(5);

/// What the owner can do.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum OwnerAction {
    SetMandate {
        mandate: Mandate,
    },
    RevokeMandate,
    /// Stops guardian actions until `until` (seconds); 0 resumes.
    PauseGuardian {
        until: u64,
    },
    /// Forgets a deleverage or a close that is stuck after the owner has settled it by hand.
    ClearPending,
    /// Supplies `amount` of `token` to lending as collateral.
    Supply {
        token: AccountId,
        amount: U128,
    },
    /// Borrows `amount` of `token` (token units) and withdraws it here.
    Borrow {
        token: AccountId,
        amount: U128,
    },
    Repay {
        token: AccountId,
        amount: U128,
    },
    /// Withdraws `amount` (token units) from lending supply or collateral.
    Withdraw {
        token: AccountId,
        amount: U128,
    },
    Call {
        receiver_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        deposit: U128,
        gas: U64,
    },
    Transfer {
        receiver_id: AccountId,
        amount: U128,
    },
    FtTransfer {
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
    },
    /// Signs a 32-byte hash (hex) with Chain Signatures at `path`. Must be the only action.
    MpcSign {
        path: String,
        payload: String,
        domain_id: u32,
    },
    /// Signs the owner's own Hyperliquid order (no guard: the owner may trade freely). Must be
    /// the only action.
    HlOrder {
        order: HlOrder,
        nonce: u64,
    },
    /// Moves the account to another published global code hash.
    Upgrade {
        code_hash: Base58CryptoHash,
    },
    /// Closes the whole lending position through the exchange pool `pool_id`: sells just enough
    /// collateral (priced by the oracle, plus `slippage_bps`) to repay all debt, then withdraws the
    /// rest. A position whose health cannot let that much collateral out closes over several
    /// calls (`close_progress`). Must be the only action.
    CloseRhea {
        slippage_bps: u16,
        pool_id: u64,
    },
    /// Revokes the mandate, withdraws every lending position, and sends each listed token's
    /// balance and the NEAR above the storage reserve to `to` (the NEAR-account owner when
    /// omitted; required for a passkey owner). Must be the only action.
    Unwind {
        tokens: Vec<AccountId>,
        to: Option<AccountId>,
    },
}

/// What a passkey signs, as exact JSON text.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OwnerRequest {
    pub account: AccountId,
    pub network: String,
    pub nonce: u64,
    pub created_at: u64,
    pub actions: Vec<OwnerAction>,
}

/// A signature from Chain Signatures in EVM form.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmSignature {
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

/// A deleverage in flight.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub id: u64,
    pub guardian_nonce: u64,
    pub collateral: AccountId,
    /// Token units.
    pub amount: U128,
    pub pool_id: u64,
    pub debt: AccountId,
    pub min_out: U128,
    /// Debt tokens the swap produced.
    pub out: U128,
    pub stage: String,
    pub started_at: u64,
}

/// The mandate with its live counters, as `mandate()` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MandateView {
    pub mandate: Mandate,
    pub set_at: u64,
    pub paused_until: u64,
    pub expired: bool,
    /// Reserve spent per token since the mandate was set.
    pub spent: Vec<(AccountId, U128)>,
    /// Amount moved per token today (UTC).
    pub moved_today: Vec<(AccountId, U128)>,
    pub actions_today: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AccountStats {
    pub guardian_actions: u64,
    pub deleverages: u64,
    pub bootstrapped: bool,
}

/// Mutable state, kept under its own key so the factory's state init (`STATE`) holds only the
/// account's identity, which its address commits to.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Runtime {
    pub owner_nonce: u64,
    pub bootstrapped: bool,
    pub mandate: Option<Mandate>,
    pub mandate_set_at: u64,
    pub guardian_nonce: u64,
    pub paused_until: u64,
    /// Reserve spent per token since the mandate was set.
    pub spent: Vec<(AccountId, u128)>,
    /// Amount moved per token on `day`.
    pub day: u64,
    pub moved_today: Vec<(AccountId, u128)>,
    pub actions_today: u32,
    pub pending: Option<Pending>,
    pub deleverages: u64,
    pub guardian_actions: u64,
}

const RUNTIME_KEY: &[u8] = b"rt";

fn load_runtime() -> Runtime {
    env::storage_read(RUNTIME_KEY)
        .map(|b| near_sdk::borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("bad runtime state")))
        .unwrap_or_default()
}

fn save_runtime(r: &Runtime) {
    let bytes = near_sdk::borsh::to_vec(r).unwrap_or_else(|_| env::panic_str("runtime encoding failed"));
    env::storage_write(RUNTIME_KEY, &bytes);
}

#[near(event_json(standard = "parry-account"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    OwnerExecuted { nonce: u64, actions: u32 },
    #[event_version("1.0.0")]
    MandateSet { guardian_key: &'a str, powers: &'a [Power], expires_at: u64, sealed: bool },
    #[event_version("1.0.0")]
    MandateRevoked {},
    #[event_version("1.0.0")]
    GuardianPaused { until: u64 },
    #[event_version("1.0.0")]
    GuardianActed {
        nonce: u64,
        action: &'a str,
        review_hash: &'a str,
        trigger: &'a Trigger,
        token: Option<&'a AccountId>,
        amount: Option<U128>,
    },
    #[event_version("1.0.0")]
    GuardianSettled { nonce: u64, action: &'a str, used: U128, returned: U128 },
    #[event_version("1.0.0")]
    HyperliquidSigned { nonce: u64, kind: &'a str, digest: String },
    #[event_version("1.0.0")]
    EvmSigned { nonce: u64, kind: &'a str, hash: String, unsigned_tx: String },
    #[event_version("1.0.0")]
    DeleverageStage { id: u64, stage: &'a str },
    #[event_version("1.0.0")]
    DeleverageRolledBack { id: u64, stage: &'a str },
    #[event_version("1.0.0")]
    DeleverageCompleted { id: u64, repaid: U128, health_bps: Option<U128> },
    #[event_version("1.0.0")]
    DeleverageUnsafe { id: u64, health_bps: Option<U128>, floor_bps: u32 },
    #[event_version("1.0.0")]
    DeleverageStuck { id: u64, stage: &'a str },
    #[event_version("1.0.0")]
    Bootstrapped {},
    #[event_version("1.0.0")]
    Upgraded { code_hash: &'a Base58CryptoHash },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Account {
    core: AccountCore,
}

#[near]
impl Account {
    /// For a named-account deployment (tests, a sandbox). Universal accounts get their state
    /// from the factory's state init instead.
    #[init]
    pub fn new(owner: Owner, network: String, protocol: Protocol) -> Self {
        require!(network == "testnet" || network == "mainnet", "network must be testnet or mainnet");
        if let Owner::Passkey { key } = &owner {
            require!(
                key.len() == 33 && (key[0] == 2 || key[0] == 3),
                "passkey must be a compressed P-256 key"
            );
        }
        Self { core: AccountCore { owner, network, protocol } }
    }

    // -----------------------------------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------------------------------

    /// Runs a passkey-signed request. Anyone may relay it (the relayer pays the gas).
    #[payable]
    pub fn owner_execute(&mut self, request: String, assertion: passkey::Assertion) -> Option<Promise> {
        let Owner::Passkey { key } = &self.core.owner else {
            env::panic_str("this account is not passkey owned")
        };
        require!(
            passkey::verify(&request_digest(&request), &assertion, key),
            "passkey signature does not verify"
        );
        let r: OwnerRequest =
            serde_json::from_slice(request.as_bytes()).unwrap_or_else(|_| env::panic_str("bad request"));
        require!(r.account == env::current_account_id(), "request is for another account");
        require!(r.network == self.core.network, "request is for another network");
        let now = now_secs();
        require!(
            r.created_at + REQUEST_WINDOW_SECS >= now && r.created_at <= now + REQUEST_SKEW_SECS,
            "request expired or from the future"
        );
        let mut rt = load_runtime();
        require!(r.nonce > rt.owner_nonce, "request nonce already used");
        rt.owner_nonce = r.nonce;
        save_runtime(&rt);
        self.run_owner(r.nonce, r.actions)
    }

    /// Runs actions for a NEAR-account owner, called by that account with one yoctoNEAR
    /// attached (directly, or as a relayed NEP-366 meta transaction).
    #[payable]
    pub fn owner_call(&mut self, actions: Vec<OwnerAction>) -> Option<Promise> {
        let Owner::Near { account_id } = &self.core.owner else {
            env::panic_str("this account is passkey owned")
        };
        require!(&env::predecessor_account_id() == account_id, "owner only");
        near_sdk::assert_one_yocto();
        self.run_owner(0, actions)
    }

    fn run_owner(&mut self, nonce: u64, actions: Vec<OwnerAction>) -> Option<Promise> {
        require!(!actions.is_empty(), "no actions");
        let n = actions.len() as u32;
        let single = actions.iter().any(|a| {
            matches!(
                a,
                OwnerAction::MpcSign { .. }
                    | OwnerAction::HlOrder { .. }
                    | OwnerAction::CloseRhea { .. }
                    | OwnerAction::Unwind { .. }
            )
        });
        require!(!single || n == 1, "a signing, close or unwind action must be the only action");
        Event::OwnerExecuted { nonce, actions: n }.emit();
        let mut last: Option<Promise> = None;
        for a in actions {
            if let Some(p) = self.run_owner_action(a) {
                if let Some(prev) = last.replace(p) {
                    prev.detach();
                }
            }
        }
        last
    }

    fn run_owner_action(&mut self, action: OwnerAction) -> Option<Promise> {
        let p = self.core.protocol.clone();
        match action {
            OwnerAction::SetMandate { mandate } => {
                let now = now_secs();
                mandate.assert_valid(now);
                for l in &mandate.limits {
                    require!(
                        p.token(&l.token).is_some(),
                        "mandate limit for a token the protocol does not list"
                    );
                }
                let mut rt = load_runtime();
                require!(rt.pending.is_none(), "a deleverage is in flight");
                Event::MandateSet {
                    guardian_key: &mandate.guardian_key,
                    powers: &mandate.powers,
                    expires_at: mandate.expires_at,
                    sealed: mandate.sealed.is_some(),
                }
                .emit();
                rt.mandate = Some(mandate);
                rt.mandate_set_at = now;
                rt.spent.clear();
                rt.moved_today.clear();
                rt.actions_today = 0;
                save_runtime(&rt);
                None
            }
            OwnerAction::RevokeMandate => {
                let mut rt = load_runtime();
                rt.mandate = None;
                save_runtime(&rt);
                Event::MandateRevoked {}.emit();
                None
            }
            OwnerAction::PauseGuardian { until } => {
                let mut rt = load_runtime();
                rt.paused_until = until;
                save_runtime(&rt);
                Event::GuardianPaused { until }.emit();
                None
            }
            OwnerAction::ClearPending => {
                let mut rt = load_runtime();
                rt.pending = None;
                save_runtime(&rt);
                close::clear_closing();
                None
            }
            OwnerAction::Supply { token, amount } => {
                require!(p.token(&token).is_some(), "token not in the protocol");
                Some(ft_transfer_call(&token, &p.lending, amount.0, rhea::MSG_ONLY_INCREASE_COLLATERAL))
            }
            OwnerAction::Borrow { token, amount } => {
                let t = p.token(&token).unwrap_or_else(|| env::panic_str("token not in the protocol"));
                let inner = amount.0 * pow10(t.extra_decimals as u32);
                Some(Promise::new(p.lending.clone()).function_call(
                    "execute_with_pyth",
                    rhea::borrow_and_withdraw_args(&token, inner),
                    ONE_YOCTO,
                    GAS_LENDING_PRICED,
                ))
            }
            OwnerAction::Repay { token, amount } => {
                require!(p.token(&token).is_some(), "token not in the protocol");
                Some(ft_transfer_call(&token, &p.lending, amount.0, rhea::MSG_ONLY_REPAY))
            }
            OwnerAction::Withdraw { token, amount } => {
                let t = p.token(&token).unwrap_or_else(|| env::panic_str("token not in the protocol"));
                let inner = amount.0 * pow10(t.extra_decimals as u32);
                Some(Promise::new(p.lending.clone()).function_call(
                    "simple_withdraw",
                    rhea::simple_withdraw_args(&token, inner),
                    ONE_YOCTO,
                    GAS_LENDING_PRICED,
                ))
            }
            OwnerAction::Call { receiver_id, method_name, args, deposit, gas } => {
                Some(Promise::new(receiver_id).function_call(
                    method_name,
                    args.0,
                    NearToken::from_yoctonear(deposit.0),
                    Gas::from_gas(gas.0),
                ))
            }
            OwnerAction::Transfer { receiver_id, amount } => {
                Some(Promise::new(receiver_id).transfer(NearToken::from_yoctonear(amount.0)))
            }
            OwnerAction::FtTransfer { token, receiver_id, amount } => {
                Some(Promise::new(token).function_call(
                    "ft_transfer",
                    wire::ft_transfer(&receiver_id, amount.0),
                    ONE_YOCTO,
                    GAS_SIMPLE,
                ))
            }
            OwnerAction::MpcSign { path, payload, domain_id } => {
                let bytes = hex::decode(&payload).unwrap_or_default();
                require!(domain_id == 0 && bytes.len() == 32, "payload must be a 32-byte hash for domain 0");
                Some(
                    self.mpc_sign(&path, &payload).then(
                        Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_SIGN).on_signed(),
                    ),
                )
            }
            OwnerAction::HlOrder { order, nonce } => {
                let digest = order_digest(&order, nonce, self.core.network == "mainnet");
                Event::HyperliquidSigned { nonce, kind: "owner", digest: hex::encode(digest) }.emit();
                Some(
                    self.mpc_sign(PATH_HYPERLIQUID, &hex::encode(digest)).then(
                        Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_SIGN).on_signed(),
                    ),
                )
            }
            OwnerAction::Upgrade { code_hash } => {
                Event::Upgraded { code_hash: &code_hash }.emit();
                Some(Promise::new(env::current_account_id()).use_global_contract(code_hash))
            }
            OwnerAction::CloseRhea { slippage_bps, pool_id } => Some(self.start_close(slippage_bps, pool_id)),
            OwnerAction::Unwind { tokens, to } => Some(self.start_unwind(tokens, to)),
        }
    }

    /// Registers the account with the lending contract, the exchange and every protocol token,
    /// paid from the account's own balance. The factory calls it right after creation; anyone may
    /// call it, and it does nothing once done.
    pub fn bootstrap(&mut self) -> Option<Promise> {
        let mut rt = load_runtime();
        if rt.bootstrapped {
            return None;
        }
        rt.bootstrapped = true;
        save_runtime(&rt);
        Event::Bootstrapped {}.emit();
        let me = env::current_account_id();
        let p = &self.core.protocol;
        let deposit = |to: &AccountId, amount: NearToken, registration_only: bool| {
            Promise::new(to.clone()).function_call_weight(
                "storage_deposit",
                wire::storage_deposit(&me, registration_only),
                amount,
                GAS_REGISTER,
                GasWeight(1),
            )
        };
        for t in &p.tokens {
            deposit(&t.token_id, TOKEN_STORAGE, true).detach();
        }
        deposit(&p.lending, LENDING_STORAGE, false).detach();
        Some(deposit(&p.dex, DEX_STORAGE, false).then(Promise::new(p.dex.clone()).function_call_weight(
            "register_tokens",
            wire::register_tokens(p.tokens.iter().map(|t| &t.token_id)),
            ONE_YOCTO,
            GAS_REGISTER,
            GasWeight(1),
        )))
    }

    fn mpc_sign(&self, path: &str, payload_hex: &str) -> Promise {
        Promise::new(self.core.protocol.signer.clone()).function_call_weight(
            "sign",
            wire::mpc_sign(path, payload_hex),
            ONE_YOCTO,
            GAS_SIGN,
            GasWeight(1),
        )
    }

    #[private]
    pub fn on_signed(#[callback_result] r: Result<SignatureResponse, PromiseError>) -> EvmSignature {
        to_evm_signature(r)
    }

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    pub fn version(&self) -> u32 {
        VERSION
    }

    pub fn owner(&self) -> Owner {
        self.core.owner.clone()
    }

    pub fn network(&self) -> String {
        self.core.network.clone()
    }

    pub fn protocol(&self) -> Protocol {
        self.core.protocol.clone()
    }

    /// The mandate with its live counters.
    pub fn mandate(&self) -> Option<MandateView> {
        let rt = load_runtime();
        let today = parry_common::day_of(now_secs());
        let current = rt.day == today;
        let pairs = |v: &[(AccountId, u128)]| -> Vec<(AccountId, U128)> {
            v.iter().map(|(t, a)| (t.clone(), U128(*a))).collect()
        };
        rt.mandate.clone().map(|m| MandateView {
            expired: m.expires_at <= now_secs(),
            mandate: m,
            set_at: rt.mandate_set_at,
            paused_until: rt.paused_until,
            spent: pairs(&rt.spent),
            moved_today: if current { pairs(&rt.moved_today) } else { vec![] },
            actions_today: if current { rt.actions_today } else { 0 },
        })
    }

    pub fn nonces(&self) -> (u64, u64) {
        let rt = load_runtime();
        (rt.owner_nonce, rt.guardian_nonce)
    }

    pub fn pending(&self) -> Option<Pending> {
        load_runtime().pending
    }

    pub fn stats(&self) -> AccountStats {
        let rt = load_runtime();
        AccountStats {
            guardian_actions: rt.guardian_actions,
            deleverages: rt.deleverages,
            bootstrapped: rt.bootstrapped,
        }
    }

    /// Chain Signatures paths: Hyperliquid and EVM.
    pub fn signing_paths(&self) -> (String, String) {
        (PATH_HYPERLIQUID.to_string(), PATH_EVM.to_string())
    }
}

/// SHA-256 of the domain-separated request, the WebAuthn challenge.
pub fn request_digest(request: &str) -> [u8; 32] {
    let mut data = REQUEST_DOMAIN.to_vec();
    data.extend_from_slice(request.as_bytes());
    env::sha256_array(&data)
}

pub(crate) fn ft_transfer_call(token: &AccountId, receiver: &AccountId, amount: u128, msg: &str) -> Promise {
    Promise::new(token.clone()).function_call(
        "ft_transfer_call",
        wire::ft_transfer_call(receiver, amount, msg),
        ONE_YOCTO,
        GAS_TOKEN_CALL,
    )
}

pub(crate) fn to_evm_signature(r: Result<SignatureResponse, PromiseError>) -> EvmSignature {
    let r = r.unwrap_or_else(|_| env::panic_str("signature request failed"));
    require!(r.scheme == "Secp256k1" && r.big_r.affine_point.len() == 66, "unexpected signature");
    EvmSignature { r: r.big_r.affine_point[2..].to_string(), s: r.s.scalar, v: r.recovery_id + 27 }
}

/// Helper so the guardian module can reach the action type without a long path.
pub(crate) type Action = GuardianAction;
