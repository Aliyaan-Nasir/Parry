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
            chain_id: 84_532,
            pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27".into(),
            asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f".into(),
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
    assert!(tx_hex.contains(&"8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27".to_lowercase()));
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

fn oracle_price(price_e8: i64) -> PromiseResult {
    ok_json(json!({ "price": price_e8.to_string(), "conf": "1", "expo": -8, "publish_time": NOW as i64 }))
}

/// The oracle's answers that price a wNEAR to USDC swap: NEAR at `near_e8`, USDC at 1.00.
fn swap_prices(near_e8: i64) -> Vec<PromiseResult> {
    vec![oracle_price(near_e8), oracle_price(100_000_000)]
}

#[test]
fn deleverage_happy_path() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    // 10 NEAR at $3.00 = 30 USDC; 2% slippage allows 29.4 USDC.
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    assert_eq!(a.pending().unwrap().stage, "pricing");
    // Priced by the protocol's oracle, not by the enclave's marks.
    let c: Vec<_> = calls().into_iter().filter(|x| x.0 != me().as_str()).collect();
    assert_eq!(c.len(), 2);
    assert!(c.iter().all(|x| x.0 == "oracle.parry.testnet" && x.1 == "get_price_no_older_than"));

    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
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

/// A plan priced under the fresh oracle floor is not refused: the swap demands the floor, so a
/// signed envelope still cannot sell collateral cheaply, and a pool that pays less rolls it back.
#[test]
fn deleverage_never_sells_below_the_fresh_floor() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(25_000_000));
    // 10 NEAR at $3.00 = 30 USDC; 2% slippage puts the floor at 29.4 USDC.
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
    assert!(logs_contain("deleverage_floor_raised"));
    assert_eq!(a.pending().unwrap().min_out, U128(29_400_000));
    assert_eq!(calls()[0].1, "simple_withdraw");
    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    assert_eq!(calls()[0].2["actions"][0]["min_amount_out"], "29400000");
    // The pool pays only the plan's 25 USDC: under the floor, so the collateral goes back.
    set_with_results(NOW + 10, vec![ok_json(json!("25000000"))]);
    a.on_delev_swapped(1);
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["token_id"].as_str().unwrap()), ("withdraw", "wrap.testnet"));
}

/// The guardian plans at the price of a minute earlier. When the price has risen since, the
/// plan's minimum is under the fresh floor: the rescue goes ahead at the floor instead of failing.
#[test]
fn deleverage_proceeds_when_the_price_rose_after_planning() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    // Planned at $3.00: 29.5 USDC for 10 NEAR. The oracle now says $3.05: the floor is 29.89.
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, swap_prices(305_000_000));
    a.on_delev_prices(1);
    assert!(logs_contain("deleverage_floor_raised") && !logs_contain("deleverage_rolled_back"));
    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    assert_eq!(calls()[0].2["actions"][0]["min_amount_out"], "29890000");
    set_with_results(NOW + 10, vec![ok_json(json!("30400000"))]);
    a.on_delev_swapped(1);
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["token_id"].as_str().unwrap()), ("withdraw", "usdc.parry.testnet"));
}

#[test]
fn deleverage_rolls_back_when_the_withdraw_fails() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
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
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
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
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
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

// ---------------------------------------------------------------------------------------------
// Audit regressions
// ---------------------------------------------------------------------------------------------

fn panic_text(f: impl FnOnce()) -> String {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .err()
        .and_then(|e| e.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "accepted".into())
}

/// Runs `guardian_execute` with `tgas` of prepaid gas and returns the panic text.
fn execute_with_gas(a: &mut Account, g: &Guardian, nonce: u64, action: GuardianAction, tgas: u64) -> String {
    let e = envelope(nonce, action);
    testing_env!(ctx("relayer.parry.testnet", 0, NOW + 5)
        .prepaid_gas(near_sdk::Gas::from_tgas(tgas))
        .build());
    panic_text(|| {
        a.guardian_execute(e.clone(), g.sign(&e));
    })
}

/// Anyone may relay a signed envelope, with the gas they choose. A deleverage relayed with too
/// little gas would run out in a later callback, after the collateral left the lending contract,
/// and stay stuck outside the position; it is refused up front instead.
#[test]
fn audit_deleverage_needs_gas_for_its_whole_chain() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let want = guardian::deleverage_gas(2).as_tgas();
    assert_eq!(want, 710);
    let msg = execute_with_gas(&mut a, &g, 1, delev(29_500_000), 300);
    assert!(msg.contains("attach at least 710 TGas"), "{msg}");
    assert!(a.pending().is_none());
    assert_eq!(execute_with_gas(&mut a, &g, 1, delev(29_500_000), want), "accepted");
    assert_eq!(a.pending().unwrap().stage, "pricing");
}

