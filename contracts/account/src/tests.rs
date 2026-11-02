// Tests call contract methods for their side effects (receipts, logs, state) and inspect those.
#![allow(unused_must_use)]
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::Signer as _;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig};
use p256::ecdsa::{Signature, SigningKey};
use parry_common::evm::EvmTxParams;
use parry_common::hyperliquid::HlOrder;
use parry_common::mandate::{
    envelope_digest, EvmGuard, GuardianAction, GuardianEnvelope, HlGuard, Mandate, Power, TokenLimit, Trigger,
};
use parry_common::protocol::{Owner, Protocol, TokenConfig};
use parry_common::pyth::{NEAR_USD, USDC_USD};
use sha2::{Digest, Sha256};

use crate::passkey::Assertion;
use crate::*;

const NOW: u64 = 1_800_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const USDC: u128 = 1_000_000;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn me() -> AccountId {
    id("0u-test-account.testnet")
}

fn protocol() -> Protocol {
    Protocol {
        lending: id("lending.parry.testnet"),
        oracle: id("oracle.parry.testnet"),
        dex: id("ref-finance-101.testnet"),
        risk: id("risk.parry.testnet"),
        signer: id("v1.signer-prod.testnet"),
        factory: id("accounts.parry.testnet"),
        tokens: vec![
            TokenConfig {
                token_id: id("wrap.testnet"),
                symbol: "wNEAR".into(),
                decimals: 24,
                extra_decimals: 0,
                price_id: NEAR_USD.into(),
                rate_call: None,
                mark: Some("NEAR".into()),
            },
            TokenConfig {
                token_id: id("usdc.parry.testnet"),
                symbol: "USDC".into(),
                decimals: 6,
                extra_decimals: 12,
                price_id: USDC_USD.into(),
                rate_call: None,
                mark: None,
            },
        ],
    }
}

fn ctx(predecessor: &str, deposit: u128, secs: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(id(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(near_sdk::Gas::from_tgas(900));
    b
}

fn set(predecessor: &str, deposit: u128, secs: u64) {
    testing_env!(ctx(predecessor, deposit, secs).build());
}

fn set_with_results(secs: u64, results: Vec<PromiseResult>) {
    testing_env!(
        ctx(me().as_str(), 0, secs).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn ok_json(v: serde_json::Value) -> PromiseResult {
    PromiseResult::Successful(v.to_string().into_bytes())
}

/// (receiver, method, args) of every function call the contract created.
fn calls() -> Vec<(String, String, serde_json::Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, .. } => Some((
                    receiver.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap_or(serde_json::Value::Null),
                )),
                _ => None,
            })
        })
        .collect()
}

