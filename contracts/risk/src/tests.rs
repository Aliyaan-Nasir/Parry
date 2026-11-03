use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

const T0: u64 = 1_800_000_000;
const WASM: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
const WASM2: &str = "bb00000000000000000000000000000000000000000000000000000000000002";
const VAULT: &str = "vault.parry.testnet";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn hex32(s: &str) -> Hex32 {
    serde_json::from_value(json!(s)).unwrap()
}

fn id_hex(n: u64) -> String {
    format!("{n:064x}")
}

fn ctx(who: &str, secs: u64, yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("risk.parry.testnet"))
        .predecessor_account_id(account(who))
        .signer_account_id(account(who))
        .block_timestamp(secs * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .build());
}

/// A stand-in for the enclave: an ed25519 key that signs with the board's digest rule, built
/// here from the documented rule rather than from `report_digest`.
struct Enclave(SigningKey);

impl Enclave {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32]))
    }

    fn public_key(&self) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, self.0.verifying_key().to_bytes().to_vec()).unwrap()
    }

    fn sign(&self, report_json: &str) -> Base64VecU8 {
        let mut preimage = b"parry-risk:v1:".to_vec();
        preimage.extend_from_slice(report_json.as_bytes());
        let digest = env::sha256(&preimage);
        Base64VecU8(self.0.sign(&digest).to_bytes().to_vec())
    }
}

fn deploy() -> Contract {
    ctx("owner.testnet", T0, 0);
    Contract::new(account("owner.testnet"), Enclave::new(1).public_key(), hex32(WASM), Some(account(VAULT)))
}

/// Relays `report` signed by `enclave` at block time `secs`, in a fresh context (fresh gas).
fn relay(c: &mut Contract, enclave: &Enclave, report: &Value, secs: u64) {
    ctx("relayer.testnet", secs, 0);
    let json = report.to_string();
    let signature = enclave.sign(&json);
    c.submit(json, signature);
}

/// The deployed enclave, built once: deriving a key is the slow part of the long history tests.
fn enclave() -> &'static Enclave {
    static ENCLAVE: std::sync::OnceLock<Enclave> = std::sync::OnceLock::new();
    ENCLAVE.get_or_init(|| Enclave::new(1))
}

fn submit(c: &mut Contract, report: &Value) {
    relay(c, enclave(), report, T0);
}

/// Submits many reports at T0, sharing one context per 50 reports: building a context is the
/// slow part of a unit test, and 50 stays well inside one receipt's gas and log limits.
fn submit_all(c: &mut Contract, reports: impl IntoIterator<Item = Value>) {
    for (i, report) in reports.into_iter().enumerate() {
        if i % 50 == 0 {
            ctx("relayer.testnet", T0, 0);
        }
        let json = report.to_string();
        let signature = enclave().sign(&json);
        c.submit(json, signature);
    }
}

fn position(account: &str, position: &str, score: u8) -> Value {
    json!({
        "account": account,
        "venue": "rhea",
        "position": position,
        "score": score,
        "tier": "caution",
        "health_bps": 11_500,
        "ttl_secs": 7_200,
        "p24_bps": 1_250,
    })
}

fn risk_update(run_id: u64, at: u64) -> Value {
    json!({
        "kind": "risk_update",
        "run_id": run_id,
        "at": at,
        "positions": [position("alice.testnet", "near-usdc", 42), position("bob.testnet", "near-usdc", 90)],
        "marks": [{ "asset": "NEAR", "asset_index": 0, "price_e8": "300000000" }],
    })
}

fn vault_report(run_id: u64, at: u64, vault: &str) -> Value {
    json!({
        "kind": "vault_report",
        "run_id": run_id,
        "at": at,
        "vault": vault,
        "score": 35,
        "components": {
            "liquidation_bps": 1200, "margin_bps": 800, "funding_bps": 500,
            "oracle_bps": 300, "rate_bps": 200, "reserves_bps": 500,
        },
        "hedge": {
            "asset_index": 0,
            "size_e8": "-125000000000",
            "entry_e8": "310000000",
            "account_value_e6": "1500000000",
            "unrealized_e6": "-12500000",
            "funding_e6": "340000",
            "margin_baseline_e6": "1000000000",
            "mark_e8": "300000000",
            "liquidation_e8": "520000000",
        },
        "reserves": {
            "root": id_hex(0xabc),
            "leaves": 12,
            "total_usd_e6": "5000000000",
            "liabilities_usd_e6": "4800000000",
            "ratio_bps": 10416,
        },
    })
}