/// The same for a perp order: its signature request runs in a callback.
#[test]
fn audit_perp_order_needs_gas_for_its_signature() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let hedge = || GuardianAction::HlHedge { order: order(false, false, "3.60", "10"), nonce: 9 };
    let msg = execute_with_gas(&mut a, &g, 1, hedge(), 100);
    assert!(msg.contains("attach at least 140 TGas"), "{msg}");
    assert_eq!(a.nonces().1, 0, "the refused envelope consumed nothing");
    assert_eq!(execute_with_gas(&mut a, &g, 1, hedge(), 140), "accepted");
}

/// `retry_deleverage` is open to anyone: with too little gas it could move the tokens out of
/// the exchange and then fail before repaying, leaving a state no retry resumes.
#[test]
fn audit_retry_needs_gas_for_the_rest_of_the_chain() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    set_with_results(NOW + 10, vec![ok_json(json!("29800000"))]);
    a.on_delev_swapped(1);
    set_with_results(NOW + 11, vec![ok_json(json!("0"))]);
    a.on_delev_out(1);
    assert_eq!(a.pending().unwrap().stage, "stuck_withdraw_out");
    testing_env!(ctx("anyone.testnet", 0, NOW + 13).prepaid_gas(near_sdk::Gas::from_tgas(100)).build());
    let msg = panic_text(|| {
        a.retry_deleverage();
    });
    assert!(msg.contains("attach at least 320 TGas"), "{msg}");
}

/// A guardian perp order may not rest on the book: a resting order at a price far from
/// the market could be filled by anyone, so the band around the enclave's own mark would be the
/// only bound on the price.
#[test]
fn audit_guardian_perp_orders_are_immediate_or_cancel() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    for tif in ["Gtc", "Alo"] {
        let mut o = order(true, true, "3.60", "10");
        o.tif = tif.into();
        let e = envelope(1, GuardianAction::HlReduce { order: o, nonce: 9 });
        assert!(refused(&mut a, &e, g.sign(&e), NOW + 5).contains("immediate-or-cancel"), "{tif}");
    }
}

/// The fee fields of a transaction the account signs for another chain are the guardian's
/// choice. The priority fee goes to the block producer, so it is capped, and so is the gas limit.
#[test]
fn audit_signed_transaction_fees_are_capped() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let params = |tip: &str, max: &str, gas_limit: u64| EvmTxParams {
        nonce: 3,
        max_priority_fee_per_gas: tip.into(),
        max_fee_per_gas: max.into(),
        gas_limit,
    };
    let cases = [
        (params("21000000000", "100000000000", 300_000), "20 gwei cap"),
        (params("2000000000", "1000000000", 300_000), "above the max fee"),
        (params("1000000000", "30000000000", 600_001), "gas limit"),
        (params("1000000000", "30000000000", 0), "gas limit"),
    ];
    for (p, want) in cases {
        let e = envelope(1, GuardianAction::EvmRepay { params: p, amount: U128(USDC) });
        let msg = refused(&mut a, &e, g.sign(&e), NOW + 5);
        assert!(msg.contains(want), "expected '{want}', got '{msg}'");
    }
    let e = envelope(
        1,
        GuardianAction::EvmApprove {
            params: params("20000000000", "20000000000", 600_000),
            amount: U128(USDC),
        },
    );
    assert_eq!(refused(&mut a, &e, g.sign(&e), NOW + 5), "accepted");
}

/// A protocol that also lists LiNEAR, priced as NEAR times its `ft_price` rate.
fn protocol_with_linear() -> Protocol {
    let mut p = protocol();
    p.tokens.push(TokenConfig {
        token_id: id("linear-protocol.testnet"),
        symbol: "LiNEAR".into(),
        decimals: 24,
        extra_decimals: 0,
        price_id: NEAR_USD.into(),
        rate_call: Some("ft_price".into()),
        mark: Some("NEAR".into()),
    });
    p
}

/// A staked token is worth its rate times the NEAR price. Pricing the swap without the rate
/// would let a deleverage sell LiNEAR for the value of as much NEAR, about a fifth too cheap.
#[test]
fn audit_deleverage_prices_a_staked_token_with_its_rate() {
    let g = Guardian::new(1);
    set("factory.testnet", 0, NOW);
    near_sdk::env::storage_remove(b"rt");
    let mut a = Account::new(
        Owner::Near { account_id: id("alice.testnet") },
        "testnet".into(),
        protocol_with_linear(),
    );
    let mut m = mandate(&g);
    m.limits.push(TokenLimit {
        token: id("linear-protocol.testnet"),
        reserve: U128(20 * NEAR),
        daily: U128(50 * NEAR),
    });
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::SetMandate { mandate: m }]);

    let sell_linear = |min_out: u128| GuardianAction::Deleverage {
        collateral: id("linear-protocol.testnet"),
        amount: U128(10 * NEAR),
        pool_id: 7,
        debt: id("usdc.parry.testnet"),
        min_out: U128(min_out),
    };
    // 10 LiNEAR at 1.25 NEAR each and $3.00 per NEAR: $37.50; 2% slippage allows $36.75.
    let answers = || {
        vec![
            oracle_price(300_000_000),
            ok_json(json!("1250000000000000000000000")),
            oracle_price(100_000_000),
        ]
    };
    run_guardian(&mut a, &g, 1, sell_linear(30 * USDC));
    let c = calls();
    assert!(c.iter().any(|x| x.0 == "linear-protocol.testnet" && x.1 == "ft_price"), "{c:?}");
    set_with_results(NOW + 6, answers());
    a.on_delev_prices(1);
    // 30 USDC for $37.50 of LiNEAR: the swap demands the floor the rate gives, not the plan.
    assert!(logs_contain("deleverage_floor_raised"));
    assert_eq!(a.pending().unwrap().min_out, U128(36_750_000));
    assert_eq!(calls()[0].1, "simple_withdraw");
}

