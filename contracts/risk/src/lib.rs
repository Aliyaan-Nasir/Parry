//! # Parry risk board
//!
//! The on-chain record of what Parry's enclave sees and decides. The enclave (a program in a
//! TEE whose ed25519 key never leaves it) signs each report; anyone may relay it with `submit`,
//! and the board accepts it only if the signature verifies against the current enclave key, its
//! run id is new for its kind, and its observation time is recent. Five kinds exist:
//!
//! - `risk_update`: the latest risk of every monitored position, and the marks behind it.
//! - `vault_report`: the vault's risk score, hedge and proof-of-reserves summary. A report for
//!   the configured vault is forwarded to it (`on_vault_report`), and the vault trusts only this
//!   contract, so the enclave signature is the vault's only source of risk input.
//! - `decision`: a guardian decision with the hashes of its action envelope and model review.
//! - `sealing_key`: the enclave's X25519 key that sealed mandates are encrypted to.
//! - `certificate`: the anchor of a health certificate (its hash, reader and expiry), so anyone
//!   handed the certificate can check on chain that the enclave issued it.
//!
//! Every history is bounded and evicts its oldest entries (storage included), so the board's
//! storage cost has a ceiling: that includes the accounts with stored positions, of which the
//! board keeps the `MAX_ACCOUNTS` most recently added. The enclave key history is kept whole,
//! so a record signed before a key rotation can still be checked against the key that signed
//! it (`key_index`).

mod report;
mod ring;

pub use report::*;
pub use ring::Ring;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, serde_json, AccountId, BorshStorageKey, CurveType,
    Gas, NearToken, PanicOnDefault, PublicKey,
};

/// Reports older than this (by `at`) are refused: a relayer cannot hold a report back and
/// publish it once it no longer describes the market.
pub const MAX_REPORT_AGE_SECS: u64 = 600;
/// Clock skew allowed between the enclave and the chain.
pub const MAX_REPORT_FUTURE_SECS: u64 = 60;
/// Upper bound on the signed JSON, which keeps hashing and parsing gas predictable.
pub const MAX_REPORT_BYTES: usize = 64 * 1024;
pub const VAULT_HISTORY: u64 = 300;
pub const DECISION_HISTORY: u64 = 500;
/// Certificate anchors kept; a new one beyond this evicts the oldest.
pub const CERTIFICATE_HISTORY: u64 = 10_000;
pub const DECISIONS_PER_ACCOUNT: usize = 50;
/// Positions kept per account; a new one beyond this evicts the least recently updated.
pub const POSITIONS_PER_ACCOUNT: usize = 16;
/// Accounts with stored positions; a new one beyond this evicts the account first stored.
pub const MAX_ACCOUNTS: u64 = 5_000;
/// Distinct assets with a mark. A new asset beyond this is refused: it can only be a
/// configuration mistake, and evicting a live mark to make room would hide one.
pub const MAX_ASSETS: u32 = 64;
pub const MAX_NOTE_CHARS: usize = 280;
pub const DEFAULT_PAGE: u32 = 50;
pub const MAX_PAGE: u32 = 100;
/// Gas for the vault's `on_vault_report`; the relayer's `submit` must carry it on top.
pub const VAULT_CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    EnclaveKeys,
    Positions,
    Marks,
    VaultReports,
    Decisions,
    DecisionIds,
    DecisionsByAccount,
    TrackedAccounts,
    Certificates,
    CertificateIds,
}

/// Raw storage key holding the state layout version, written by `migrate`.
const LAYOUT_KEY: &[u8] = b"layout";
const LAYOUT_VERSION: u8 = 2;

/// What the vault exposes to the board.
#[ext_contract(ext_vault)]
pub trait VaultReceiver {
    fn on_vault_report(&mut self, report_json: String);
}

/// An enclave signing key, as set by the owner.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnclaveKey {
    /// Position in the key history (0 is the key the board was created with).
    pub index: u32,
    /// `ed25519:<base58>`.
    pub public_key: String,
    /// SHA-256 of the enclave program the key is bound to.
    pub wasm_sha256: Hex32,
    /// Block time (unix seconds) from which this key signs.
    pub since: u64,
    pub note: String,
}

/// A stored report and the index of the enclave key that signed it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record<T> {
    pub report: T,
    pub key_index: u32,
}