fn decision(run_id: u64, id: u64, account: &str) -> Value {
    json!({
        "kind": "decision",
        "run_id": run_id,
        "at": T0,
        "id": id_hex(id),
        "account": account,
        "venue": "rhea",
        "trigger": { "score": 81, "tier": "critical", "health_bps": 10_400 },
        "action": "deleverage",
        "plan": "withdraw 120 NEAR, swap to USDC, repay 360 USDC",
        "envelope_hash": id_hex(0xe0),
        "review": {
            "model": "review-model-1",
            "chat_id": "chat-123",
            "review_hash": id_hex(0xf0),
            "verdict": "approve",
            "signing_address": "0x1234567890abcdef1234567890abcdef12345678",
            "reasoning_hash": id_hex(0xf1),
        },
    })
}

fn sealing(run_id: u64) -> Value {
    json!({ "kind": "sealing_key", "run_id": run_id, "at": T0, "public_key": id_hex(0x5ea1) })
}

fn last_event() -> Value {
    let logs = get_logs();
    let line = logs.iter().rev().find(|l| l.starts_with("EVENT_JSON:")).expect("an event");
    serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap()
}

fn function_calls() -> Vec<(AccountId, String, Value, NearToken, Gas)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name, args, attached_deposit, prepaid_gas, ..
                } => Some((
                    receiver.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap(),
                    attached_deposit,
                    prepaid_gas,
                )),
                _ => None,
            })
        })
        .collect()
}

// ----- Signature and envelope checks ----------------------------------------------------------------

#[test]
fn digest_rule_known_answer() {
    ctx("anyone.testnet", T0, 0);
    // sha256("parry-risk:v1:{}"), computed outside the contract.
    assert_eq!(
        hex::encode(report_digest("{}")),
        "377aaba36d0d6849565e87aa645f654ef25c42c706818c48120a6cec483ac3a9"
    );
}

#[test]
fn valid_signature_is_accepted() {
    let mut c = deploy();
    submit(&mut c, &risk_update(1, T0));
    assert_eq!(c.last_run_ids().risk_update, 1);
    assert_eq!(
        last_event(),
        json!({
            "standard": "parry-risk",
            "version": "1.0.0",
            "event": "risk_updated",
            "data": { "run_id": 1, "positions": 2, "marks": 1 },
        })
    );
}

#[test]
#[should_panic(expected = "signature does not verify against the enclave key")]
fn wrong_key_is_refused() {
    let mut c = deploy();
    relay(&mut c, &Enclave::new(2), &risk_update(1, T0), T0);
}

#[test]
#[should_panic(expected = "signature does not verify against the enclave key")]
fn tampered_json_is_refused() {
    let mut c = deploy();
    ctx("relayer.testnet", T0, 0);
    let json = risk_update(1, T0).to_string();
    let signature = Enclave::new(1).sign(&json);
    let tampered = json.replace("\"score\":90", "\"score\":10");
    assert_ne!(tampered, json);
    c.submit(tampered, signature);
}

#[test]
#[should_panic(expected = "signature does not verify against the enclave key")]
fn signature_without_the_domain_tag_is_refused() {
    let mut c = deploy();
    ctx("relayer.testnet", T0, 0);
    let json = risk_update(1, T0).to_string();
    let bare = Enclave::new(1).0.sign(&env::sha256(json.as_bytes())).to_bytes().to_vec();
    c.submit(json, Base64VecU8(bare));
}

#[test]
#[should_panic(expected = "signature must be 64 bytes")]
fn short_signature_is_refused() {
    let mut c = deploy();
    ctx("relayer.testnet", T0, 0);
    c.submit(risk_update(1, T0).to_string(), Base64VecU8(vec![0; 63]));
}

#[test]
#[should_panic(expected = "run_id 1 is not greater than the last accepted risk_update run_id 1")]
fn replayed_report_is_refused() {
    let mut c = deploy();
    submit(&mut c, &risk_update(1, T0));
    submit(&mut c, &risk_update(1, T0));
}