fn logs_contain(s: &str) -> bool {
    get_logs().iter().any(|l| l.contains(s))
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

struct Passkey(SigningKey);

impl Passkey {
    fn new() -> Self {
        Passkey(SigningKey::from_bytes(&[7u8; 32].into()).unwrap())
    }
    fn public(&self) -> Vec<u8> {
        self.0.verifying_key().to_encoded_point(true).as_bytes().to_vec()
    }
    fn assert(&self, request: &str) -> Assertion {
        let challenge = request_digest(request);
        let mut auth = vec![0u8; 32];
        auth.push(0x05);
        auth.extend_from_slice(&[0, 0, 0, 1]);
        let cdj = json!({ "type": "webauthn.get", "challenge": URL_SAFE_NO_PAD.encode(challenge), "origin": "https://parry.test" })
            .to_string();
        let mut signed = auth.clone();
        signed.extend_from_slice(&Sha256::digest(cdj.as_bytes()));
        let sig: Signature = self.0.sign(&signed);
        Assertion {
            authenticator_data: URL_SAFE_NO_PAD.encode(&auth),
            client_data_json: cdj,
            signature: hex::encode(sig.to_bytes()),
        }
    }
}

struct Guardian(ed25519_dalek::SigningKey);

impl Guardian {
    fn new(seed: u8) -> Self {
        Guardian(ed25519_dalek::SigningKey::from_bytes(&[seed; 32]))
    }
    fn key(&self) -> String {
        format!("ed25519:{}", near_sdk::bs58::encode(self.0.verifying_key().as_bytes()).into_string())
    }
    fn sign(&self, envelope: &str) -> Base64VecU8 {
        Base64VecU8(self.0.sign(&envelope_digest(envelope)).to_bytes().to_vec())
    }
}

fn mandate(g: &Guardian) -> Mandate {
    Mandate {
        guardian_key: g.key(),
        powers: vec![
            Power::Repay,
            Power::AddCollateral,
            Power::Deleverage,
            Power::HlReduce,
            Power::HlHedge,
            Power::EvmRepay,
        ],
        limits: vec![
            TokenLimit { token: id("usdc.parry.testnet"), reserve: U128(100 * USDC), daily: U128(60 * USDC) },
            TokenLimit { token: id("wrap.testnet"), reserve: U128(20 * NEAR), daily: U128(50 * NEAR) },
        ],
        max_actions_per_day: 5,
        min_health_after_bps: 11_000,
        max_slippage_bps: 200,
        hl: Some(HlGuard {
            asset: "NEAR".into(),
            asset_index: 54,
            max_size_e8: U128(100 * 100_000_000),
            band_bps: 200,
            hedge_is_buy: false,
        }),
        evm: Some(EvmGuard {
            chain_id: 11_155_111,
            pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951".into(),
            asset: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8".into(),
            address: "0x1111111111111111111111111111111111111111".into(),
            max_amount: U128(50 * USDC),
        }),
        sealed: Some(Base64VecU8(vec![1, 2, 3])),
        expires_at: NOW + 7 * 86_400,
    }
}

fn near_owned() -> Account {
    set("factory.testnet", 0, NOW);
    // The mocked chain keeps storage across contracts in one test: start every account clean.
    near_sdk::env::storage_remove(b"rt");
    Account::new(Owner::Near { account_id: id("alice.testnet") }, "testnet".into(), protocol())
}

/// A NEAR-owned account with the guardian's mandate set.
fn with_mandate(g: &Guardian) -> Account {
    let mut a = near_owned();
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::SetMandate { mandate: mandate(g) }]);
    a
}

fn envelope(nonce: u64, action: GuardianAction) -> String {
    serde_json::to_string(&GuardianEnvelope {
        account: me(),
        network: "testnet".into(),
        nonce,
        issued_at: NOW,
        review_hash: "5e".repeat(32),
        trigger: Trigger { score: 81, tier: "critical".into(), health_bps: 10_420 },
        action,
    })
    .unwrap()
}

fn run_guardian(a: &mut Account, g: &Guardian, nonce: u64, action: GuardianAction) {
    let e = envelope(nonce, action);
    set("relayer.parry.testnet", 0, NOW + 5);
    a.guardian_execute(e.clone(), g.sign(&e));
}

fn repay(amount: u128) -> GuardianAction {
    GuardianAction::Repay { token: id("usdc.parry.testnet"), amount: U128(amount) }
}

// ---------------------------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------------------------

#[test]
fn passkey_request_runs_once() {
    let pk = Passkey::new();
    set("factory.testnet", 0, NOW);
    let mut a = Account::new(Owner::Passkey { key: pk.public() }, "testnet".into(), protocol());
    let g = Guardian::new(1);
    let request = serde_json::to_string(&json!({
        "account": me(), "network": "testnet", "nonce": 1, "created_at": NOW,
        "actions": [{ "set_mandate": { "mandate": mandate(&g) } }],
    }))
    .unwrap();
    set("relayer.parry.testnet", 0, NOW + 3);
    a.owner_execute(request.clone(), pk.assert(&request));
    assert!(a.mandate().is_some());
    assert!(logs_contain("\"event\":\"mandate_set\""));
    let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        a.owner_execute(request.clone(), pk.assert(&request));
    }));
    assert!(replay.is_err(), "a used nonce must be refused");
}

#[test]
#[should_panic(expected = "passkey signature does not verify")]
fn passkey_signature_must_match_the_request() {
    let pk = Passkey::new();
    set("factory.testnet", 0, NOW);
    let mut a = Account::new(Owner::Passkey { key: pk.public() }, "testnet".into(), protocol());
    let request = json!({ "account": me(), "network": "testnet", "nonce": 1, "created_at": NOW, "actions": [{"revoke_mandate": null}] }).to_string();
    let other = json!({ "account": me(), "network": "testnet", "nonce": 2, "created_at": NOW, "actions": [{"revoke_mandate": null}] }).to_string();
    a.owner_execute(request, pk.assert(&other));
}