/// The latest risk of one position.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionRecord {
    pub account: AccountId,
    pub venue: String,
    pub position: String,
    pub score: u8,
    pub tier: Tier,
    pub health_bps: u32,
    pub ttl_secs: u64,
    pub p24_bps: u32,
    /// Run id and observation time of the report that set it.
    pub run_id: u64,
    pub at: u64,
}

/// The latest mark of one asset.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    pub asset: String,
    pub asset_index: u32,
    pub price_e8: U128,
    pub at: u64,
}

/// The enclave's current sealing key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealingKey {
    pub public_key: Hex32,
    pub run_id: u64,
    pub at: u64,
    pub key_index: u32,
}

/// The last accepted run id of each kind (0 before the first).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LastRunIds {
    pub risk_update: u64,
    pub vault_report: u64,
    pub decision: u64,
    pub sealing_key: u64,
    pub certificate: u64,
}

impl LastRunIds {
    fn get(&self, kind: Kind) -> u64 {
        match kind {
            Kind::RiskUpdate => self.risk_update,
            Kind::VaultReport => self.vault_report,
            Kind::Decision => self.decision,
            Kind::SealingKey => self.sealing_key,
            Kind::Certificate => self.certificate,
        }
    }

    fn set(&mut self, kind: Kind, run_id: u64) {
        let slot = match kind {
            Kind::RiskUpdate => &mut self.risk_update,
            Kind::VaultReport => &mut self.vault_report,
            Kind::Decision => &mut self.decision,
            Kind::SealingKey => &mut self.sealing_key,
            Kind::Certificate => &mut self.certificate,
        };
        *slot = run_id;
    }
}

/// Totals since deployment (not just what the bounded histories still hold).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub risk_updates: u64,
    pub vault_reports: u64,
    pub decisions: u64,
    /// Accounts with at least one stored position risk.
    pub accounts_tracked: u64,
    pub certificates: u64,
}

/// A health certificate's anchor, as `certificate(hash)` returns it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertificateRecord {
    pub hash: Hex32,
    pub reader: String,
    pub expires_at: u64,
    /// When the enclave issued it (the report's `at`).
    pub at: u64,
    /// The enclave key that signed the anchor.
    pub key_index: u32,
}

/// A stored vault report: slots written before the report carried the hedge ratio hold the
/// shorter layout, and both read as `Record<VaultReport>`. The two layouts never parse as each
/// other: the longer one needs at least three more bytes than the shorter one holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredVaultReport(pub Record<VaultReport>);

impl near_sdk::borsh::BorshSerialize for StoredVaultReport {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        near_sdk::borsh::BorshSerialize::serialize(&self.0, writer)
    }
}

impl near_sdk::borsh::BorshDeserialize for StoredVaultReport {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        if let Ok(r) = near_sdk::borsh::from_slice::<Record<VaultReport>>(&bytes) {
            return Ok(Self(r));
        }
        let r: Record<VaultReportV1> = near_sdk::borsh::from_slice(&bytes)?;
        Ok(Self(Record { report: r.report.into(), key_index: r.key_index }))
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub owner_id: AccountId,
    pub vault: Option<AccountId>,
}

/// NEP-297 events, standard `parry-risk`. Every field is bounded in size.
#[near(event_json(standard = "parry-risk"))]
pub enum Event {
    /// Counts only: the positions and marks themselves are in the board's state.
    #[event_version("1.0.0")]
    RiskUpdated { run_id: u64, positions: u32, marks: u32 },
    #[event_version("1.0.0")]
    VaultReported { run_id: u64, vault: AccountId, score: u8, ratio_bps: u32, forwarded: bool },
    #[event_version("1.0.0")]
    DecisionRecorded { id: Hex32, account: AccountId, action: String, verdict: Verdict, review_hash: Hex32 },
    #[event_version("1.0.0")]
    SealingKeyPublished { run_id: u64, public_key: Hex32 },
    #[event_version("1.0.0")]
    EnclaveChanged { index: u32, public_key: String, wasm_sha256: Hex32 },
    #[event_version("1.0.0")]
    CertificateAnchored { hash: Hex32, reader: String, expires_at: u64 },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    vault: Option<AccountId>,
    /// Raw bytes of the current enclave key, so `submit` never parses the string form.
    enclave_pk: [u8; 32],
    enclave_keys: Vector<EnclaveKey>,
    last_run_ids: LastRunIds,
    stats: Stats,
    /// Per account, its positions, least recently updated first.
    positions: LookupMap<AccountId, Vec<PositionRecord>>,
    /// The accounts in `positions`, in the order they were first stored, so the oldest can be
    /// evicted once `MAX_ACCOUNTS` hold positions.
    tracked: Ring<AccountId>,
    marks: IterableMap<String, Mark>,
    vault_reports: Ring<StoredVaultReport>,
    decisions: LookupMap<Hex32, Record<Decision>>,
    /// Ids of the decisions kept, in arrival order; evicting one removes its record.
    decision_ids: Ring<Hex32>,
    /// Per account, the ids of its newest decisions, oldest first.
    decisions_by_account: LookupMap<AccountId, Vec<Hex32>>,
    sealing_key: Option<SealingKey>,
    certificates: LookupMap<Hex32, CertificateRecord>,
    /// Hashes of the certificate anchors kept, in arrival order; evicting one removes its record.
    certificate_ids: Ring<Hex32>,
}