/// When the lending contract refuses the collateral back, the rollback has not happened: the
/// deleverage stays pending (and blocks the guardian) until a retry re-supplies it.
#[test]
fn audit_refused_resupply_stays_pending_until_retried() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
    set_with_results(NOW + 8, vec![ok_json(json!(true))]);
    a.on_delev_withdrawn(1);
    set_with_results(NOW + 9, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_delev_deposited(1);
    set_with_results(NOW + 10, vec![PromiseResult::Failed]);
    a.on_delev_swapped(1);
    set_with_results(NOW + 11, vec![ok_json(json!((10 * NEAR).to_string()))]);
    a.on_restore_withdrawn(1, U128(10 * NEAR));
    // The lending contract returned all of it.
    set_with_results(NOW + 12, vec![ok_json(json!("0"))]);
    assert!(!a.on_restored(1));
    assert!(!logs_contain("deleverage_rolled_back"));
    assert!(logs_contain("deleverage_stuck"));
    assert_eq!(a.pending().unwrap().stage, "stuck_resupply");

    set("anyone.testnet", 0, NOW + 13);
    a.retry_deleverage();
    let c = calls();
    assert_eq!((c[0].0.as_str(), c[0].1.as_str()), ("wrap.testnet", "ft_transfer_call"));
    assert_eq!(c[0].2["receiver_id"], "lending.parry.testnet");
    assert_eq!(c[0].2["msg"], "\"OnlyIncreaseCollateral\"");
    set_with_results(NOW + 14, vec![ok_json(json!((10 * NEAR).to_string()))]);
    assert!(a.on_restored(1));
    assert!(logs_contain("deleverage_rolled_back"));
    assert!(a.pending().is_none());
}

/// A deleverage whose repay leg was refused sold collateral and repaid nothing: it is reported
/// as unsafe (and pauses the guardian), never as completed.
#[test]
fn audit_deleverage_that_repaid_nothing_is_not_completed() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    let position = json!({
        "collateral": [{ "token_id": "wrap.testnet", "balance": (90 * NEAR).to_string() }],
        "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": "120000000000000000000" }],
    });
    let asset = |ratio: u32| ok_json(json!({ "config": { "volatility_ratio": ratio } }));
    set_with_results(
        NOW + 14,
        vec![oracle_price(300_000_000), asset(6000), oracle_price(100_000_000), asset(9500)],
    );
    // Health 1.28 is above the floor, but nothing was repaid.
    let done = a.on_delev_health(
        1,
        U128(0),
        position.to_string(),
        vec![id("wrap.testnet"), id("usdc.parry.testnet")],
    );
    assert!(!done);
    assert!(logs_contain("deleverage_unsafe") && !logs_contain("deleverage_completed"));
}

/// The key that signs the envelope also signs the risk board's marks, so a swap priced with
/// those marks would let one key choose both the sale and the price it is checked against. The
/// swap is priced with the protocol's oracle (the one the lending contract liquidates with).
#[test]
fn audit_deleverage_is_priced_by_the_oracle_not_by_the_enclave_marks() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    run_guardian(&mut a, &g, 1, delev(25_000_000));
    let c = calls();
    assert!(!c.iter().any(|x| x.0 == "risk.parry.testnet"), "{c:?}");
    assert_eq!(c.iter().filter(|x| x.0 == "oracle.parry.testnet").count(), 2);
    // The oracle says $3.00: 25 USDC for 10 NEAR is below the 2% bound, so the swap demands 29.4.
    set_with_results(NOW + 6, swap_prices(300_000_000));
    a.on_delev_prices(1);
    assert_eq!(a.pending().unwrap().min_out, U128(29_400_000));
}

// ---------------------------------------------------------------------------------------------
// Close and unwind
// ---------------------------------------------------------------------------------------------

const INNER: u128 = 1_000_000_000_000; // USDC inner units per token unit (6 + 12 decimals)

fn wnear_priced() -> rhea::PricedAsset {
    rhea::PricedAsset {
        token_id: id("wrap.testnet"),
        inner_decimals: 24,
        volatility_ratio_bps: 7_500,
        price: parry_common::pyth::PythPrice {
            price: near_sdk::json_types::I64(300_000_000),
            conf: near_sdk::json_types::U64(1),
            expo: -8,
            publish_time: NOW as i64,
        },
        rate_e24: None,
    }
}