#[test]
#[should_panic(expected = "request is for another account")]
fn passkey_request_is_bound_to_the_account() {
    let pk = Passkey::new();
    set("factory.testnet", 0, NOW);
    let mut a = Account::new(Owner::Passkey { key: pk.public() }, "testnet".into(), protocol());
    let request = json!({ "account": "0u-other.testnet", "network": "testnet", "nonce": 1, "created_at": NOW, "actions": ["revoke_mandate"] }).to_string();
    a.owner_execute(request.clone(), pk.assert(&request));
}

#[test]
#[should_panic(expected = "request expired")]
fn passkey_request_expires() {
    let pk = Passkey::new();
    set("factory.testnet", 0, NOW);
    let mut a = Account::new(Owner::Passkey { key: pk.public() }, "testnet".into(), protocol());
    let request = json!({ "account": me(), "network": "testnet", "nonce": 1, "created_at": NOW - 601, "actions": ["revoke_mandate"] }).to_string();
    a.owner_execute(request.clone(), pk.assert(&request));
}

#[test]
#[should_panic(expected = "owner only")]
fn near_owner_only() {
    let mut a = near_owned();
    set("mallory.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::RevokeMandate]);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn near_owner_needs_a_full_access_key() {
    let mut a = near_owned();
    set("alice.testnet", 0, NOW);
    a.owner_call(vec![OwnerAction::RevokeMandate]);
}

#[test]
fn mandate_validation() {
    let g = Guardian::new(1);
    type Edit = Box<dyn Fn(&mut Mandate)>;
    let cases: Vec<(Edit, &str)> = vec![
        (Box::new(|m| m.powers.clear()), "at least one power"),
        (Box::new(|m| m.expires_at = NOW - 1), "already expired"),
        (Box::new(|m| m.expires_at = NOW + 181 * 86_400), "at most 180 days"),
        (Box::new(|m| m.max_slippage_bps = 301), "slippage is capped"),
        (Box::new(|m| m.min_health_after_bps = 10_400), "at least 1.05"),
        (Box::new(|m| m.hl = None), "need a Hyperliquid guard"),
        (Box::new(|m| m.guardian_key = "secp256k1:abc".into()), "guardian key"),
        (Box::new(|m| m.limits.push(m.limits[0].clone())), "duplicate token limit"),
        (Box::new(|m| m.limits[0].token = id("other.testnet")), "does not list"),
    ];
    for (edit, want) in cases {
        let mut a = near_owned();
        let mut m = mandate(&g);
        edit(&mut m);
        set("alice.testnet", 1, NOW);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            a.owner_call(vec![OwnerAction::SetMandate { mandate: m }]);
        }));
        let msg = r.err().and_then(|e| e.downcast_ref::<String>().cloned()).unwrap_or_default();
        assert!(msg.contains(want), "expected '{want}', got '{msg}'");
    }
}

#[test]
fn owner_lending_actions_go_to_the_lending_contract() {
    let mut a = near_owned();
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![
        OwnerAction::Supply { token: id("wrap.testnet"), amount: U128(10 * NEAR) },
        OwnerAction::Borrow { token: id("usdc.parry.testnet"), amount: U128(5 * USDC) },
    ]);
    let c = calls();
    assert_eq!(c[0].0, "wrap.testnet");
    assert_eq!(c[0].2["receiver_id"], "lending.parry.testnet");
    assert_eq!(c[0].2["msg"], "\"OnlyIncreaseCollateral\"");
    assert_eq!(c[1].0, "lending.parry.testnet");
    assert_eq!(c[1].1, "execute_with_pyth");
    // 5 USDC in inner units (6 + 12 decimals).
    assert_eq!(c[1].2["actions"][0]["Borrow"]["amount"], "5000000000000000000");
}

// ---------------------------------------------------------------------------------------------
// Guardian: what it may do
// ---------------------------------------------------------------------------------------------