#[test]
#[should_panic(expected = "run_id 4 is not greater than the last accepted risk_update run_id 5")]
fn lower_run_id_is_refused() {
    let mut c = deploy();
    submit(&mut c, &risk_update(5, T0));
    submit(&mut c, &risk_update(4, T0));
}

#[test]
fn run_ids_are_tracked_per_kind() {
    let mut c = deploy();
    submit(&mut c, &risk_update(9, T0));
    submit(&mut c, &vault_report(1, T0, VAULT));
    submit(&mut c, &decision(1, 1, "alice.testnet"));
    submit(&mut c, &sealing(3));
    assert_eq!(c.last_run_ids(), LastRunIds { risk_update: 9, vault_report: 1, decision: 1, sealing_key: 3 });
}

#[test]
fn report_exactly_600_s_old_is_accepted() {
    let mut c = deploy();
    relay(&mut c, &Enclave::new(1), &risk_update(1, T0 - 600), T0);
    assert_eq!(c.stats().risk_updates, 1);
}

#[test]
#[should_panic(expected = "report is more than 600 s old")]
fn stale_report_is_refused() {
    let mut c = deploy();
    relay(&mut c, &Enclave::new(1), &risk_update(1, T0 - 601), T0);
}

#[test]
fn report_60_s_ahead_is_accepted() {
    let mut c = deploy();
    relay(&mut c, &Enclave::new(1), &risk_update(1, T0 + 60), T0);
    assert_eq!(c.stats().risk_updates, 1);
}

#[test]
#[should_panic(expected = "report is more than 60 s in the future")]
fn future_report_is_refused() {
    let mut c = deploy();
    relay(&mut c, &Enclave::new(1), &risk_update(1, T0 + 61), T0);
}

#[test]
#[should_panic(expected = "bad report: unknown variant `price_update`")]
fn unknown_kind_is_refused() {
    let mut c = deploy();
    submit(&mut c, &json!({ "kind": "price_update", "run_id": 1, "at": T0 }));
}

#[test]
#[should_panic(expected = "bad report")]
fn signed_non_json_is_refused() {
    let mut c = deploy();
    ctx("relayer.testnet", T0, 0);
    let text = "not a report".to_string();
    let signature = Enclave::new(1).sign(&text);
    c.submit(text, signature);
}

#[test]
#[should_panic(expected = "bad report: unknown field `note`")]
fn unknown_field_is_refused() {
    let mut c = deploy();
    let mut report = sealing(1);
    report["note"] = json!("extra");
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "bad report: missing field `marks`")]
fn missing_field_is_refused() {
    let mut c = deploy();
    let mut report = risk_update(1, T0);
    report.as_object_mut().unwrap().remove("marks");
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "expected 64 lowercase hex characters")]
fn uppercase_hex_is_refused() {
    let mut c = deploy();
    let mut report = sealing(1);
    report["public_key"] = json!(id_hex(0x5ea1).replace('a', "A"));
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "bad report: unknown variant `doomed`")]
fn unknown_tier_is_refused() {
    let mut c = deploy();
    let mut report = risk_update(1, T0);
    report["positions"][0]["tier"] = json!("doomed");
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "score must be at most 100")]
fn score_above_100_is_refused() {
    let mut c = deploy();
    let mut report = risk_update(1, T0);
    report["positions"][0]["score"] = json!(101);
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "p24_bps is a probability: at most 10000")]
fn probability_above_one_is_refused() {
    let mut c = deploy();
    let mut report = risk_update(1, T0);
    report["positions"][0]["p24_bps"] = json!(10_001);
    submit(&mut c, &report);
}

// ----- risk_update -------------------------------------------------------------------------------

#[test]
fn risk_update_stores_positions_and_marks() {
    let mut c = deploy();
    submit(&mut c, &risk_update(1, T0));
    let alice = c.risk_of(account("alice.testnet"), "rhea".into(), "near-usdc".into()).unwrap();
    assert_eq!(
        serde_json::to_value(&alice).unwrap(),
        json!({
            "account": "alice.testnet", "venue": "rhea", "position": "near-usdc", "score": 42,
            "tier": "caution", "health_bps": 11500, "ttl_secs": 7200, "p24_bps": 1250,
            "run_id": 1, "at": T0,
        })
    );
    assert_eq!(c.risks_of(account("bob.testnet"))[0].score, 90);
    assert!(c.risk_of(account("alice.testnet"), "rhea".into(), "other".into()).is_none());
    assert!(c.risks_of(account("carol.testnet")).is_empty());
    let mark = Mark { asset: "NEAR".into(), asset_index: 0, price_e8: U128(300_000_000), at: T0 };
    assert_eq!(c.mark_of("NEAR".into()), Some(mark.clone()));
    assert_eq!(c.marks(), vec![mark]);
    assert_eq!(c.mark_of("BTC".into()), None);
    assert_eq!(c.stats(), Stats { risk_updates: 1, vault_reports: 0, decisions: 0, accounts_tracked: 2 });
}