fn usdc_priced() -> rhea::PricedAsset {
    rhea::PricedAsset {
        token_id: id("usdc.parry.testnet"),
        inner_decimals: 18,
        volatility_ratio_bps: 9_500,
        price: parry_common::pyth::PythPrice {
            price: near_sdk::json_types::I64(100_000_000),
            conf: near_sdk::json_types::U64(1),
            expo: -8,
            publish_time: NOW as i64,
        },
        rate_e24: None,
    }
}

#[test]
fn close_plan_sells_just_enough_to_repay_everything() {
    // 100 NEAR at $3 against 50 USDC: health 3.4, one round closes it.
    let p = close::plan_close(100 * NEAR, 50 * USDC * INNER, &wnear_priced(), 0, &usdc_priced(), 12, 200)
        .unwrap();
    // The debt plus 0.5 bps and one unit for interest, rounded up to a USDC unit.
    assert_eq!(p.repay, 50 * USDC + 50 * USDC / 20_000 + 1);
    assert_eq!(p.min_out, p.repay);
    assert!(p.last);
    // Worth the repay plus 2% at the oracle price, rounded up to a yoctoNEAR.
    let want = p.repay * 10_200 * 1_000_000_000_000_000_000 / 30_000;
    assert!(p.sell.abs_diff(want) <= 1, "{} vs {want}", p.sell);
}

#[test]
fn close_plan_keeps_health_above_one_when_it_cannot_close_at_once() {
    // 100 NEAR at $3 against 150 USDC: health 1.425. Selling enough for all the debt would take
    // health under 1, which the lending contract refuses: the round sells what keeps it at 1.02.
    let p = close::plan_close(100 * NEAR, 150 * USDC * INNER, &wnear_priced(), 0, &usdc_priced(), 12, 200)
        .unwrap();
    assert!(!p.last);
    let left = (100 * NEAR - p.sell) as f64 / 1e24;
    let health = left * 3.0 * 0.75 / (150.0 / 0.95);
    assert!((1.0199..1.0201).contains(&health), "health after the withdrawal {health}");
    // Its oracle value less 2%.
    let value = p.sell as f64 / 1e24 * 3.0;
    assert!(((p.min_out as f64 / 1e6) - value * 0.98).abs() < 1e-5);
    // At health 1.02 or below nothing can be sold.
    let tight =
        close::plan_close(100 * NEAR, 220 * USDC * INNER, &wnear_priced(), 0, &usdc_priced(), 12, 200);
    assert!(tight.unwrap_err().contains("too close to 1"));
}

/// Answers for the close's first read: the position, then per protocol token its oracle price
/// and asset config.
fn close_read(collateral: u128, debt_inner: u128) -> Vec<PromiseResult> {
    let asset = |ratio: u32| ok_json(json!({ "config": { "volatility_ratio": ratio } }));
    vec![
        ok_json(json!({
            "account_id": me(), "supplied": [],
            "collateral": [{ "token_id": "wrap.testnet", "balance": collateral.to_string() }],
            "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": debt_inner.to_string() }],
        })),
        oracle_price(300_000_000),
        asset(7_500),
        oracle_price(100_000_000),
        asset(9_500),
    ]
}

fn start_close(a: &mut Account) {
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::CloseRhea { slippage_bps: 200, pool_id: 7 }]);
}

/// Runs a close through the swap; returns the round's (sell, repay).
fn close_through_swap(a: &mut Account, debt_inner: u128) -> (u128, u128) {
    start_close(a);
    let id = a.closing().map(|c| c.id).unwrap_or(0);
    assert!(a.closing().is_none(), "nothing is stored before the read");
    let c = calls();
    assert_eq!((c[0].0.as_str(), c[0].1.as_str()), ("lending.parry.testnet", "get_account"));
    assert_eq!(c.iter().filter(|x| x.1 == "get_price_no_older_than").count(), 2);
    let read = c.iter().find(|x| x.1 == "on_close_read").unwrap().2.clone();
    let id = read["id"].as_u64().unwrap_or(id);
    set_with_results(NOW + 1, close_read(100 * NEAR, debt_inner));
    a.on_close_read(id, 200, 7, vec![id_tok("wrap.testnet"), id_tok("usdc.parry.testnet")]);
    let cl = a.closing().unwrap();
    assert_eq!(cl.stage, "withdraw");
    let c = calls();
    assert_eq!(
        (c[0].1.as_str(), c[0].2["amount_with_inner_decimal"].as_str()),
        ("simple_withdraw", Some(cl.sell.0.to_string().as_str()))
    );
    set_with_results(NOW + 2, vec![ok_json(json!(true))]);
    a.on_close_withdrawn(id);
    let c = calls();
    assert_eq!(
        (c[0].0.as_str(), c[0].2["receiver_id"].as_str().unwrap()),
        ("wrap.testnet", "ref-finance-101.testnet")
    );
    set_with_results(NOW + 3, vec![ok_json(json!(cl.sell.0.to_string()))]);
    a.on_close_deposited(id);
    let c = calls();
    assert_eq!(c[0].1, "swap");
    assert_eq!(c[0].2["actions"][0]["min_amount_out"], cl.min_out.0.to_string());
    assert_eq!(c[0].2["actions"][0]["pool_id"], 7);
    (cl.sell.0, cl.repay.0)
}