#[test]
fn guardian_repays_from_the_reserve_and_emits_the_review_hash() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, repay(10 * USDC));
    let c = calls();
    assert_eq!(c[0].0, "usdc.parry.testnet");
    assert_eq!(c[0].1, "ft_transfer_call");
    assert_eq!(c[0].2["receiver_id"], "lending.parry.testnet");
    assert_eq!(c[0].2["msg"], "\"OnlyRepay\"");
    assert!(logs_contain("\"event\":\"guardian_acted\""));
    assert!(logs_contain(&"5e".repeat(32)));
    assert_eq!(a.nonces().1, 1);
}

#[test]
fn guardian_adds_collateral() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(
        &mut a,
        &g,
        1,
        GuardianAction::AddCollateral { token: id("wrap.testnet"), amount: U128(2 * NEAR) },
    );
    let c = calls();
    assert_eq!(c[0].0, "wrap.testnet");
    assert_eq!(c[0].2["msg"], "\"OnlyIncreaseCollateral\"");
}

#[test]
fn unused_repay_returns_to_the_caps() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, repay(40 * USDC));
    // The lending contract used only 15 USDC (the debt was smaller).
    set_with_results(NOW + 6, vec![ok_json(json!("15000000"))]);
    let used = a.on_guardian_settled(1, "repay".into(), id("usdc.parry.testnet"), U128(40 * USDC));
    assert_eq!(used.0, 15 * USDC);
    let view = a.mandate().unwrap();
    assert_eq!(view.spent[0].1 .0, 15 * USDC);
    assert_eq!(view.moved_today[0].1 .0, 15 * USDC);
}

// ---------------------------------------------------------------------------------------------
// Guardian: what it must be refused
// ---------------------------------------------------------------------------------------------

fn refused(a: &mut Account, envelope: &str, sig: Base64VecU8, secs: u64) -> String {
    set("relayer.parry.testnet", 0, secs);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        a.guardian_execute(envelope.to_string(), sig);
    }));
    r.err().and_then(|e| e.downcast_ref::<String>().cloned()).unwrap_or_else(|| "accepted".into())
}

#[test]
fn guardian_refusals() {
    let g = Guardian::new(1);
    let ok = envelope(1, repay(USDC));

    // Wrong key.
    let mut a = with_mandate(&g);
    assert!(refused(&mut a, &ok, Guardian::new(2).sign(&ok), NOW + 5).contains("does not verify"));
    // Tampered envelope.
    let tampered = ok.replace("\"amount\":\"1000000\"", "\"amount\":\"9000000\"");
    assert!(refused(&mut a, &tampered, g.sign(&ok), NOW + 5).contains("does not verify"));
    // Stale envelope.
    assert!(refused(&mut a, &ok, g.sign(&ok), NOW + 121).contains("envelope expired"));
    // No review hash.
    let no_review = ok.replace(&"5e".repeat(32), &"0".repeat(64));
    assert!(refused(&mut a, &no_review, g.sign(&no_review), NOW + 5).contains("AI review hash"));
    // Envelope for another account.
    let other = ok.replace(me().as_str(), "0u-other.testnet");
    assert!(refused(&mut a, &other, g.sign(&other), NOW + 5).contains("another account"));
    // Replayed nonce.
    assert_eq!(refused(&mut a, &ok, g.sign(&ok), NOW + 5), "accepted");
    assert!(refused(&mut a, &ok, g.sign(&ok), NOW + 6).contains("nonce already used"));
}

#[test]
fn guardian_can_never_withdraw_or_transfer_out() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    for action in [
        json!({ "withdraw": { "token": "usdc.parry.testnet", "amount": "1", "receiver": "eve.testnet" } }),
        json!({ "transfer": { "receiver_id": "eve.testnet", "amount": "1" } }),
        json!({ "ft_transfer": { "token": "usdc.parry.testnet", "receiver_id": "eve.testnet", "amount": "1" } }),
        json!({ "call": { "receiver_id": "usdc.parry.testnet", "method_name": "ft_transfer" } }),
    ] {
        let e = json!({
            "account": me(), "network": "testnet", "nonce": 1, "issued_at": NOW,
            "review_hash": "5e".repeat(32), "trigger": { "score": 90, "tier": "critical", "health_bps": 10_100 },
            "action": action,
        })
        .to_string();
        assert!(refused(&mut a, &e, g.sign(&e), NOW + 5).contains("bad envelope"), "{action}");
    }
    // Nor can it reach the owner's entry points: the guardian has no NEAR key on the account,
    // and the owner entry point checks the caller.
    set("relayer.parry.testnet", 1, NOW);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        a.owner_call(vec![OwnerAction::Transfer { receiver_id: id("eve.testnet"), amount: U128(1) }]);
    }));
    assert!(r.is_err());
}

