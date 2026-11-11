//! The signed report format, and the checks a report must pass beyond its signature.
//!
//! A report is one JSON object with a `kind` tag. Big numbers are decimal strings (`U128`,
//! `I128`); hashes and keys are 64 lowercase hex characters. Unknown fields are refused, so
//! every byte the enclave signed is either stored or rejected, never silently dropped.

use std::fmt;

use near_sdk::json_types::{I128, U128};
use near_sdk::serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::{env, near, require, AccountId};

/// Domain separation for the signed digest: SHA-256(`DOMAIN` ++ report JSON bytes). A key that
/// signs for the risk board can then never be tricked into signing something valid elsewhere,
/// and a format change gets a new version tag instead of a silent reinterpretation.
pub const DOMAIN: &[u8] = b"parry-risk:v1:";

/// Bounds that keep one report's gas, storage and events small and predictable.
pub const MAX_POSITIONS_PER_REPORT: usize = 100;
pub const MAX_MARKS_PER_REPORT: usize = 64;
pub const MAX_VENUE_LEN: usize = 32;
pub const MAX_POSITION_LEN: usize = 128;
pub const MAX_ASSET_LEN: usize = 16;
pub const MAX_ACTION_LEN: usize = 64;
pub const MAX_PLAN_CHARS: usize = 600;
pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_SCORE: u8 = 100;
pub const MAX_BPS: u32 = 10_000;
pub const MAX_REASON_CHARS: usize = 280;
/// Longest a health certificate may stay valid (30 days).
pub const MAX_CERTIFICATE_TTL_SECS: u64 = 30 * 86_400;

/// The digest the enclave signs for `report_json`.
pub fn report_digest(report_json: &str) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(DOMAIN.len() + report_json.len());
    preimage.extend_from_slice(DOMAIN);
    preimage.extend_from_slice(report_json.as_bytes());
    env::sha256_array(&preimage)
}

/// 32 bytes written as exactly 64 lowercase hex characters. One spelling per value keeps ids
/// usable as keys by off-chain indexes that read the raw report JSON.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hex32(pub [u8; 32]);

impl fmt::Display for Hex32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl Serialize for Hex32 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for Hex32 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        let canonical = s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if !canonical {
            return Err(de::Error::custom("expected 64 lowercase hex characters"));
        }
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(&s, &mut bytes).map_err(de::Error::custom)?;
        Ok(Self(bytes))
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Safe,
    Caution,
    Danger,
    Critical,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Approve,
    Reject,
}

/// Every accepted report, by kind. Deserialising into this type is the format check.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", tag = "kind", rename_all = "snake_case")]
pub enum Report {
    RiskUpdate(RiskUpdate),
    VaultReport(VaultReport),
    Decision(Decision),
    SealingKey(SealingKeyReport),
    Certificate(CertificateReport),
}

/// The report kinds; each has its own strictly increasing run id.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    RiskUpdate,
    VaultReport,
    Decision,
    SealingKey,
    Certificate,
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Kind::RiskUpdate => "risk_update",
            Kind::VaultReport => "vault_report",
            Kind::Decision => "decision",
            Kind::SealingKey => "sealing_key",
            Kind::Certificate => "certificate",
        })
    }
}

impl Report {
    /// `(kind, run_id, at)`.
    pub fn header(&self) -> (Kind, u64, u64) {
        match self {
            Report::RiskUpdate(r) => (Kind::RiskUpdate, r.run_id, r.at),
            Report::VaultReport(r) => (Kind::VaultReport, r.run_id, r.at),
            Report::Decision(r) => (Kind::Decision, r.run_id, r.at),
            Report::SealingKey(r) => (Kind::SealingKey, r.run_id, r.at),
            Report::Certificate(r) => (Kind::Certificate, r.run_id, r.at),
        }
    }