/// The run ids as the board stored them before the certificate kind.
#[near(serializers = [borsh])]
struct LastRunIdsV1 {
    risk_update: u64,
    vault_report: u64,
    decision: u64,
    sealing_key: u64,
}

#[near(serializers = [borsh])]
struct StatsV1 {
    risk_updates: u64,
    vault_reports: u64,
    decisions: u64,
    accounts_tracked: u64,
}

/// The state layout deployed before certificate anchors, which `migrate` reads.
#[near(serializers = [borsh])]
struct ContractV1 {
    owner_id: AccountId,
    vault: Option<AccountId>,
    enclave_pk: [u8; 32],
    enclave_keys: Vector<EnclaveKey>,
    last_run_ids: LastRunIdsV1,
    stats: StatsV1,
    positions: LookupMap<AccountId, Vec<PositionRecord>>,
    tracked: Ring<AccountId>,
    marks: IterableMap<String, Mark>,
    vault_reports: Ring<StoredVaultReport>,
    decisions: LookupMap<Hex32, Record<Decision>>,
    decision_ids: Ring<Hex32>,
    decisions_by_account: LookupMap<AccountId, Vec<Hex32>>,
    sealing_key: Option<SealingKey>,
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn ed25519_bytes(key: &PublicKey) -> [u8; 32] {
    require!(key.curve_type() == CurveType::ED25519, "the enclave key must be an ed25519 key");
    key.as_bytes()[1..].try_into().unwrap_or_else(|_| env::abort())
}

fn page(from_index: Option<u32>, limit: Option<u32>) -> (u64, u64) {
    (u64::from(from_index.unwrap_or(0)), u64::from(limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE)))
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        enclave_key: PublicKey,
        wasm_sha256: Hex32,
        vault: Option<AccountId>,
    ) -> Self {
        let mut this = Self {
            owner_id,
            vault,
            enclave_pk: [0; 32],
            enclave_keys: Vector::new(StorageKey::EnclaveKeys),
            last_run_ids: LastRunIds::default(),
            stats: Stats::default(),
            positions: LookupMap::new(StorageKey::Positions),
            tracked: Ring::new(StorageKey::TrackedAccounts, MAX_ACCOUNTS),
            marks: IterableMap::new(StorageKey::Marks),
            vault_reports: Ring::new(StorageKey::VaultReports, VAULT_HISTORY),
            decisions: LookupMap::new(StorageKey::Decisions),
            decision_ids: Ring::new(StorageKey::DecisionIds, DECISION_HISTORY),
            decisions_by_account: LookupMap::new(StorageKey::DecisionsByAccount),
            sealing_key: None,
            certificates: LookupMap::new(StorageKey::Certificates),
            certificate_ids: Ring::new(StorageKey::CertificateIds, CERTIFICATE_HISTORY),
        };
        this.install_enclave(enclave_key, wasm_sha256, "initial key".to_string());
        env::storage_write(LAYOUT_KEY, &[LAYOUT_VERSION]);
        this
    }

    /// Moves the deployed state to this layout: the run id and count of certificate anchors
    /// start at 0, and stored vault reports keep their layout (`StoredVaultReport` reads both).
    /// Called by the owner, or by the board's own account in the batch that deploys the code.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        require!(env::storage_read(LAYOUT_KEY).is_none(), "the state is already migrated");
        let old: ContractV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("no deployed state to migrate"));
        let caller = env::predecessor_account_id();
        require!(caller == old.owner_id || caller == env::current_account_id(), "owner only");
        env::storage_write(LAYOUT_KEY, &[LAYOUT_VERSION]);
        Self {
            owner_id: old.owner_id,
            vault: old.vault,
            enclave_pk: old.enclave_pk,
            enclave_keys: old.enclave_keys,
            last_run_ids: LastRunIds {
                risk_update: old.last_run_ids.risk_update,
                vault_report: old.last_run_ids.vault_report,
                decision: old.last_run_ids.decision,
                sealing_key: old.last_run_ids.sealing_key,
                certificate: 0,
            },
            stats: Stats {
                risk_updates: old.stats.risk_updates,
                vault_reports: old.stats.vault_reports,
                decisions: old.stats.decisions,
                accounts_tracked: old.stats.accounts_tracked,
                certificates: 0,
            },
            positions: old.positions,
            tracked: old.tracked,
            marks: old.marks,
            vault_reports: old.vault_reports,
            decisions: old.decisions,
            decision_ids: old.decision_ids,
            decisions_by_account: old.decisions_by_account,
            sealing_key: old.sealing_key,
            certificates: LookupMap::new(StorageKey::Certificates),
            certificate_ids: Ring::new(StorageKey::CertificateIds, CERTIFICATE_HISTORY),
        }
    }

    /// Accepts a report signed by the enclave. Anyone may relay: the guards are the ed25519
    /// signature over SHA-256(`DOMAIN` ++ `report_json`) by the current enclave key, a run id
    /// greater than the last accepted one of the same kind, and `at` no more than
    /// `MAX_REPORT_AGE_SECS` in the past or `MAX_REPORT_FUTURE_SECS` in the future. Run ids
    /// stay monotonic across key rotations, so a new enclave build continues the sequence.
    pub fn submit(&mut self, report_json: String, signature: Base64VecU8) {
        require!(
            report_json.len() <= MAX_REPORT_BYTES,
            format!("report must be at most {MAX_REPORT_BYTES} bytes")
        );
        let signature: [u8; 64] = signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        // The signature comes first: nothing unsigned reaches the parser.
        require!(
            env::ed25519_verify(&signature, report_digest(&report_json), &self.enclave_pk),
            "signature does not verify against the enclave key"
        );
        let report: Report = serde_json::from_str(&report_json)
            .unwrap_or_else(|e| env::panic_str(&format!("bad report: {e}")));

        let (kind, run_id, at) = report.header();
        let last = self.last_run_ids.get(kind);
        require!(
            run_id > last,
            format!("run_id {run_id} is not greater than the last accepted {kind} run_id {last}")
        );
        let now = now_secs();
        require!(
            at.saturating_add(MAX_REPORT_AGE_SECS) >= now,
            format!("report is more than {MAX_REPORT_AGE_SECS} s old")
        );
        require!(
            at <= now.saturating_add(MAX_REPORT_FUTURE_SECS),
            format!("report is more than {MAX_REPORT_FUTURE_SECS} s in the future")
        );
        report.validate();
        self.last_run_ids.set(kind, run_id);

        let key_index = self.current_key_index();
        match report {
            Report::RiskUpdate(r) => self.apply_risk_update(r),
            Report::VaultReport(r) => self.apply_vault_report(r, key_index, report_json),
            Report::Decision(r) => self.apply_decision(r, key_index),
            Report::SealingKey(r) => {
                Event::SealingKeyPublished { run_id: r.run_id, public_key: r.public_key }.emit();
                self.sealing_key =
                    Some(SealingKey { public_key: r.public_key, run_id: r.run_id, at: r.at, key_index });
            }
            Report::Certificate(r) => self.apply_certificate(r, key_index),
        }
    }

    // ---------------------------------------------------------------------------------------
    // Owner (1 yoctoNEAR, so only a full-access key can sign)
    // ---------------------------------------------------------------------------------------

    /// Rotates the enclave key. The old key stops verifying at once and stays in the history.
    #[payable]
    pub fn set_enclave(&mut self, public_key: PublicKey, wasm_sha256: Hex32, note: String) {
        self.assert_owner();
        self.install_enclave(public_key, wasm_sha256, note);
    }

    /// The vault that receives `on_vault_report` for its own reports.
    #[payable]
    pub fn set_vault(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.vault = Some(account_id);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_enclave(&self) -> EnclaveKey {
        self.enclave_keys.get(self.current_key_index()).cloned().unwrap_or_else(|| env::abort())
    }

    /// Enclave keys, newest first.
    pub fn enclave_history(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<EnclaveKey> {
        let (from, limit) = page(from_index, limit);
        let len = u64::from(self.enclave_keys.len());
        (from..len.min(from.saturating_add(limit)))
            .filter_map(|i| self.enclave_keys.get((len - 1 - i) as u32).cloned())
            .collect()
    }

    pub fn risk_of(&self, account: AccountId, venue: String, position: String) -> Option<PositionRecord> {
        self.positions.get(&account)?.iter().find(|r| r.venue == venue && r.position == position).cloned()
    }

    /// Every stored position of `account`, most recently updated first.
    pub fn risks_of(&self, account: AccountId) -> Vec<PositionRecord> {
        self.positions.get(&account).map(|list| list.iter().rev().cloned().collect()).unwrap_or_default()
    }

    pub fn marks(&self) -> Vec<Mark> {
        self.marks.values().cloned().collect()
    }

    pub fn mark_of(&self, asset: String) -> Option<Mark> {
        self.marks.get(&asset).cloned()
    }

    pub fn latest_vault_report(&self) -> Option<Record<VaultReport>> {
        self.vault_reports.newest().map(|r| r.0.clone())
    }

    /// Vault reports, newest first.
    pub fn vault_reports(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Record<VaultReport>> {
        let (from, limit) = page(from_index, limit);
        self.vault_reports.newest_first(from, limit).map(|r| r.0.clone()).collect()
    }

    /// The anchor of the health certificate whose JSON hashes to `hash`, or null.
    pub fn certificate(&self, hash: Hex32) -> Option<CertificateRecord> {
        self.certificates.get(&hash).cloned()
    }

    pub fn decision(&self, id: Hex32) -> Option<Record<Decision>> {
        self.decisions.get(&id).cloned()
    }

    /// Decisions, newest first.
    pub fn decisions(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Record<Decision>> {
        let (from, limit) = page(from_index, limit);
        self.decision_ids.newest_first(from, limit).filter_map(|id| self.decisions.get(id).cloned()).collect()
    }

    /// Decisions about `account`, newest first.
    pub fn decisions_of(
        &self,
        account: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Record<Decision>> {
        let (from, limit) = page(from_index, limit);
        let Some(ids) = self.decisions_by_account.get(&account) else {
            return Vec::new();
        };
        ids.iter()
            .rev()
            .skip(from as usize)
            .take(limit as usize)
            .filter_map(|id| self.decisions.get(id).cloned())
            .collect()
    }

    pub fn sealing_key(&self) -> Option<SealingKey> {
        self.sealing_key.clone()
    }

    pub fn last_run_ids(&self) -> LastRunIds {
        self.last_run_ids.clone()
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn config(&self) -> Config {
        Config { owner_id: self.owner_id.clone(), vault: self.vault.clone() }
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn current_key_index(&self) -> u32 {
        self.enclave_keys.len() - 1
    }

    fn install_enclave(&mut self, key: PublicKey, wasm_sha256: Hex32, note: String) {
        require!(
            note.chars().count() <= MAX_NOTE_CHARS,
            format!("note must be at most {MAX_NOTE_CHARS} characters")
        );
        self.enclave_pk = ed25519_bytes(&key);
        let entry = EnclaveKey {
            index: self.enclave_keys.len(),
            public_key: String::from(&key),
            wasm_sha256,
            since: now_secs(),
            note,
        };
        Event::EnclaveChanged {
            index: entry.index,
            public_key: entry.public_key.clone(),
            wasm_sha256: entry.wasm_sha256,
        }
        .emit();
        self.enclave_keys.push(entry);
    }

    fn apply_risk_update(&mut self, r: RiskUpdate) {
        Event::RiskUpdated {
            run_id: r.run_id,
            positions: r.positions.len() as u32,
            marks: r.marks.len() as u32,
        }
        .emit();
        self.stats.risk_updates += 1;

        for p in r.positions {
            let record = PositionRecord {
                account: p.account,
                venue: p.venue,
                position: p.position,
                score: p.score,
                tier: p.tier,
                health_bps: p.health_bps,
                ttl_secs: p.ttl_secs,
                p24_bps: p.p24_bps,
                run_id: r.run_id,
                at: r.at,
            };
            if !self.positions.contains_key(&record.account) {
                self.stats.accounts_tracked += 1;
                if let Some(evicted) = self.tracked.push(record.account.clone()) {
                    self.positions.remove(&evicted);
                    self.stats.accounts_tracked -= 1;
                }
            }
            let list = self.positions.entry(record.account.clone()).or_default();
            list.retain(|old| !(old.venue == record.venue && old.position == record.position));
            list.push(record);
            if list.len() > POSITIONS_PER_ACCOUNT {
                list.remove(0);
            }
        }

        for m in r.marks {
            if !self.marks.contains_key(&m.asset) {
                require!(
                    self.marks.len() < MAX_ASSETS,
                    format!("at most {MAX_ASSETS} assets can have a mark")
                );
            }
            let mark = Mark { asset: m.asset, asset_index: m.asset_index, price_e8: m.price_e8, at: r.at };
            self.marks.insert(mark.asset.clone(), mark);
        }
    }

    fn apply_vault_report(&mut self, r: VaultReport, key_index: u32, report_json: String) {
        let forwarded = self.vault.as_ref() == Some(&r.vault);
        Event::VaultReported {
            run_id: r.run_id,
            vault: r.vault.clone(),
            score: r.score,
            ratio_bps: r.reserves.ratio_bps,
            forwarded,
        }
        .emit();
        self.stats.vault_reports += 1;
        if forwarded {
            // Detached: the board records the report whatever the vault does with it, and a
            // vault that missed one can still read it from `latest_vault_report`.
            ext_vault::ext(r.vault.clone())
                .with_static_gas(VAULT_CALLBACK_GAS)
                .with_attached_deposit(NearToken::from_yoctonear(0))
                .on_vault_report(report_json)
                .detach();
        }
        self.vault_reports.push(StoredVaultReport(Record { report: r, key_index }));
    }

    fn apply_certificate(&mut self, r: CertificateReport, key_index: u32) {
        require!(
            !self.certificates.contains_key(&r.hash),
            format!("certificate {} is already anchored", r.hash)
        );
        Event::CertificateAnchored { hash: r.hash, reader: r.reader.clone(), expires_at: r.expires_at }
            .emit();
        self.stats.certificates += 1;
        self.certificates.insert(
            r.hash,
            CertificateRecord {
                hash: r.hash,
                reader: r.reader,
                expires_at: r.expires_at,
                at: r.at,
                key_index,
            },
        );
        if let Some(evicted) = self.certificate_ids.push(r.hash) {
            self.certificates.remove(&evicted);
        }
    }

    fn apply_decision(&mut self, d: Decision, key_index: u32) {
        require!(!self.decisions.contains_key(&d.id), format!("decision {} is already recorded", d.id));
        Event::DecisionRecorded {
            id: d.id,
            account: d.account.clone(),
            action: d.action.clone(),
            verdict: d.review.verdict,
            review_hash: d.review.review_hash,
        }
        .emit();
        self.stats.decisions += 1;

        let id = d.id;
        let account = d.account.clone();
        self.decisions.insert(id, Record { report: d, key_index });
        if let Some(evicted) = self.decision_ids.push(id) {
            self.forget_decision(evicted);
        }
        let ids = self.decisions_by_account.entry(account).or_default();
        ids.push(id);
        if ids.len() > DECISIONS_PER_ACCOUNT {
            // The record stays while the global history holds it; only this index forgets it.
            ids.remove(0);
        }
    }

    /// Removes a decision that left the global history, and its id from its account's list,
    /// so no list ever points at a removed record.
    fn forget_decision(&mut self, id: Hex32) {
        let Some(record) = self.decisions.remove(&id) else {
            return;
        };
        let account = record.report.account;
        let now_empty = match self.decisions_by_account.get_mut(&account) {
            Some(ids) => {
                ids.retain(|kept| *kept != id);
                ids.is_empty()
            }
            None => false,
        };
        if now_empty {
            self.decisions_by_account.remove(&account);
        }
    }
}

#[cfg(test)]
mod tests;