#[test]
fn guardian_caps_and_expiry() {
    let g = Guardian::new(1);
    // Daily cap: 60 USDC.
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, repay(50 * USDC));
    let over = envelope(2, repay(11 * USDC));
    assert!(refused(&mut a, &over, g.sign(&over), NOW + 5).contains("daily cap"));
    // The next UTC day the daily cap resets, but the 100 USDC reserve still binds.
    let tomorrow = NOW + 86_400;
    let e = |n: u64, amt: u128| {
        serde_json::to_string(&GuardianEnvelope {
            account: me(),
            network: "testnet".into(),
            nonce: n,
            issued_at: tomorrow,
            review_hash: "5e".repeat(32),
            trigger: Trigger { score: 81, tier: "critical".into(), health_bps: 10_420 },
            action: repay(amt),
        })
        .unwrap()
    };
    let x = e(3, 50 * USDC);
    assert_eq!(refused(&mut a, &x, g.sign(&x), tomorrow), "accepted");
    let y = e(4, USDC);
    assert!(refused(&mut a, &y, g.sign(&y), tomorrow).contains("reserve exhausted"));

    // Action count per day.
    let mut b = with_mandate(&g);
    for n in 1..=5 {
        run_guardian(&mut b, &g, n, repay(USDC));
    }
    let sixth = envelope(6, repay(USDC));
    assert!(refused(&mut b, &sixth, g.sign(&sixth), NOW + 5).contains("daily action limit"));

    // Expiry.
    let mut c = with_mandate(&g);
    let late = NOW + 7 * 86_400;
    let e = serde_json::to_string(&GuardianEnvelope {
        account: me(),
        network: "testnet".into(),
        nonce: 1,
        issued_at: late,
        review_hash: "5e".repeat(32),
        trigger: Trigger { score: 81, tier: "critical".into(), health_bps: 10_420 },
        action: repay(USDC),
    })
    .unwrap();
    assert!(refused(&mut c, &e, g.sign(&e), late).contains("mandate expired"));

    // A token without a limit.
    let mut d = with_mandate(&g);
    let lin = envelope(1, GuardianAction::Repay { token: id("linear-protocol.testnet"), amount: U128(1) });
    assert!(refused(&mut d, &lin, g.sign(&lin), NOW + 5).contains("not in the protocol"));
}

#[test]
fn owner_overrides_the_guardian() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::PauseGuardian { until: NOW + 3_600 }]);
    let e = envelope(1, repay(USDC));
    assert!(refused(&mut a, &e, g.sign(&e), NOW + 5).contains("paused by the owner"));
    set("alice.testnet", 1, NOW + 6);
    a.owner_call(vec![OwnerAction::PauseGuardian { until: 0 }, OwnerAction::RevokeMandate]);
    assert!(logs_contain("mandate_revoked"));
    assert!(refused(&mut a, &e, g.sign(&e), NOW + 7).contains("no mandate"));
}

#[test]
fn powers_not_granted_are_refused() {
    let g = Guardian::new(1);
    let mut a = near_owned();
    let mut m = mandate(&g);
    m.powers = vec![Power::Repay];
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::SetMandate { mandate: m }]);
    let e = envelope(1, GuardianAction::AddCollateral { token: id("wrap.testnet"), amount: U128(NEAR) });
    assert!(refused(&mut a, &e, g.sign(&e), NOW + 5).contains("does not grant"));
}

// ---------------------------------------------------------------------------------------------
// Hyperliquid and EVM guards
// ---------------------------------------------------------------------------------------------

fn order(is_buy: bool, reduce_only: bool, price: &str, size: &str) -> HlOrder {
    HlOrder {
        asset_index: 54,
        is_buy,
        price: price.into(),
        size: size.into(),
        reduce_only,
        tif: "Ioc".into(),
    }
}