    /// Range and size checks the JSON types cannot express.
    pub fn validate(&self) {
        match self {
            Report::RiskUpdate(r) => r.validate(),
            Report::VaultReport(r) => r.validate(),
            Report::Decision(r) => r.validate(),
            Report::SealingKey(_) => {}
            Report::Certificate(r) => r.validate(),
        }
    }
}

fn assert_label(field: &str, value: &str, max_len: usize) {
    require!(!value.is_empty() && value.len() <= max_len, format!("{field} must be 1 to {max_len} bytes"));
}

fn assert_score(field: &str, score: u8) {
    require!(score <= MAX_SCORE, format!("{field} must be at most 100"));
}

// ----- risk_update ------------------------------------------------------------------------------

/// The latest risk of every monitored position, and the marks used to compute it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskUpdate {
    pub run_id: u64,
    pub at: u64,
    pub positions: Vec<PositionRisk>,
    pub marks: Vec<MarkReport>,
}

impl RiskUpdate {
    fn validate(&self) {
        require!(
            self.positions.len() <= MAX_POSITIONS_PER_REPORT,
            format!("at most {MAX_POSITIONS_PER_REPORT} positions per report")
        );
        require!(
            self.marks.len() <= MAX_MARKS_PER_REPORT,
            format!("at most {MAX_MARKS_PER_REPORT} marks per report")
        );
        for p in &self.positions {
            assert_label("venue", &p.venue, MAX_VENUE_LEN);
            assert_label("position", &p.position, MAX_POSITION_LEN);
            assert_score("score", p.score);
            require!(p.p24_bps <= MAX_BPS, "p24_bps is a probability: at most 10000");
        }
        for m in &self.marks {
            assert_label("asset", &m.asset, MAX_ASSET_LEN);
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PositionRisk {
    pub account: AccountId,
    /// Where the position lives, for example a lending market or a perps exchange.
    pub venue: String,
    /// The position's id within the venue.
    pub position: String,
    /// 0 (no risk) to 100.
    pub score: u8,
    pub tier: Tier,
    /// Health factor in basis points (10000 is a health factor of 1.0).
    pub health_bps: u32,
    /// Estimated time to liquidation, in seconds.
    pub ttl_secs: u64,
    /// Probability of liquidation within 24 hours, in basis points.
    pub p24_bps: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MarkReport {
    pub asset: String,
    /// The asset's index on the venue the hedge trades on.
    pub asset_index: u32,
    /// USD price scaled by 1e8.
    pub price_e8: U128,
}

// ----- vault_report -----------------------------------------------------------------------------

/// The vault's score, hedge state and proof-of-reserves summary for one run.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VaultReport {
    pub run_id: u64,
    pub at: u64,
    pub vault: AccountId,
    pub score: u8,
    pub components: Components,
    pub hedge: Hedge,
    pub reserves: Reserves,
    /// The hedge ratio the enclave asks the vault to size with (funding-aware), in bps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hedge_ratio_bps: Option<u32>,
    /// Why that ratio, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hedge_ratio_reason: Option<String>,
    /// The hedge account's maintenance margin over its value, in bps (10000 is liquidation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_ratio: Option<u32>,
}

impl VaultReport {
    fn validate(&self) {
        assert_score("score", self.score);
        if let Some(ratio) = self.hedge_ratio_bps {
            require!(ratio <= MAX_BPS, "hedge_ratio_bps must be at most 10000");
        }
        if let Some(reason) = &self.hedge_ratio_reason {
            require!(
                reason.chars().count() <= MAX_REASON_CHARS,
                format!("hedge_ratio_reason must be at most {MAX_REASON_CHARS} characters")
            );
        }
    }
}

/// A vault report as stored before it carried the hedge ratio and margin ratio. Ring slots
/// written then still hold this layout; `StoredVaultReport` reads both.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultReportV1 {
    pub run_id: u64,
    pub at: u64,
    pub vault: AccountId,
    pub score: u8,
    pub components: Components,
    pub hedge: Hedge,
    pub reserves: Reserves,
}

impl From<VaultReportV1> for VaultReport {
    fn from(r: VaultReportV1) -> Self {
        VaultReport {
            run_id: r.run_id,
            at: r.at,
            vault: r.vault,
            score: r.score,
            components: r.components,
            hedge: r.hedge,
            reserves: r.reserves,
            hedge_ratio_bps: None,
            hedge_ratio_reason: None,
            margin_ratio: None,
        }
    }
}

/// What each risk source contributes to the vault score, in basis points.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Components {
    pub liquidation_bps: u32,
    pub margin_bps: u32,
    pub funding_bps: u32,
    pub oracle_bps: u32,
    pub rate_bps: u32,
    pub reserves_bps: u32,
}

/// The short perp that hedges the vault's staked NEAR.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Hedge {
    pub asset_index: u32,
    /// Position size scaled by 1e8; negative is short.
    pub size_e8: I128,
    pub entry_e8: U128,
    pub account_value_e6: U128,
    pub unrealized_e6: I128,
    pub funding_e6: I128,
    /// Operator-funded margin that is excluded from the vault's NAV.
    pub margin_baseline_e6: U128,
    pub mark_e8: U128,
    pub liquidation_e8: U128,
}