#[test]
fn newer_risk_update_replaces_the_latest_per_position() {
    let mut c = deploy();
    submit(&mut c, &risk_update(1, T0 - 30));
    let mut next = risk_update(2, T0);
    next["positions"] =
        json!([position("alice.testnet", "near-usdc", 77), position("alice.testnet", "linear-usdc", 5)]);
    next["marks"] = json!([{ "asset": "NEAR", "asset_index": 0, "price_e8": "250000000" }]);
    submit(&mut c, &next);
    let risks = c.risks_of(account("alice.testnet"));
    assert_eq!(risks.len(), 2);
    // Most recently updated first; the replaced position moved to the newest slot.
    assert_eq!((risks[0].position.as_str(), risks[0].score), ("linear-usdc", 5));
    assert_eq!((risks[1].position.as_str(), risks[1].score, risks[1].run_id), ("near-usdc", 77, 2));
    assert_eq!(c.mark_of("NEAR".into()).unwrap().price_e8, U128(250_000_000));
    assert_eq!(c.mark_of("NEAR".into()).unwrap().at, T0);
    assert_eq!(c.stats().accounts_tracked, 2);
}

#[test]
fn positions_per_account_are_bounded() {
    let mut c = deploy();
    let positions: Vec<Value> =
        (0..=POSITIONS_PER_ACCOUNT).map(|i| position("whale.testnet", &format!("p{i}"), 10)).collect();
    let mut report = risk_update(1, T0);
    report["positions"] = json!(positions);
    submit(&mut c, &report);
    let risks = c.risks_of(account("whale.testnet"));
    assert_eq!(risks.len(), POSITIONS_PER_ACCOUNT);
    assert!(c.risk_of(account("whale.testnet"), "rhea".into(), "p0".into()).is_none());
    assert!(c.risk_of(account("whale.testnet"), "rhea".into(), "p1".into()).is_some());
}

#[test]
#[should_panic(expected = "at most 100 positions per report")]
fn oversized_risk_update_is_refused() {
    let mut c = deploy();
    let mut report = risk_update(1, T0);
    report["positions"] =
        json!((0..101).map(|i| position("a.testnet", &format!("p{i}"), 1)).collect::<Vec<_>>());
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "at most 64 assets can have a mark")]
fn asset_count_is_bounded() {
    let mut c = deploy();
    let mut first = risk_update(1, T0);
    first["marks"] = json!((0..64)
        .map(|i| json!({ "asset": format!("A{i}"), "asset_index": i, "price_e8": "1" }))
        .collect::<Vec<_>>());
    submit(&mut c, &first);
    assert_eq!(c.marks().len(), 64);
    let mut second = risk_update(2, T0);
    second["marks"] = json!([{ "asset": "NEW", "asset_index": 99, "price_e8": "1" }]);
    submit(&mut c, &second);
}

// ----- vault_report ------------------------------------------------------------------------------

#[test]
fn vault_report_is_stored_and_forwarded_to_the_configured_vault() {
    let mut c = deploy();
    let report = vault_report(1, T0, VAULT);
    ctx("relayer.testnet", T0, 0);
    let json = report.to_string();
    c.submit(json.clone(), Enclave::new(1).sign(&json));

    let calls = function_calls();
    assert_eq!(calls.len(), 1);
    let (receiver, method, args, deposit, gas) = &calls[0];
    assert_eq!(receiver, &account(VAULT));
    assert_eq!(method, "on_vault_report");
    // The vault receives the exact signed bytes, so it could verify them itself.
    assert_eq!(args, &json!({ "report_json": json }));
    assert_eq!(*deposit, NearToken::from_yoctonear(0));
    assert_eq!(*gas, VAULT_CALLBACK_GAS);

    assert_eq!(
        last_event(),
        json!({
            "standard": "parry-risk",
            "version": "1.0.0",
            "event": "vault_reported",
            "data": { "run_id": 1, "vault": VAULT, "score": 35, "ratio_bps": 10416, "forwarded": true },
        })
    );
    let latest = c.latest_vault_report().unwrap();
    assert_eq!(latest.key_index, 0);
    let mut stored = serde_json::to_value(&latest.report).unwrap();
    stored["kind"] = json!("vault_report");
    assert_eq!(stored, report);
}