#[test]
fn hyperliquid_guard() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let not_reduce =
        envelope(1, GuardianAction::HlReduce { order: order(true, false, "3.6", "10"), nonce: 9 });
    assert!(refused(&mut a, &not_reduce, g.sign(&not_reduce), NOW + 5).contains("reduce-only"));
    let too_big = envelope(1, GuardianAction::HlReduce { order: order(true, true, "3.6", "101"), nonce: 9 });
    assert!(refused(&mut a, &too_big, g.sign(&too_big), NOW + 5).contains("size cap"));
    let wrong_side =
        envelope(1, GuardianAction::HlHedge { order: order(true, false, "3.6", "10"), nonce: 9 });
    assert!(refused(&mut a, &wrong_side, g.sign(&wrong_side), NOW + 5).contains("guard's side"));
    let mut wrong_asset = order(false, false, "3.6", "10");
    wrong_asset.asset_index = 3;
    let wa = envelope(1, GuardianAction::HlHedge { order: wrong_asset, nonce: 9 });
    assert!(refused(&mut a, &wa, g.sign(&wa), NOW + 5).contains("another asset"));

    // A hedge inside the guard asks the risk board for the mark.
    run_guardian(
        &mut a,
        &g,
        1,
        GuardianAction::HlHedge { order: order(false, false, "3.60", "10"), nonce: 9 },
    );
    let c = calls();
    assert_eq!(c[0].0, "risk.parry.testnet");
    assert_eq!(c[0].1, "mark_of");
    assert_eq!(c[0].2["asset"], "NEAR");

    // Outside the 2% band of a fresh mark: refused with a logged reason, nothing signed.
    let mark = |price: &str, at: u64| {
        ok_json(json!({ "asset": "NEAR", "asset_index": 54, "price_e8": price, "at": at }))
    };
    set_with_results(NOW + 6, vec![mark("340000000", NOW)]);
    let _ = a.on_hl_mark(1, "hedge".into(), order(false, false, "3.60", "10"), 9);
    assert!(logs_contain("guardian_refused") && logs_contain("outside the band"));
    assert!(calls().is_empty());

    // A stale mark is refused too.
    set_with_results(NOW + 400, vec![mark("360000000", NOW)]);
    let _ = a.on_hl_mark(1, "hedge".into(), order(false, false, "3.60", "10"), 9);
    assert!(logs_contain("stale"));

    // Inside the band: Chain Signatures signs the digest built on chain.
    set_with_results(NOW + 6, vec![mark("361000000", NOW)]);
    let _ = a.on_hl_mark(1, "hedge".into(), order(false, false, "3.60", "10"), 9);
    let c = calls();
    assert_eq!(c[0].0, "v1.signer-prod.testnet");
    assert_eq!(c[0].2["request"]["path"], "parry-hyperliquid");
    let digest =
        hex::encode(parry_common::hyperliquid::order_digest(&order(false, false, "3.60", "10"), 9, false));
    assert_eq!(c[0].2["request"]["payload_v2"]["Ecdsa"], digest);
}

#[test]
fn evm_guard_builds_only_approve_and_repay() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let params = EvmTxParams {
        nonce: 3,
        max_priority_fee_per_gas: "1000000000".into(),
        max_fee_per_gas: "30000000000".into(),
        gas_limit: 300_000,
    };
    let over = envelope(1, GuardianAction::EvmRepay { params: params.clone(), amount: U128(51 * USDC) });
    assert!(refused(&mut a, &over, g.sign(&over), NOW + 5).contains("outside the EVM guard"));

    run_guardian(&mut a, &g, 1, GuardianAction::EvmRepay { params: params.clone(), amount: U128(20 * USDC) });
    let log = get_logs().into_iter().find(|l| l.contains("evm_signed")).unwrap();
    let c = calls();
    assert_eq!(c[0].0, "v1.signer-prod.testnet");
    assert_eq!(c[0].2["request"]["path"], "parry-evm");
    let ev: serde_json::Value = serde_json::from_str(log.trim_start_matches("EVENT_JSON:")).unwrap();
    let tx = hex::decode(ev["data"]["unsigned_tx"].as_str().unwrap()).unwrap();
    let hash = ev["data"]["hash"].as_str().unwrap();
    assert_eq!(hash, hex::encode(near_sdk::env::keccak256_array(&tx)));
    assert_eq!(c[0].2["request"]["payload_v2"]["Ecdsa"], hash);
    // The repay is sent to the guard's pool, on behalf of the person's own address.
    let tx_hex = hex::encode(&tx);
    assert!(tx_hex.contains(&"6Ae43d3271ff6888e7Fc43Fd7321a503ff738951".to_lowercase()));
    assert!(tx_hex.contains("573ade81"));
    assert!(tx_hex.contains("1111111111111111111111111111111111111111"));
}