fn id_tok(s: &str) -> AccountId {
    id(s)
}

fn closing_id(a: &Account) -> u64 {
    a.closing().unwrap().id
}

#[test]
fn close_rhea_repays_everything_and_returns_the_collateral() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let (sell, repay) = close_through_swap(&mut a, 50 * USDC * INNER);
    let id = closing_id(&a);
    // A guardian action waits while the owner closes.
    let e = envelope(1, repay_action());
    assert!(refused(&mut a, &e, g.sign(&e), NOW + 4).contains("closing the position"));

    let out = repay + 300_000;
    set_with_results(NOW + 5, vec![ok_json(json!(out.to_string()))]);
    a.on_close_swapped(id);
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["token_id"].as_str().unwrap()), ("withdraw", "usdc.parry.testnet"));
    set_with_results(NOW + 6, vec![ok_json(json!(out.to_string()))]);
    a.on_close_out(id);
    let c = calls();
    // Repays the debt plus its margin; the rest of the swap stays in the account.
    assert_eq!((c[0].1.as_str(), c[0].2["msg"].as_str()), ("ft_transfer_call", Some("\"OnlyRepay\"")));
    assert_eq!(c[0].2["amount"], repay.to_string());
    set_with_results(NOW + 7, vec![ok_json(json!(repay.to_string()))]);
    a.on_close_repaid(id);
    assert_eq!(calls()[0].1, "get_account");
    let left = 100 * NEAR - sell;
    set_with_results(
        NOW + 8,
        vec![ok_json(json!({
            "collateral": [{ "token_id": "wrap.testnet", "balance": left.to_string() }],
            "supplied": [{ "token_id": "usdc.parry.testnet", "balance": "1000" }],
            "borrowed": [],
        }))],
    );
    a.on_close_verified(id);
    let c = calls();
    assert_eq!(
        (c[0].1.as_str(), c[0].2["amount_with_inner_decimal"].as_str()),
        ("simple_withdraw", Some(left.to_string().as_str()))
    );
    set_with_results(NOW + 9, vec![ok_json(json!(true))]);
    assert!(a.on_close_returned(id, U128(left)));
    let closed = get_logs().into_iter().find(|l| l.contains("position_closed")).unwrap();
    let v: serde_json::Value = serde_json::from_str(closed.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(v["data"]["debt_repaid"], repay.to_string());
    assert_eq!(v["data"]["collateral_sold"], sell.to_string());
    assert_eq!(v["data"]["collateral_returned"], left.to_string());
    assert!(a.closing().is_none());
    // The guardian may act again (the mandate stays).
    assert_eq!(refused(&mut a, &e, g.sign(&e), NOW + 10), "accepted");
}

fn repay_action() -> GuardianAction {
    repay(USDC)
}

#[test]
fn close_restores_the_collateral_when_the_swap_fails() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let (sell, _) = close_through_swap(&mut a, 50 * USDC * INNER);
    let id = closing_id(&a);
    set_with_results(NOW + 5, vec![PromiseResult::Failed]);
    a.on_close_swapped(id);
    assert_eq!(a.closing().unwrap().stage, "restore_swap");
    let c = calls();
    assert_eq!((c[0].1.as_str(), c[0].2["token_id"].as_str().unwrap()), ("withdraw", "wrap.testnet"));
    assert_eq!(c[0].2["amount"], sell.to_string());
    set_with_results(NOW + 6, vec![ok_json(json!(sell.to_string()))]);
    a.on_close_restore_withdrawn(id, U128(sell));
    let c = calls();
    assert_eq!(
        (c[0].2["receiver_id"].as_str(), c[0].2["msg"].as_str()),
        (Some("lending.parry.testnet"), Some("\"OnlyIncreaseCollateral\""))
    );
    set_with_results(NOW + 7, vec![ok_json(json!(sell.to_string()))]);
    assert!(a.on_close_restored(id));
    assert!(logs_contain("close_rolled_back") && logs_contain("\"stage\":\"swap\""));
    assert!(a.closing().is_none());
}