#[test]
fn vault_report_for_another_vault_is_stored_but_not_forwarded() {
    let mut c = deploy();
    submit(&mut c, &vault_report(1, T0, "elsewhere.testnet"));
    assert!(function_calls().is_empty());
    assert_eq!(last_event()["data"]["forwarded"], json!(false));
    assert_eq!(c.latest_vault_report().unwrap().report.vault, account("elsewhere.testnet"));
}

#[test]
fn vault_report_is_not_forwarded_when_no_vault_is_configured() {
    ctx("owner.testnet", T0, 0);
    let mut c = Contract::new(account("owner.testnet"), Enclave::new(1).public_key(), hex32(WASM), None);
    submit(&mut c, &vault_report(1, T0, VAULT));
    assert!(function_calls().is_empty());
    assert_eq!(c.config().vault, None);
}

#[test]
fn set_vault_redirects_forwarding() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.set_vault(account("vault2.parry.testnet"));
    submit(&mut c, &vault_report(1, T0, VAULT));
    assert!(function_calls().is_empty());
    submit(&mut c, &vault_report(2, T0, "vault2.parry.testnet"));
    assert_eq!(function_calls()[0].0, account("vault2.parry.testnet"));
}

#[test]
#[should_panic(expected = "owner only")]
fn non_owner_cannot_set_vault() {
    let mut c = deploy();
    ctx("mallory.testnet", T0, 1);
    c.set_vault(account("mallory.testnet"));
}

#[test]
fn vault_history_keeps_the_newest_300_and_frees_the_rest() {
    let mut c = deploy();
    submit_all(&mut c, (1..=VAULT_HISTORY + 2).map(|run| vault_report(run, T0, "other.testnet")));
    assert_eq!(c.stats().vault_reports, VAULT_HISTORY + 2);
    assert_eq!(c.latest_vault_report().unwrap().report.run_id, VAULT_HISTORY + 2);
    let page = c.vault_reports(Some(1), Some(3));
    assert_eq!(page.iter().map(|r| r.report.run_id).collect::<Vec<_>>(), vec![301, 300, 299]);
    assert_eq!(c.vault_reports(None, None).len(), DEFAULT_PAGE as usize);
    assert_eq!(c.vault_reports(None, Some(1_000)).len(), MAX_PAGE as usize);
    let oldest = c.vault_reports(Some(VAULT_HISTORY as u32 - 1), Some(10));
    assert_eq!(oldest.iter().map(|r| r.report.run_id).collect::<Vec<_>>(), vec![3]);
    assert!(c.vault_reports(Some(VAULT_HISTORY as u32), None).is_empty());

    // The two evicted reports (sequence 0 and 1) are gone from storage, the next one is not.
    c.vault_reports.flush();
    let slot = |seq: u64| [&[StorageKey::VaultReports as u8][..], &seq.to_le_bytes()].concat();
    assert!(!env::storage_has_key(&slot(0)));
    assert!(!env::storage_has_key(&slot(1)));
    assert!(env::storage_has_key(&slot(2)));
}

// ----- decision ----------------------------------------------------------------------------------

#[test]
fn decision_is_stored_and_readable() {
    let mut c = deploy();
    let report = decision(1, 7, "alice.testnet");
    submit(&mut c, &report);
    let record = c.decision(hex32(&id_hex(7))).unwrap();
    assert_eq!(record.key_index, 0);
    let mut stored = serde_json::to_value(&record.report).unwrap();
    stored["kind"] = json!("decision");
    assert_eq!(stored, report);
    assert_eq!(c.decisions(None, None), vec![record.clone()]);
    assert_eq!(c.decisions_of(account("alice.testnet"), None, None), vec![record]);
    assert!(c.decisions_of(account("bob.testnet"), None, None).is_empty());
    assert_eq!(
        last_event(),
        json!({
            "standard": "parry-risk",
            "version": "1.0.0",
            "event": "decision_recorded",
            "data": {
                "id": id_hex(7),
                "account": "alice.testnet",
                "action": "deleverage",
                "verdict": "approve",
                "review_hash": id_hex(0xf0),
            },
        })
    );
    assert_eq!(c.stats().decisions, 1);
}