// ---------------------------------------------------------------------------------------------
// Deleverage chain
// ---------------------------------------------------------------------------------------------

fn delev(min_out_usdc: u128) -> GuardianAction {
    GuardianAction::Deleverage {
        collateral: id("wrap.testnet"),
        amount: U128(10 * NEAR),
        pool_id: 7,
        debt: id("usdc.parry.testnet"),
        min_out: U128(min_out_usdc),
    }
}

fn near_mark(price_e8: &str, at: u64) -> PromiseResult {
    ok_json(json!([{ "asset": "NEAR", "asset_index": 54, "price_e8": price_e8, "at": at }]))
}

#[test]
fn deleverage_happy_path() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    // 10 NEAR at $3.00 = 30 USDC; 2% slippage allows 29.4 USDC.
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    assert_eq!(a.pending().unwrap().stage, "pricing");
    assert_eq!(calls()[0].1, "marks");

    set_with_results(NOW + 6, vec![near_mark("300000000", NOW)]);
    a.on_delev_marks(1);
    let c = calls();
    assert_eq!((c[0].0.as_str(), c[0].1.as_str()), ("lending.parry.testnet", "simple_withdraw"));
    assert_eq!(c[0].2["amount_with_inner_decimal"], (10 * NEAR).to_string());

    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    let c = calls();
    assert_eq!(
        (c[0].0.as_str(), c[0].2["receiver_id"].as_str().unwrap()),
        ("wrap.testnet", "ref-finance-101.testnet")
    );

    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    let c = calls();
    assert_eq!(c[0].1, "swap");
    assert_eq!(c[0].2["actions"][0]["min_amount_out"], "29500000");

    set_with_results(NOW + 10, vec![ok_json(json!("29800000"))]);
    a.on_delev_swapped(1);
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["token_id"].as_str().unwrap()), ("withdraw", "usdc.parry.testnet"));

    set_with_results(NOW + 11, vec![ok_json(json!("29800000"))]);
    a.on_delev_out(1);
    let c = calls();
    assert_eq!(c[0].2["msg"], "\"OnlyRepay\"");

    set_with_results(NOW + 12, vec![ok_json(json!("29800000"))]);
    a.on_delev_repaid(1);
    assert_eq!(calls()[0].1, "get_account");

    let position = json!({
        "account_id": me(), "supplied": [],
        "collateral": [{ "token_id": "wrap.testnet", "balance": (90 * NEAR).to_string() }],
        "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": "120200000000000000000" }],
    });
    set_with_results(NOW + 13, vec![ok_json(position.clone())]);
    a.on_delev_position(1, U128(29_800_000));
    let c = calls();
    assert_eq!(c.iter().filter(|x| x.1 == "get_price_no_older_than").count(), 2);

    let price = |p: i64| {
        ok_json(json!({ "price": p.to_string(), "conf": "1", "expo": -8, "publish_time": NOW as i64 }))
    };
    let asset = |ratio: u32| ok_json(json!({ "config": { "volatility_ratio": ratio, "extra_decimals": 0 } }));
    // wNEAR then USDC: price, asset config each.
    set_with_results(NOW + 14, vec![price(300_000_000), asset(6000), price(100_000_000), asset(9500)]);
    let tokens = vec![id("wrap.testnet"), id("usdc.parry.testnet")];
    // 90 NEAR × $3 × 0.6 = 162; 120.2 / 0.95 = 126.53; health 1.28 ≥ floor 1.10.
    assert!(a.on_delev_health(1, U128(29_800_000), position.to_string(), tokens));
    assert!(logs_contain("deleverage_completed"));
    assert!(a.pending().is_none());
}