#[test]
fn close_rolls_back_when_the_withdrawal_or_deposit_fails() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    start_close(&mut a);
    let cid = calls().iter().find(|x| x.1 == "on_close_read").unwrap().2["id"].as_u64().unwrap();
    set_with_results(NOW + 1, close_read(100 * NEAR, 50 * USDC * INNER));
    a.on_close_read(cid, 200, 7, vec![id("wrap.testnet"), id("usdc.parry.testnet")]);
    let sell = a.closing().unwrap().sell.0;
    set_with_results(NOW + 2, vec![PromiseResult::Failed]);
    a.on_close_withdrawn(cid);
    let c = calls();
    assert_eq!(c[0].1, "execute");
    assert_eq!(c[0].2["actions"][0]["IncreaseCollateral"]["amount"], sell.to_string());
    assert!(logs_contain("close_rolled_back") && logs_contain("\"stage\":\"withdraw\""));
    assert!(a.closing().is_none());

    // The exchange took only part of the deposit: that part comes back, then all is re-supplied.
    start_close(&mut a);
    set_with_results(NOW + 3, close_read(100 * NEAR, 50 * USDC * INNER));
    a.on_close_read(cid + 1, 200, 7, vec![id("wrap.testnet"), id("usdc.parry.testnet")]);
    set_with_results(NOW + 4, vec![ok_json(json!(true))]);
    a.on_close_withdrawn(cid + 1);
    set_with_results(NOW + 5, vec![ok_json(json!((sell / 2).to_string()))]);
    a.on_close_deposited(cid + 1);
    assert_eq!(calls()[0].2["amount"], (sell / 2).to_string());
    set_with_results(NOW + 6, vec![ok_json(json!((sell / 2).to_string()))]);
    a.on_close_restore_withdrawn(cid + 1, U128(sell / 2));
    assert_eq!(calls()[0].2["amount"], sell.to_string());
    // The lending contract refuses the collateral back: it waits in the account for a retry.
    set_with_results(NOW + 7, vec![ok_json(json!("0"))]);
    assert!(!a.on_close_restored(cid + 1));
    assert_eq!(a.closing().unwrap().stage, "stuck_resupply");
    set("anyone.testnet", 0, NOW + 8);
    a.retry_close();
    set_with_results(NOW + 9, vec![ok_json(json!(sell.to_string()))]);
    assert!(a.on_close_restored(cid + 1));
    assert!(logs_contain("\"stage\":\"deposit\""));
    assert!(a.closing().is_none());
}

#[test]
fn a_refused_repay_or_exchange_withdrawal_waits_for_a_retry() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let (_, repay) = close_through_swap(&mut a, 50 * USDC * INNER);
    let id = closing_id(&a);
    set_with_results(NOW + 5, vec![ok_json(json!(repay.to_string()))]);
    a.on_close_swapped(id);
    // The exchange could not send the USDC (it re-credited the deposit).
    set_with_results(NOW + 6, vec![ok_json(json!("0"))]);
    a.on_close_out(id);
    assert_eq!(a.closing().unwrap().stage, "stuck_withdraw_out");
    testing_env!(ctx("anyone.testnet", 0, NOW + 7).prepaid_gas(near_sdk::Gas::from_tgas(100)).build());
    let msg = panic_text(|| {
        a.retry_close();
    });
    assert!(msg.contains(&format!("attach at least {} TGas", close::retry_close_gas().as_tgas())), "{msg}");
    set("anyone.testnet", 0, NOW + 7);
    a.retry_close();
    assert_eq!(calls()[0].1, "withdraw");
    set_with_results(NOW + 8, vec![ok_json(json!(repay.to_string()))]);
    a.on_close_out(id);
    // The lending contract refuses the repay: the USDC is back in the account.
    set_with_results(NOW + 9, vec![ok_json(json!("0"))]);
    a.on_close_repaid(id);
    assert_eq!(a.closing().unwrap().stage, "stuck_repay");
    set("anyone.testnet", 0, NOW + 10);
    a.retry_close();
    assert_eq!(calls()[0].2["msg"], "\"OnlyRepay\"");
    // The owner can also settle by hand and clear it.
    set("alice.testnet", 1, NOW + 11);
    a.owner_call(vec![OwnerAction::ClearPending]);
    assert!(a.closing().is_none());
}

#[test]
fn a_round_that_cannot_close_reports_progress() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let (sell, _) = close_through_swap(&mut a, 150 * USDC * INNER);
    let cl = a.closing().unwrap();
    assert!(!cl.last);
    let out = cl.min_out.0 + 10;
    set_with_results(NOW + 5, vec![ok_json(json!(out.to_string()))]);
    a.on_close_swapped(cl.id);
    set_with_results(NOW + 6, vec![ok_json(json!(out.to_string()))]);
    a.on_close_out(cl.id);
    // Repays all the swap gave (less than the debt).
    assert_eq!(calls()[0].2["amount"], out.to_string());
    set_with_results(NOW + 7, vec![ok_json(json!(out.to_string()))]);
    a.on_close_repaid(cl.id);
    let debt_left = 150 * USDC * INNER - out * INNER;
    set_with_results(
        NOW + 8,
        vec![ok_json(json!({
            "collateral": [{ "token_id": "wrap.testnet", "balance": (100 * NEAR - sell).to_string() }],
            "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": debt_left.to_string() }],
        }))],
    );
    a.on_close_verified(cl.id);
    assert!(calls().is_empty());
    let line = get_logs().into_iter().find(|l| l.contains("close_progress")).unwrap();
    let v: serde_json::Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(v["data"]["debt_left"], (debt_left / INNER).to_string());
    assert_eq!(v["data"]["collateral_left"], (100 * NEAR - sell).to_string());
    assert!(a.closing().is_none(), "the next close_rhea continues");
}