#[test]
#[should_panic(expected = "is already recorded")]
fn duplicate_decision_is_refused() {
    let mut c = deploy();
    submit(&mut c, &decision(1, 7, "alice.testnet"));
    submit(&mut c, &decision(2, 7, "bob.testnet"));
}

#[test]
fn plan_of_600_characters_is_accepted() {
    let mut c = deploy();
    let mut report = decision(1, 7, "alice.testnet");
    // Characters, not bytes: 600 two-byte characters are 1200 bytes.
    report["plan"] = json!("é".repeat(600));
    submit(&mut c, &report);
    assert_eq!(c.decision(hex32(&id_hex(7))).unwrap().report.plan.chars().count(), 600);
}

#[test]
#[should_panic(expected = "plan must be at most 600 characters")]
fn plan_over_600_characters_is_refused() {
    let mut c = deploy();
    let mut report = decision(1, 7, "alice.testnet");
    report["plan"] = json!("x".repeat(601));
    submit(&mut c, &report);
}

#[test]
#[should_panic(expected = "unknown variant `maybe`")]
fn unknown_verdict_is_refused() {
    let mut c = deploy();
    let mut report = decision(1, 7, "alice.testnet");
    report["review"]["verdict"] = json!("maybe");
    submit(&mut c, &report);
}

#[test]
fn decisions_are_paged_newest_first() {
    let mut c = deploy();
    for n in 1..=5 {
        submit(&mut c, &decision(n, n, "alice.testnet"));
    }
    let ids = |records: Vec<Record<Decision>>| records.iter().map(|r| r.report.run_id).collect::<Vec<_>>();
    assert_eq!(ids(c.decisions(None, Some(2))), vec![5, 4]);
    assert_eq!(ids(c.decisions(Some(2), Some(2))), vec![3, 2]);
    assert_eq!(ids(c.decisions_of(account("alice.testnet"), Some(4), None)), vec![1]);
}

#[test]
fn per_account_decisions_keep_the_newest_50() {
    let mut c = deploy();
    submit_all(&mut c, (1..=DECISIONS_PER_ACCOUNT as u64 + 3).map(|n| decision(n, n, "alice.testnet")));
    let mine = c.decisions_of(account("alice.testnet"), None, Some(100));
    assert_eq!(mine.len(), DECISIONS_PER_ACCOUNT);
    assert_eq!(mine[0].report.run_id, DECISIONS_PER_ACCOUNT as u64 + 3);
    assert_eq!(mine.last().unwrap().report.run_id, 4);
    // Still in the global history.
    assert!(c.decision(hex32(&id_hex(1))).is_some());
}

#[test]
fn decision_history_keeps_the_newest_500_and_frees_the_rest() {
    let mut c = deploy();
    submit(&mut c, &decision(1, 1, "early.testnet"));
    submit_all(&mut c, (2..=DECISION_HISTORY + 1).map(|n| decision(n, n, "busy.testnet")));
    assert_eq!(c.stats().decisions, DECISION_HISTORY + 1);
    // The first decision left the global history: its record and its account's index are gone.
    assert!(c.decision(hex32(&id_hex(1))).is_none());
    assert!(c.decisions_of(account("early.testnet"), None, None).is_empty());
    assert!(c.decision(hex32(&id_hex(2))).is_some());
    assert_eq!(c.decisions(Some(DECISION_HISTORY as u32 - 1), None)[0].report.run_id, 2);
    assert_eq!(c.decisions_of(account("busy.testnet"), None, Some(100)).len(), DECISIONS_PER_ACCOUNT);

    c.decisions.flush();
    c.decision_ids.flush();
    c.decisions_by_account.flush();
    let record = [&[StorageKey::Decisions as u8][..], &hex32(&id_hex(1)).0].concat();
    assert!(!env::storage_has_key(&record));
    let early = [
        &[StorageKey::DecisionsByAccount as u8][..],
        &near_sdk::borsh::to_vec(&account("early.testnet")).unwrap(),
    ]
    .concat();
    assert!(!env::storage_has_key(&early));
    let first_slot = [&[StorageKey::DecisionIds as u8][..], &0u64.to_le_bytes()].concat();
    assert!(!env::storage_has_key(&first_slot));
}