#[test]
fn deleverage_refuses_a_cheap_sale() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(25_000_000));
    set_with_results(NOW + 6, vec![near_mark("300000000", NOW)]);
    a.on_delev_marks(1);
    assert!(calls().is_empty());
    assert!(logs_contain("slippage bound") && logs_contain("deleverage_rolled_back"));
    assert!(a.pending().is_none());
    // The collateral no longer counts against the day's cap.
    assert_eq!(a.mandate().unwrap().moved_today[0].1 .0, 0);
}

#[test]
fn deleverage_rolls_back_when_the_withdraw_fails() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, vec![near_mark("300000000", NOW)]);
    a.on_delev_marks(1);
    set_with_results(NOW + 8, vec![PromiseResult::Failed]);
    a.on_delev_withdrawn(1);
    let c = calls();
    assert_eq!(
        (c[0].1.as_str(), c[0].2["actions"][0]["IncreaseCollateral"]["token_id"].as_str().unwrap()),
        ("execute", "wrap.testnet")
    );
    assert!(logs_contain("deleverage_rolled_back"));
    assert!(a.pending().is_none());
}

#[test]
fn deleverage_restores_collateral_when_the_swap_fails() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, vec![near_mark("300000000", NOW)]);
    a.on_delev_marks(1);
    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    // The pool moved: the swap fails its minimum.
    set_with_results(NOW + 10, vec![PromiseResult::Failed]);
    a.on_delev_swapped(1);
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["token_id"].as_str().unwrap()), ("withdraw", "wrap.testnet"));
    set_with_results(NOW + 11, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_restore_withdrawn(1, U128(10 * NEAR));
    let c = calls();
    assert_eq!(c[0].2["msg"], "\"OnlyIncreaseCollateral\"");
    set_with_results(NOW + 12, vec![ok_json(json!((10 * NEAR).to_string()))]);
    assert!(a.on_restored(1));
    assert!(logs_contain("deleverage_rolled_back"));
    assert!(a.pending().is_none());
}

#[test]
fn stuck_deleverage_can_be_retried_by_anyone() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, vec![near_mark("300000000", NOW)]);
    a.on_delev_marks(1);
    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    set_with_results(NOW + 10, vec![ok_json(json!("29800000"))]);
    a.on_delev_swapped(1);
    // The exchange could not send the USDC (it re-credited the deposit).
    set_with_results(NOW + 11, vec![ok_json(json!("0"))]);
    a.on_delev_out(1);
    assert_eq!(a.pending().unwrap().stage, "stuck_withdraw_out");
    // A new guardian action waits until it is settled.
    let e = envelope(2, repay(USDC));
    assert!(refused(&mut a, &e, g.sign(&e), NOW + 12).contains("in flight"));
    set("anyone.testnet", 0, NOW + 13);
    a.retry_deleverage();
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["amount"].as_str().unwrap()), ("withdraw", "29800000"));
}

#[test]
fn unsafe_deleverage_pauses_the_guardian() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    // Fast-forward the chain to the health check.
    let mut rt = load_runtime();
    rt.pending.as_mut().unwrap().stage = "verify".into();
    save_runtime(&rt);
    let position = json!({
        "collateral": [{ "token_id": "wrap.testnet", "balance": (50 * NEAR).to_string() }],
        "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": "120000000000000000000" }],
    });
    let price = |p: i64| {
        ok_json(json!({ "price": p.to_string(), "conf": "1", "expo": -8, "publish_time": NOW as i64 }))
    };
    let asset = |ratio: u32| ok_json(json!({ "config": { "volatility_ratio": ratio } }));
    set_with_results(NOW + 14, vec![price(300_000_000), asset(6000), price(100_000_000), asset(9500)]);
    // 50 × 3 × 0.6 = 90 against 126.3: health 0.71, under the 1.10 floor.
    let safe = a.on_delev_health(
        1,
        U128(1),
        position.to_string(),
        vec![id("wrap.testnet"), id("usdc.parry.testnet")],
    );
    assert!(!safe);
    assert!(logs_contain("deleverage_unsafe") && logs_contain("guardian_paused"));
    let e = envelope(2, repay(USDC));
    assert!(refused(&mut a, &e, g.sign(&e), NOW + 20).contains("paused"));
}