#[test]
fn close_refusals() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let msg = |a: &mut Account, actions: Vec<OwnerAction>, tgas: u64| {
        testing_env!(ctx("alice.testnet", 1, NOW).prepaid_gas(near_sdk::Gas::from_tgas(tgas)).build());
        panic_text(|| {
            a.owner_call(actions);
        })
    };
    let close = |slippage_bps| OwnerAction::CloseRhea { slippage_bps, pool_id: 7 };
    assert!(
        msg(&mut a, vec![close(200), OwnerAction::RevokeMandate], 900).contains("must be the only action")
    );
    assert!(msg(&mut a, vec![close(0)], 900).contains("1 to 1000"));
    assert!(msg(&mut a, vec![close(1_001)], 900).contains("1 to 1000"));
    let need = close::close_gas(2).as_tgas();
    assert!(msg(&mut a, vec![close(200)], need - 1).contains(&format!("attach at least {need} TGas")));
    assert_eq!(msg(&mut a, vec![close(200)], need), "accepted");

    // Refusals at the read move nothing.
    let refused_read = |a: &mut Account, results: Vec<PromiseResult>, want: &str| {
        set_with_results(NOW + 1, results);
        a.on_close_read(1, 200, 7, vec![id("wrap.testnet"), id("usdc.parry.testnet")]);
        assert!(calls().is_empty());
        assert!(logs_contain("close_rolled_back") && logs_contain(want), "{want}: {:?}", get_logs());
        assert!(a.closing().is_none());
    };
    let mut r = close_read(100 * NEAR, 0);
    r[0] = ok_json(json!({ "collateral": [{ "token_id": "wrap.testnet", "balance": "1" }], "borrowed": [] }));
    refused_read(&mut a, r, "nothing is borrowed");
    refused_read(&mut a, close_read(100 * NEAR, 220 * USDC * INNER), "too close to 1");
    let mut r = close_read(100 * NEAR, 50 * USDC * INNER);
    r[1] = ok_json(json!(null));
    refused_read(&mut a, r, "no fresh oracle price");
    let mut r = close_read(100 * NEAR, 50 * USDC * INNER);
    r[0] = ok_json(json!({
        "collateral": [{ "token_id": "wrap.testnet", "balance": "5" }, { "token_id": "usdc.parry.testnet", "balance": "5" }],
        "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": "5" }],
    }));
    refused_read(&mut a, r, "one collateral and one debt asset");

    // While a deleverage is in flight, no close starts.
    run_guardian(&mut a, &g, 1, delev(29_500_000));
    assert!(msg(&mut a, vec![close(200)], 900).contains("a deleverage is in flight"));
}

#[test]
fn unwind_revokes_withdraws_and_sends_everything_to_the_owner() {
    let g = Guardian::new(1);
    let mut a = with_mandate(&g);
    let tokens = vec![id("usdc.parry.testnet"), id("wrap.testnet")];
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::Unwind { tokens: tokens.clone(), to: None }]);
    assert!(a.mandate().is_none(), "the guardian is revoked at once");
    assert!(logs_contain("mandate_revoked"));
    assert_eq!(calls()[0].1, "get_account");

    set_with_results(
        NOW + 1,
        vec![ok_json(json!({
            "supplied": [{ "token_id": "usdc.parry.testnet", "balance": (5 * USDC * INNER).to_string() }],
            "collateral": [{ "token_id": "wrap.testnet", "balance": (40 * NEAR).to_string() }],
            "borrowed": [],
        }))],
    );
    a.on_unwind_read(id("alice.testnet"), tokens.clone());
    let w: Vec<_> = calls().into_iter().filter(|c| c.1 == "simple_withdraw").collect();
    assert_eq!(w.len(), 2);
    assert_eq!(w[0].2["token_id"], "wrap.testnet");
    assert_eq!(w[0].2["amount_with_inner_decimal"], (40 * NEAR).to_string());
    assert_eq!(w[1].2["amount_with_inner_decimal"], (5 * USDC * INNER).to_string());

    // The wNEAR withdrawal fails; the USDC one goes through.
    set_with_results(NOW + 2, vec![PromiseResult::Failed, ok_json(json!(true))]);
    a.on_unwind_withdrawn(
        id("alice.testnet"),
        tokens.clone(),
        vec![id("wrap.testnet"), id("usdc.parry.testnet")],
    );
    assert!(logs_contain("unwind_partial") && logs_contain("lending withdrawal failed"));
    let views: Vec<_> = calls().into_iter().filter(|c| c.1 == "ft_balance_of").collect();
    assert_eq!(views.len(), 2);

    set_with_results(
        NOW + 3,
        vec![ok_json(json!((65 * USDC).to_string())), ok_json(json!((30 * NEAR).to_string()))],
    );
    a.on_unwind_balances(id("alice.testnet"), tokens.clone());
    let t: Vec<_> = calls().into_iter().filter(|c| c.1 == "ft_transfer").collect();
    assert_eq!(t.len(), 2);
    assert_eq!(
        (t[0].0.as_str(), t[0].2["receiver_id"].as_str(), t[0].2["amount"].as_str()),
        ("usdc.parry.testnet", Some("alice.testnet"), Some("65000000"))
    );

    // The wNEAR transfer fails: that balance stays, the rest goes.
    set_with_results(NOW + 4, vec![ok_json(json!(null)), PromiseResult::Failed]);
    let sent = vec![
        close::TokenAmount { token: id("usdc.parry.testnet"), amount: U128(65 * USDC) },
        close::TokenAmount { token: id("wrap.testnet"), amount: U128(30 * NEAR) },
    ];
    assert!(a.on_unwind_sent(id("alice.testnet"), sent));
    assert!(logs_contain("the transfer failed"));
    let line = get_logs().into_iter().find(|l| l.contains("\"unwound\"")).unwrap();
    let v: serde_json::Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(v["data"]["tokens"], json!([{ "token": "usdc.parry.testnet", "amount": "65000000" }]));
    // The NEAR above the storage reserve and its margin goes to the owner: what is left is
    // exactly that reserve.
    let near: u128 = v["data"]["near"].as_str().unwrap().parse().unwrap();
    assert!(near > 0);
    let storage = near_sdk::env::storage_byte_cost().as_yoctonear() * near_sdk::env::storage_usage() as u128;
    let left = near_sdk::env::account_balance().as_yoctonear();
    assert_eq!(left, storage + close::UNWIND_NEAR_MARGIN.as_yoctonear());
    let transfers: Vec<_> = get_created_receipts()
        .into_iter()
        .filter(|r| r.actions.iter().any(|x| matches!(x, MockAction::Transfer { .. })))
        .collect();
    assert_eq!(transfers[0].receiver_id, id("alice.testnet"));
}