/// A Merkle commitment to the vault's balances and how they cover its liabilities.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Reserves {
    pub root: Hex32,
    pub leaves: u32,
    pub total_usd_e6: U128,
    pub liabilities_usd_e6: U128,
    pub ratio_bps: u32,
}

// ----- decision ---------------------------------------------------------------------------------

/// One guardian decision, with the hash of the action envelope and the model review behind it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub run_id: u64,
    pub at: u64,
    pub id: Hex32,
    pub account: AccountId,
    pub venue: String,
    pub trigger: Trigger,
    pub action: String,
    pub plan: String,
    pub envelope_hash: Hex32,
    pub review: Review,
}

impl Decision {
    fn validate(&self) {
        assert_label("venue", &self.venue, MAX_VENUE_LEN);
        assert_score("trigger.score", self.trigger.score);
        assert_label("action", &self.action, MAX_ACTION_LEN);
        require!(
            self.plan.chars().count() <= MAX_PLAN_CHARS,
            format!("plan must be at most {MAX_PLAN_CHARS} characters")
        );
        assert_label("review.model", &self.review.model, MAX_LABEL_LEN);
        assert_label("review.chat_id", &self.review.chat_id, MAX_LABEL_LEN);
        assert_label("review.signing_address", &self.review.signing_address, MAX_LABEL_LEN);
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub score: u8,
    pub tier: Tier,
    pub health_bps: u32,
}

/// The verifiable model review: which model, which chat, the hashes of the signed review and of
/// its reasoning, the verdict, and the address that signed the review.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub model: String,
    pub chat_id: String,
    pub review_hash: Hex32,
    pub verdict: Verdict,
    pub signing_address: String,
    pub reasoning_hash: Hex32,
}

// ----- certificate ------------------------------------------------------------------------------

/// The anchor of a health certificate the enclave signed: its hash, who it is for and when it
/// expires. The certificate itself (and its amounts-free statement) stays off chain.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CertificateReport {
    pub run_id: u64,
    pub at: u64,
    /// SHA-256 of the exact certificate JSON.
    pub hash: Hex32,
    pub reader: String,
    pub expires_at: u64,
}

impl CertificateReport {
    fn validate(&self) {
        assert_label("reader", &self.reader, MAX_LABEL_LEN);
        require!(self.expires_at > self.at, "a certificate must expire after it was issued");
        require!(
            self.expires_at <= self.at.saturating_add(MAX_CERTIFICATE_TTL_SECS),
            "a certificate is valid for at most 30 days"
        );
    }
}

// ----- sealing_key ------------------------------------------------------------------------------

/// The enclave's X25519 public key that browsers encrypt sealed mandates to.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SealingKeyReport {
    pub run_id: u64,
    pub at: u64,
    pub public_key: Hex32,
}