// ----- sealing_key -------------------------------------------------------------------------------

#[test]
fn sealing_key_is_stored() {
    let mut c = deploy();
    assert_eq!(c.sealing_key(), None);
    submit(&mut c, &sealing(1));
    assert_eq!(
        c.sealing_key(),
        Some(SealingKey { public_key: hex32(&id_hex(0x5ea1)), run_id: 1, at: T0, key_index: 0 })
    );
    assert_eq!(
        last_event(),
        json!({
            "standard": "parry-risk",
            "version": "1.0.0",
            "event": "sealing_key_published",
            "data": { "run_id": 1, "public_key": id_hex(0x5ea1) },
        })
    );
}

// ----- Enclave key -------------------------------------------------------------------------------

#[test]
fn initial_enclave_is_readable() {
    let c = deploy();
    let enclave = c.get_enclave();
    assert_eq!(enclave.index, 0);
    assert_eq!(enclave.public_key, String::from(&Enclave::new(1).public_key()));
    assert!(enclave.public_key.starts_with("ed25519:"));
    assert_eq!(enclave.wasm_sha256, hex32(WASM));
    assert_eq!(enclave.since, T0);
    assert_eq!(c.enclave_history(None, None), vec![enclave]);
}

#[test]
fn key_rotation_switches_the_signer_and_keeps_history() {
    let mut c = deploy();
    submit(&mut c, &vault_report(1, T0, "other.testnet"));

    ctx("owner.testnet", T0 + 100, 1);
    c.set_enclave(Enclave::new(2).public_key(), hex32(WASM2), "enclave build 2".into());
    assert_eq!(
        last_event(),
        json!({
            "standard": "parry-risk",
            "version": "1.0.0",
            "event": "enclave_changed",
            "data": {
                "index": 1,
                "public_key": String::from(&Enclave::new(2).public_key()),
                "wasm_sha256": WASM2,
            },
        })
    );

    relay(&mut c, &Enclave::new(2), &vault_report(2, T0 + 100, "other.testnet"), T0 + 100);
    let reports = c.vault_reports(None, None);
    assert_eq!(
        reports.iter().map(|r| (r.report.run_id, r.key_index)).collect::<Vec<_>>(),
        vec![(2, 1), (1, 0)]
    );

    let history = c.enclave_history(None, None);
    assert_eq!(history.len(), 2);
    assert_eq!(
        (history[0].index, history[0].since, history[0].note.as_str()),
        (1, T0 + 100, "enclave build 2")
    );
    assert_eq!((history[1].index, history[1].wasm_sha256), (0, hex32(WASM)));
    assert_eq!(c.get_enclave(), history[0]);
    assert_eq!(c.enclave_history(Some(1), Some(1)), vec![history[1].clone()]);
}

#[test]
#[should_panic(expected = "signature does not verify against the enclave key")]
fn old_key_stops_verifying_after_rotation() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.set_enclave(Enclave::new(2).public_key(), hex32(WASM2), String::new());
    relay(&mut c, &Enclave::new(1), &risk_update(1, T0), T0);
}

#[test]
#[should_panic(expected = "owner only")]
fn non_owner_cannot_rotate_the_key() {
    let mut c = deploy();
    ctx("mallory.testnet", T0, 1);
    c.set_enclave(Enclave::new(9).public_key(), hex32(WASM2), String::new());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn rotation_needs_one_yocto() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 0);
    c.set_enclave(Enclave::new(2).public_key(), hex32(WASM2), String::new());
}

#[test]
#[should_panic(expected = "the enclave key must be an ed25519 key")]
fn non_ed25519_key_is_refused() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
    c.set_enclave(secp, hex32(WASM2), String::new());
}

#[test]
#[should_panic(expected = "note must be at most 280 characters")]
fn long_note_is_refused() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.set_enclave(Enclave::new(2).public_key(), hex32(WASM2), "n".repeat(281));
}

#[test]
fn config_shows_owner_and_vault() {
    let c = deploy();
    assert_eq!(c.config(), Config { owner_id: account("owner.testnet"), vault: Some(account(VAULT)) });
}