#[test]
fn unwind_leaves_collateral_that_backs_a_loan() {
    let mut a = near_owned();
    set("alice.testnet", 1, NOW);
    a.owner_call(vec![OwnerAction::Unwind { tokens: vec![], to: None }]);
    set_with_results(
        NOW + 1,
        vec![ok_json(json!({
            "supplied": [{ "token_id": "wrap.testnet", "balance": "7" }],
            "collateral": [{ "token_id": "wrap.testnet", "balance": (40 * NEAR).to_string() }],
            "borrowed": [{ "token_id": "usdc.parry.testnet", "balance": "1" }],
        }))],
    );
    a.on_unwind_read(id("alice.testnet"), vec![]);
    let w: Vec<_> = calls().into_iter().filter(|c| c.1 == "simple_withdraw").collect();
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].2["amount_with_inner_decimal"], "7", "only the supply");
    assert!(logs_contain("backs a loan"));
}

#[test]
fn unwind_target_and_limits() {
    // A passkey owner must name where everything goes.
    let pk = Passkey::new();
    set("factory.testnet", 0, NOW);
    near_sdk::env::storage_remove(b"rt");
    let mut a = Account::new(Owner::Passkey { key: pk.public() }, "testnet".into(), protocol());
    let request = |nonce: u64, actions: Vec<OwnerAction>| {
        serde_json::to_string(&OwnerRequest {
            account: me(),
            network: "testnet".into(),
            nonce,
            created_at: NOW,
            actions,
        })
        .unwrap()
    };
    let r = request(1, vec![OwnerAction::Unwind { tokens: vec![], to: None }]);
    set("relayer.parry.testnet", 0, NOW);
    let msg = panic_text(|| {
        a.owner_execute(r.clone(), pk.assert(&r));
    });
    assert!(msg.contains("must name `to`"), "{msg}");
    let r = request(2, vec![OwnerAction::Unwind { tokens: vec![], to: Some(id("bob.testnet")) }]);
    set("relayer.parry.testnet", 0, NOW);
    a.owner_execute(r.clone(), pk.assert(&r));
    let read = calls().into_iter().find(|c| c.1 == "on_unwind_read").unwrap();
    assert_eq!(read.2["to"], "bob.testnet");

    let mut a = near_owned();
    let unwind = |tokens: Vec<AccountId>| vec![OwnerAction::Unwind { tokens, to: None }];
    set("alice.testnet", 1, NOW);
    let msg = panic_text(|| {
        a.owner_call(unwind(vec![id("wrap.testnet"), id("wrap.testnet")]));
    });
    assert!(msg.contains("listed twice"), "{msg}");
    let need = close::unwind_gas(2, 1).as_tgas();
    testing_env!(ctx("alice.testnet", 1, NOW).prepaid_gas(near_sdk::Gas::from_tgas(need - 1)).build());
    let msg = panic_text(|| {
        a.owner_call(unwind(vec![id("wrap.testnet")]));
    });
    assert!(msg.contains(&format!("attach at least {need} TGas")), "{msg}");
}
