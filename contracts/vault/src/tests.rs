// Tests call contract methods for their side effects (receipts, logs, state) and inspect those.
#![allow(unused_must_use)]

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig};
use num_bigint::BigUint;
use parry_common::hyperliquid::{order_digest, parse_e8, usd_class_transfer_digest, HlOrder};
use parry_common::math::Rounding;
use parry_common::pyth::NEAR_USD;
use proptest::prelude::*;

use crate::nav::{self, E24, E8};
use crate::order::{self, format_e8, leverage_cap_e8, order_for, round_price_e8, target_short_e8};
use crate::*;

const NOW: u64 = 1_800_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const USD: u128 = 1_000_000;
/// 1.2 NEAR per LiNEAR.
const RATE: u128 = 1_200_000_000_000_000_000_000_000;
/// 3 USD per NEAR.
const PRICE: u128 = 300_000_000;
/// Operator margin in the hedge account.
const MARGIN: u128 = 1_000 * USD;

const VAULT: &str = "vault.parry.testnet";
const OWNER: &str = "owner.parry.testnet";
const RISK: &str = "risk.parry.testnet";
const KEEPER: &str = "keeper.parry.testnet";
const LINEAR: &str = "linear-protocol.testnet";
const WNEAR: &str = "wrap.testnet";
const USDC: &str = "usdc.parry.testnet";
const ORACLE: &str = "oracle.parry.testnet";
const SIGNER: &str = "v1.signer-prod.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128, secs: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id(VAULT))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(secs * 1_000_000_000)
        .account_balance(NearToken::from_near(10_000_000))
        .prepaid_gas(near_sdk::Gas::from_tgas(300));
    b
}

fn set(predecessor: &str, deposit: u128, secs: u64) {
    testing_env!(ctx(predecessor, deposit, secs).build());
}

/// A callback context: the vault calls itself, with these promise results.
fn set_results(secs: u64, results: Vec<PromiseResult>) {
    testing_env!(
        ctx(VAULT, 0, secs).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn ok_json(v: Value) -> PromiseResult {
    PromiseResult::Successful(v.to_string().into_bytes())
}

fn ok_empty() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

fn oracle_price(price_e8: u128, publish_time: u64) -> PromiseResult {
    ok_json(json!({ "price": price_e8.to_string(), "conf": "1", "expo": -8, "publish_time": publish_time }))
}

fn rate(r: u128) -> PromiseResult {
    ok_json(json!(r.to_string()))
}

/// (receiver, method, args, attached yocto) of every function call the vault created.
fn calls() -> Vec<(String, String, Value, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => Some((
                    receiver.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap_or(Value::Null),
                    attached_deposit.as_yoctonear(),
                )),
                _ => None,
            })
        })
        .collect()
}

/// (receiver, amount) of every plain NEAR transfer the vault created.
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((receiver.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn call_to(method: &str) -> (String, Value, u128) {
    calls()
        .into_iter()
        .find(|c| c.1 == method)
        .map(|c| (c.0, c.2, c.3))
        .unwrap_or_else(|| panic!("no call to {method}"))
}

fn has_call(method: &str) -> bool {
    calls().iter().any(|c| c.1 == method)
}

fn num(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

/// The data of every `standard` event named `name` logged in this context.
fn events(standard: &str, name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["standard"] == standard && e["event"] == name)
        .map(|e| e["data"].clone())
        .collect()
}

fn vault_event(name: &str) -> Value {
    events("parry-vault", name).pop().unwrap_or_else(|| panic!("no {name} event in {:?}", get_logs()))
}

fn has_vault_event(name: &str) -> bool {
    !events("parry-vault", name).is_empty()
}

/// The panic message of `f`, or "no panic".
fn panic_of(f: impl FnOnce()) -> String {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    r.err()
        .and_then(|e| {
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "no panic".into())
}

fn hedge_config() -> HedgeConfig {
    HedgeConfig {
        asset: "NEAR".into(),
        asset_index: 54,
        sz_decimals: 1,
        hedge_ratio_bps: 9_000,
        max_leverage_x100: 300,
        band_bps: 200,
    }
}

fn deploy_with(cap: u128, min: u128) -> Vault {
    set(OWNER, 0, NOW);
    Vault::new(
        id(OWNER),
        "testnet".into(),
        id(RISK),
        id(KEEPER),
        id(LINEAR),
        id(WNEAR),
        id(USDC),
        id(ORACLE),
        id(SIGNER),
        hedge_config(),
        U128(cap),
        U128(min),
    )
}

fn deploy() -> Vault {
    deploy_with(100_000 * NEAR, NEAR)
}

/// The hedge as a report describes it.
#[derive(Clone, Copy)]
struct Hl {
    size_e8: i128,
    value_e6: u128,
    margin_e6: u128,
    mark_e8: u128,
    funding_e6: i128,
}

impl Default for Hl {
    fn default() -> Self {
        Hl { size_e8: 0, value_e6: MARGIN, margin_e6: MARGIN, mark_e8: PRICE, funding_e6: 0 }
    }
}

impl Hl {
    /// Hedge equity of `pnl_e6` over the operator margin.
    fn pnl(pnl_e6: i128) -> Self {
        Hl { value_e6: (MARGIN as i128 + pnl_e6) as u128, ..Hl::default() }
    }
}

fn report_json_for(vault: &str, run_id: u64, at: u64, score: u8, hl: Hl) -> String {
    json!({
        "kind": "vault_report",
        "run_id": run_id,
        "at": at,
        "vault": vault,
        "score": score,
        "components": {
            "liquidation_bps": 1200, "margin_bps": 800, "funding_bps": 500,
            "oracle_bps": 300, "rate_bps": 200, "reserves_bps": 500,
        },
        "hedge": {
            "asset_index": 54,
            "size_e8": hl.size_e8.to_string(),
            "entry_e8": "310000000",
            "account_value_e6": hl.value_e6.to_string(),
            "unrealized_e6": "-12500000",
            "funding_e6": hl.funding_e6.to_string(),
            "margin_baseline_e6": hl.margin_e6.to_string(),
            "mark_e8": hl.mark_e8.to_string(),
            "liquidation_e8": "520000000",
        },
        "reserves": {
            "root": "ab".repeat(32),
            "leaves": 12,
            "total_usd_e6": "5000000000",
            "liabilities_usd_e6": "4800000000",
            "ratio_bps": 10416,
        },
    })
    .to_string()
}

fn report_json(run_id: u64, at: u64, score: u8, hl: Hl) -> String {
    report_json_for(VAULT, run_id, at, score, hl)
}

fn report(v: &mut Vault, run_id: u64, at: u64, score: u8, hl: Hl) {
    set(RISK, 0, at);
    v.on_vault_report(report_json(run_id, at, score, hl));
}

/// Registers `who` for shares up front, so a deposit stakes exactly what is attached.
fn register(v: &mut Vault, who: &str) {
    let cost = v.storage_cost();
    set(who, cost, NOW);
    v.storage_deposit(None, None);
}

/// Runs a NEAR deposit end to end (deposit, pricing, stake); returns the shares minted.
fn deposit_at(v: &mut Vault, who: &str, amount: u128, secs: u64, price_e8: u128, r: u128) -> u128 {
    set(who, amount, secs);
    v.deposit();
    let net = num(&call_to("on_deposit_priced").1["amount"]);
    set_results(secs + 1, vec![oracle_price(price_e8, secs), rate(r)]);
    v.on_deposit_priced(id(who), U128(net));
    let shares = num(&call_to("on_staked").1["shares"]);
    set_results(secs + 2, vec![ok_empty()]);
    v.on_staked(id(who), U128(net), U128(shares), U128(r)).0
}

fn deposit(v: &mut Vault, who: &str, amount: u128) -> u128 {
    deposit_at(v, who, amount, NOW + 1, PRICE, RATE)
}

/// Starts a deposit and answers its pricing with `results`.
fn price_with(v: &mut Vault, who: &str, amount: u128, secs: u64, results: Vec<PromiseResult>) -> u128 {
    set(who, amount, secs);
    v.deposit();
    let net = num(&call_to("on_deposit_priced").1["amount"]);
    set_results(secs + 1, results);
    v.on_deposit_priced(id(who), U128(net));
    net
}

// ---------------------------------------------------------------------------------------------
// Deploy and metadata
// ---------------------------------------------------------------------------------------------

#[test]
fn deploys_with_earn_metadata_and_registered_escrow() {
    let v = deploy();
    let m = v.ft_metadata();
    assert_eq!((m.name.as_str(), m.symbol.as_str(), m.decimals), ("Parry Earn", "EARN", 24));
    assert!(v.storage_balance_of(id(VAULT)).is_some());
    assert_eq!(v.share_price().0, 1_000_000);
    assert_eq!(v.config().hedge_path, "parry-vault-hedge");
}

#[test]
fn config_validation() {
    type Edit = Box<dyn Fn(&mut HedgeConfig)>;
    let cases: Vec<(Edit, &str)> = vec![
        (Box::new(|h| h.hedge_ratio_bps = 4_999), "5000 to 10000"),
        (Box::new(|h| h.hedge_ratio_bps = 10_001), "5000 to 10000"),
        (Box::new(|h| h.band_bps = 301), "band_bps"),
        (Box::new(|h| h.band_bps = 0), "band_bps"),
        (Box::new(|h| h.sz_decimals = 7), "sz_decimals"),
        (Box::new(|h| h.max_leverage_x100 = 99), "max_leverage_x100"),
    ];
    for (edit, want) in cases {
        let mut h = hedge_config();
        edit(&mut h);
        set(OWNER, 0, NOW);
        let msg = panic_of(|| {
            Vault::new(
                id(OWNER),
                "testnet".into(),
                id(RISK),
                id(KEEPER),
                id(LINEAR),
                id(WNEAR),
                id(USDC),
                id(ORACLE),
                id(SIGNER),
                h,
                U128(100 * NEAR),
                U128(NEAR),
            );
        });
        assert!(msg.contains(want), "expected '{want}', got '{msg}'");
    }
    let msg = panic_of(|| {
        deploy_with(100 * NEAR, 1);
    });
    assert!(msg.contains("min_deposit must exceed the share registration cost"), "{msg}");
}

// ---------------------------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------------------------

#[test]
fn first_deposit_prices_stakes_then_mints_one_share_per_usd() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl::default());
    let amount = 10 * NEAR;
    let storage = v.storage_cost();

    set(ALICE, amount, NOW + 1);
    v.deposit();
    // Pricing: the oracle and the LiNEAR rate, jointly, then the callback.
    let (to, args, _) = call_to("get_price_no_older_than");
    assert_eq!(to, ORACLE);
    assert_eq!(args, json!({ "price_id": NEAR_USD, "age": 120 }));
    assert_eq!(call_to("ft_price").0, LINEAR);
    let net = amount - storage;
    assert_eq!(num(&call_to("on_deposit_priced").1["amount"]), net);
    assert_eq!(vault_event("deposit_started")["source"], "near");
    assert_eq!(num(&vault_event("deposit_started")["storage"]), storage);
    assert_eq!(v.pending_deposit_near, net);

    set_results(NOW + 2, vec![oracle_price(PRICE, NOW + 1), rate(RATE)]);
    v.on_deposit_priced(id(ALICE), U128(net));
    let (to, _, attached) = call_to("deposit_and_stake");
    assert_eq!((to.as_str(), attached), (LINEAR, net));
    // Value in USD e6: net × 3 / 1e24 × 1e6; first deposit: 1e18 share units per micro-USD.
    let value_e6 = net * 3 / 1_000_000_000_000_000_000;
    let shares = num(&call_to("on_staked").1["shares"]);
    assert_eq!(shares, value_e6 * 1_000_000_000_000_000_000);
    // Never minted before the stake succeeded.
    assert_eq!(v.ft_balance_of(id(ALICE)).0, 0);

    set_results(NOW + 3, vec![ok_empty()]);
    assert_eq!(v.on_staked(id(ALICE), U128(net), U128(shares), U128(RATE)).0, shares);
    assert_eq!(v.ft_balance_of(id(ALICE)).0, shares);
    assert_eq!(v.staked_linear, nav::near_to_linear(net, RATE));
    assert_eq!(v.pending_deposit_near, 0);
    let mint = events("nep141", "ft_mint").pop().unwrap();
    assert_eq!(mint[0]["owner_id"], ALICE);
    assert_eq!(num(&mint[0]["amount"]), shares);
    let state = v.vault_state();
    assert_eq!(state.linear_rate_e24.0, RATE);
    assert_eq!(state.near_price_e8.0, PRICE);
    // One share is still worth one USD (to rounding).
    assert!(state.share_price_e6.0.abs_diff(1_000_000) <= 1, "{}", state.share_price_e6.0);
}

#[test]
fn later_deposits_are_priced_against_nav() {
    let mut v = deploy();
    register(&mut v, ALICE);
    register(&mut v, BOB);
    report(&mut v, 1, NOW, 20, Hl::default());
    let a = deposit(&mut v, ALICE, 100 * NEAR);
    assert_eq!(a, 300 * USD * 1_000_000_000_000_000_000);

    // The LiNEAR rate grew 10% and the hedge earned 30 USD. Reading the rate, the insurance fund
    // takes 10% of the 30 USD of staking yield: NAV is 300 × 1.1 − 3 + 30 = 357 USD.
    report(&mut v, 2, NOW + 10, 20, Hl::pnl(30 * USD as i128));
    let r2 = RATE * 11 / 10;
    let b = deposit_at(&mut v, BOB, 100 * NEAR, NOW + 11, PRICE, r2);
    let fund = v.insurance().linear.0;
    assert_eq!(fund, nav::near_to_linear(NEAR, r2), "1 NEAR of the 10 NEAR yield, as LiNEAR");
    let alice_linear = nav::near_to_linear(100 * NEAR, RATE) - fund;
    let nav = nav::nav_e6(alice_linear, r2, PRICE, 30 * USD as i128, Rounding::Up);
    assert!(nav.abs_diff(357 * USD) <= 1, "{nav}");
    assert_eq!(b, 300 * USD * a / nav);
}

#[test]
fn deposit_into_a_vault_with_no_nav_is_refunded() {
    let mut v = deploy();
    register(&mut v, ALICE);
    register(&mut v, BOB);
    report(&mut v, 1, NOW, 20, Hl::default());
    deposit(&mut v, ALICE, 10 * NEAR);
    // The hedge lost more than the staked LiNEAR is worth (30 USD): existing shares are worth
    // nothing, and new shares would hand Bob's deposit to Alice.
    report(&mut v, 2, NOW + 10, 20, Hl::pnl(-40 * USD as i128));
    let net = price_with(&mut v, BOB, 10 * NEAR, NOW + 11, vec![oracle_price(PRICE, NOW + 11), rate(RATE)]);
    assert_eq!(transfers(), vec![(BOB.to_string(), net)]);
    assert_eq!(
        vault_event("deposit_refunded")["reason"],
        "the vault has no net asset value: deposits wait for the hedge to recover"
    );
    assert!(!has_call("deposit_and_stake"));
}

#[test]
fn stale_or_missing_oracle_price_refunds() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());

    // Published 121 s before the pricing callback.
    let net = price_with(&mut v, ALICE, 10 * NEAR, NOW + 1, vec![oracle_price(PRICE, NOW - 119), rate(RATE)]);
    assert_eq!(transfers(), vec![(ALICE.to_string(), net)]);
    assert_eq!(vault_event("deposit_refunded")["reason"], "no fresh oracle price");
    assert!(!has_call("deposit_and_stake"));
    assert_eq!(v.pending_deposit_near, 0);

    // The oracle answers null.
    price_with(&mut v, ALICE, 10 * NEAR, NOW + 1, vec![ok_json(Value::Null), rate(RATE)]);
    assert_eq!(transfers().len(), 1);
    assert!(!has_call("deposit_and_stake"));

    // The oracle call failed.
    price_with(&mut v, ALICE, 10 * NEAR, NOW + 1, vec![PromiseResult::Failed, rate(RATE)]);
    assert_eq!(transfers().len(), 1);

    // The LiNEAR rate is missing.
    price_with(&mut v, ALICE, 10 * NEAR, NOW + 1, vec![oracle_price(PRICE, NOW + 1), PromiseResult::Failed]);
    assert_eq!(vault_event("deposit_refunded")["reason"], "LiNEAR rate unavailable");
    assert_eq!(v.ft_total_supply().0, 0);
    assert_eq!(v.pending_deposit_near, 0);
}

#[test]
fn oracle_deviation_over_two_percent_refunds() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());
    // 3.0601 is 2.003% above the 3.00 mark.
    price_with(&mut v, ALICE, 10 * NEAR, NOW + 1, vec![oracle_price(306_010_000, NOW + 1), rate(RATE)]);
    assert_eq!(
        vault_event("deposit_refunded")["reason"],
        "oracle price is more than 2% away from the hedge mark"
    );
    assert!(!has_call("deposit_and_stake"));
    // 2% below is still inside.
    price_with(&mut v, ALICE, 10 * NEAR, NOW + 1, vec![oracle_price(294_000_000, NOW + 1), rate(RATE)]);
    assert!(has_call("deposit_and_stake"));
}

#[test]
fn stale_report_refuses_deposits() {
    let mut v = deploy();
    // No report at all.
    set(ALICE, 10 * NEAR, NOW);
    let msg = panic_of(|| {
        v.deposit();
    });
    assert!(msg.contains("older than 15 minutes"), "{msg}");

    report(&mut v, 1, NOW, 20, Hl::default());
    set(ALICE, 10 * NEAR, NOW + 901);
    let msg = panic_of(|| {
        v.deposit();
    });
    assert!(msg.contains("older than 15 minutes"), "{msg}");

    // Fresh at the call, stale by the time it is priced: refunded.
    register(&mut v, ALICE);
    let net =
        price_with(&mut v, ALICE, 10 * NEAR, NOW + 900, vec![oracle_price(PRICE, NOW + 900), rate(RATE)]);
    assert_eq!(transfers(), vec![(ALICE.to_string(), net)]);
    assert_eq!(
        vault_event("deposit_refunded")["reason"],
        "the vault report went stale while the deposit was priced"
    );
}

#[test]
fn stake_failure_refunds_and_mints_nothing() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());
    set(ALICE, 10 * NEAR, NOW + 1);
    v.deposit();
    set_results(NOW + 2, vec![oracle_price(PRICE, NOW + 1), rate(RATE)]);
    v.on_deposit_priced(id(ALICE), U128(10 * NEAR));
    let shares = num(&call_to("on_staked").1["shares"]);

    set_results(NOW + 3, vec![PromiseResult::Failed]);
    assert_eq!(v.on_staked(id(ALICE), U128(10 * NEAR), U128(shares), U128(RATE)).0, 0);
    assert_eq!(transfers(), vec![(ALICE.to_string(), 10 * NEAR)]);
    assert_eq!(vault_event("deposit_refunded")["reason"], "LiNEAR staking failed");
    assert_eq!(v.ft_balance_of(id(ALICE)).0, 0);
    assert_eq!(v.ft_total_supply().0, 0);
    assert_eq!(v.staked_linear, 0);
    assert_eq!(v.pending_deposit_near, 0);
}

#[test]
fn stake_credit_never_exceeds_what_linear_reports() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());
    set_results(NOW + 3, vec![ok_json(json!("8000000000000000000000000"))]);
    v.on_staked(id(ALICE), U128(10 * NEAR), U128(5), U128(RATE));
    assert_eq!(v.staked_linear, 8 * NEAR);
}

#[test]
fn shares_reach_a_depositor_who_unregistered_mid_flight() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl::default());
    set_results(NOW + 3, vec![ok_empty()]);
    v.on_staked(id(ALICE), U128(10 * NEAR), U128(77), U128(RATE));
    assert_eq!(v.ft_balance_of(id(ALICE)).0, 77);
}

#[test]
fn min_deposit_and_cap() {
    let mut v = deploy_with(25 * NEAR, 2 * NEAR);
    register(&mut v, ALICE);
    register(&mut v, BOB);
    report(&mut v, 1, NOW, 20, Hl::default());

    set(ALICE, 2 * NEAR - 1, NOW + 1);
    let msg = panic_of(|| {
        v.deposit();
    });
    assert!(msg.contains("below the minimum"), "{msg}");

    deposit(&mut v, ALICE, 15 * NEAR);
    // 15 NEAR staked; a second deposit of 6 is in flight, so 11 more no longer fits.
    set(BOB, 6 * NEAR, NOW + 5);
    v.deposit();
    assert_eq!(v.pending_deposit_near, 6 * NEAR);
    set(ALICE, 5 * NEAR, NOW + 5);
    let msg = panic_of(|| {
        v.deposit();
    });
    assert!(msg.contains("deposit cap reached: at most"), "{msg}");
    set(ALICE, 4 * NEAR, NOW + 5);
    v.deposit();
    assert_eq!(v.pending_deposit_near, 10 * NEAR);
}

#[test]
fn paused_vault_refuses_deposits() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());
    set(OWNER, 1, NOW + 1);
    v.pause_deposits();
    set(ALICE, 10 * NEAR, NOW + 1);
    let msg = panic_of(|| {
        v.deposit();
    });
    assert!(msg.contains("paused by the owner"), "{msg}");
    set(OWNER, 1, NOW + 1);
    v.unpause_deposits();
    deposit(&mut v, ALICE, 10 * NEAR);

    // Paused by risk while a deposit is being priced: refunded.
    set(ALICE, 10 * NEAR, NOW + 5);
    v.deposit();
    report(&mut v, 2, NOW + 5, 75, Hl::default());
    set_results(NOW + 6, vec![oracle_price(PRICE, NOW + 5), rate(RATE)]);
    v.on_deposit_priced(id(ALICE), U128(10 * NEAR));
    assert_eq!(
        vault_event("deposit_refunded")["reason"],
        "deposits were paused while the deposit was priced"
    );
}

#[test]
fn wnear_deposit_unwraps_then_follows_the_near_path() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl::default());
    set(WNEAR, 0, NOW + 1);
    v.ft_on_transfer(id(ALICE), U128(10 * NEAR), "deposit".into());
    let (to, args, attached) = call_to("near_withdraw");
    assert_eq!((to.as_str(), attached), (WNEAR, 1));
    assert_eq!(args, json!({ "amount": (10 * NEAR).to_string() }));
    assert_eq!(call_to("on_unwrapped").1["sender_id"], ALICE);

    // Unwrapped: the NEAR path starts (registration paid from the deposit), and the wNEAR
    // resolver is told everything was used.
    set_results(NOW + 2, vec![ok_empty()]);
    assert_eq!(v.on_unwrapped(id(ALICE), U128(10 * NEAR)).0, 0);
    assert!(has_call("get_price_no_older_than") && has_call("ft_price"));
    assert_eq!(vault_event("deposit_started")["source"], "wnear");
    let net = 10 * NEAR - v.storage_cost();
    assert_eq!(num(&call_to("on_deposit_priced").1["amount"]), net);

    set_results(NOW + 3, vec![oracle_price(PRICE, NOW + 2), rate(RATE)]);
    v.on_deposit_priced(id(ALICE), U128(net));
    let shares = num(&call_to("on_staked").1["shares"]);
    set_results(NOW + 4, vec![ok_empty()]);
    v.on_staked(id(ALICE), U128(net), U128(shares), U128(RATE));
    assert_eq!(v.ft_balance_of(id(ALICE)).0, shares);
}

#[test]
fn wnear_unwrap_failure_returns_the_wnear() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl::default());
    set_results(NOW + 2, vec![PromiseResult::Failed]);
    assert_eq!(v.on_unwrapped(id(ALICE), U128(10 * NEAR)).0, 10 * NEAR);
    assert!(!has_call("get_price_no_older_than"));
    assert!(transfers().is_empty());

    // Unwrapped, but the vault paused meanwhile: the NEAR goes back.
    set(OWNER, 1, NOW + 2);
    v.pause_deposits();
    set_results(NOW + 2, vec![ok_empty()]);
    assert_eq!(v.on_unwrapped(id(ALICE), U128(10 * NEAR)).0, 0);
    assert_eq!(transfers(), vec![(ALICE.to_string(), 10 * NEAR)]);
}

#[test]
fn ft_on_transfer_refusals_and_buffer_top_up() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl::default());
    let cases = [
        (WNEAR, ALICE, "stake please", "unknown msg"),
        ("other-token.testnet", ALICE, "deposit", "takes wNEAR deposits"),
        (USDC, ALICE, "buffer", "only the owner funds"),
        (USDC, OWNER, "deposit", "settlement buffer top-up"),
    ];
    for (token, sender, msg, want) in cases {
        set(token, 0, NOW + 1);
        let got = panic_of(|| {
            v.ft_on_transfer(id(sender), U128(5 * NEAR), msg.into());
        });
        assert!(got.contains(want), "expected '{want}', got '{got}'");
    }
    // Below the minimum: refused before unwrapping, so the token refunds the transfer.
    set(WNEAR, 0, NOW + 1);
    let got = panic_of(|| {
        v.ft_on_transfer(id(ALICE), U128(1), "".into());
    });
    assert!(got.contains("below the minimum"), "{got}");

    set(USDC, 0, NOW + 1);
    match v.ft_on_transfer(id(OWNER), U128(500 * USD), "buffer".into()) {
        PromiseOrValue::Value(unused) => assert_eq!(unused.0, 0),
        PromiseOrValue::Promise(_) => panic!("a top-up needs no promise"),
    }
    assert_eq!(v.buffer_usdc, 500 * USD);
    assert_eq!(num(&vault_event("buffer_funded")["buffer"]), 500 * USD);
    // The buffer is operator money: NAV does not move.
    assert_eq!(v.vault_state().nav_e6.0, 0);
}

// ---------------------------------------------------------------------------------------------
// Hedge sizing and rebalancing
// ---------------------------------------------------------------------------------------------

#[test]
fn hedge_sizing_and_leverage_cap() {
    // 1000 LiNEAR at 1.2 is 1200 NEAR; 90% of the active 3/4 is 810 NEAR.
    let target = target_short_e8(1_000 * NEAR, RATE, 3, 4, 9_000);
    assert_eq!(target, 810 * E8);
    assert_eq!(target_short_e8(1_000 * NEAR, RATE, 0, 4, 9_000), 0);
    assert_eq!(target_short_e8(1_000 * NEAR, RATE, 4, 0, 9_000), 0);
    // 3x on 500 USD at 3 USD per NEAR allows 500 NEAR of short.
    assert_eq!(leverage_cap_e8(500 * USD, 300, PRICE), 500 * E8);
    assert_eq!(leverage_cap_e8(500 * USD, 200, PRICE), 33_333_333_333);
    assert_eq!(order::leverage_x100(500 * E8, PRICE, 500 * USD), 300);
    assert_eq!(order::leverage_x100(1, PRICE, 0), u32::MAX);

    // In the vault: the cap binds when the hedge account is small.
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());
    deposit(&mut v, ALICE, 1_200 * NEAR);
    let r = v.report.clone().unwrap();
    // Account value 1000 USD: 3x is 1000 NEAR, under the 1080 NEAR (90%) target.
    let plan = v.hedge_plan(RATE, &r);
    assert_eq!(plan.target_e8, 1_000 * E8);
    // A score of 50 lowers the cap to 2x: 666.66666666 NEAR.
    report(&mut v, 2, NOW + 10, 50, Hl::default());
    let r = v.report.clone().unwrap();
    assert_eq!(v.hedge_plan(RATE, &r).target_e8, 66_666_666_666);
    // A large account leaves the 90% target alone.
    report(
        &mut v,
        3,
        NOW + 20,
        10,
        Hl { value_e6: 100_000 * USD, margin_e6: 100_000 * USD, ..Hl::default() },
    );
    let r = v.report.clone().unwrap();
    assert_eq!(v.hedge_plan(RATE, &r).target_e8, 1_080 * E8);
}

#[test]
fn order_strings_follow_hyperliquid_rules() {
    assert_eq!(format_e8(356_190_000), "3.5619");
    assert_eq!(format_e8(12_000_000_000), "120");
    assert_eq!(format_e8(50_000_000), "0.5");
    assert_eq!(format_e8(1), "0.00000001");
    assert_eq!(format_e8(0), "0");
    // 5 significant figures, rounded toward the mark.
    assert_eq!(round_price_e8(356_181_000, 1, true), 356_190_000);
    assert_eq!(round_price_e8(370_719_000, 1, false), 370_710_000);
    // At most 6 − szDecimals decimals: with 4 size decimals, 2 price decimals.
    assert_eq!(round_price_e8(356_181_000, 4, true), 357_000_000);
    // 10000 and above: integers only.
    assert_eq!(round_price_e8(6_543_210_000_000, 1, false), 6_543_200_000_000);
    assert_eq!(round_price_e8(12_345_678_000_000, 0, true), 12_345_700_000_000);
    // Below 1: 5 significant figures after the leading zeros, capped by the decimals budget.
    assert_eq!(round_price_e8(1_234_567, 0, false), 1_234_500);
    assert_eq!(round_price_e8(1_234_567, 2, false), 1_230_000);
    // Rounding up across a power of ten stays valid.
    assert_eq!(format_e8(round_price_e8(999_996_000, 1, true)), "10");
    assert_eq!(order::round_size_e8(89_999_999_999, 1), 89_990_000_000);

    let cfg = hedge_config();
    let mark = 363_450_000;
    let sell = order_for(&cfg, 900 * E8, 0, mark).unwrap();
    assert_eq!(
        sell,
        HlOrder {
            asset_index: 54,
            is_buy: false,
            price: "3.5619".into(),
            size: "900".into(),
            reduce_only: false,
            tif: "Ioc".into()
        }
    );
    let buy = order_for(&cfg, 900 * E8, 100_055_555_555, mark).unwrap();
    assert_eq!((buy.is_buy, buy.reduce_only), (true, true));
    assert_eq!((buy.price.as_str(), buy.size.as_str()), ("3.7071", "100.5"));
    // A long (never expected) is sold through.
    assert!(!order_for(&cfg, 10 * E8, -5 * E8 as i128, mark).unwrap().is_buy);
}

#[test]
fn in_band_hedge_is_a_no_op() {
    let cfg = hedge_config();
    // Within 2% of a 900 NEAR target (18 NEAR).
    assert!(order_for(&cfg, 900 * E8, 883 * E8 as i128, PRICE).is_none());
    assert!(order_for(&cfg, 900 * E8, 917 * E8 as i128, PRICE).is_none());
    assert!(order_for(&cfg, 900 * E8, 882 * E8 as i128, PRICE).is_some());
    // Small targets: the 1 NEAR floor.
    assert!(order_for(&cfg, 10 * E8, 901_000_000, PRICE).is_none());
    assert!(order_for(&cfg, 10 * E8, 9 * E8 as i128, PRICE).is_some());

    // Through the contract: nothing is signed and only `hedge_in_band` is logged.
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl { value_e6: 100_000 * USD, margin_e6: 100_000 * USD, ..Hl::default() });
    deposit(&mut v, ALICE, 1_200 * NEAR);
    report(
        &mut v,
        2,
        NOW + 10,
        20,
        Hl {
            size_e8: -1_070 * E8 as i128,
            value_e6: 100_000 * USD,
            margin_e6: 100_000 * USD,
            ..Hl::default()
        },
    );
    set(KEEPER, 0, NOW + 11);
    v.rebalance();
    assert_eq!(call_to("ft_price").0, LINEAR);
    set_results(NOW + 11, vec![rate(RATE)]);
    match v.on_rebalance_rate() {
        PromiseOrValue::Value(sig) => assert!(sig.is_none()),
        PromiseOrValue::Promise(_) => panic!("an in-band hedge must not be signed"),
    }
    assert!(!has_call("sign"));
    assert!(!has_vault_event("hedge_order"));
    let e = vault_event("hedge_in_band");
    assert_eq!(num(&e["target_e8"]), 1_080 * E8);
    assert_eq!(num(&e["current_e8"]), 1_070 * E8);
    assert!(!v.hedge_order_signed);
}

fn signature_response() -> PromiseResult {
    ok_json(json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("02{}", "1a".repeat(32)) },
        "s": { "scalar": "2b".repeat(32) },
        "recovery_id": 1,
    }))
}

#[test]
fn rebalance_signs_the_expected_order_and_digest() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl::default());
    deposit(&mut v, ALICE, 1_000 * NEAR);
    let hl = Hl { value_e6: 10_000 * USD, margin_e6: 10_000 * USD, mark_e8: 363_450_000, ..Hl::default() };
    report(&mut v, 2, NOW + 10, 20, hl);

    set(KEEPER, 0, NOW + 11);
    v.rebalance();
    set_results(NOW + 12, vec![rate(RATE)]);
    v.on_rebalance_rate();

    // 1000 NEAR staked at 1.2 is 833.33… LiNEAR, worth 999.99… NEAR; 90% is 899.99999999 NEAR,
    // sold down to the 0.1 lot at 3.6345 × 0.98 rounded up to 5 significant figures.
    let expected = HlOrder {
        asset_index: 54,
        is_buy: false,
        price: "3.5619".into(),
        size: "899.9".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let e = vault_event("hedge_order");
    let order: HlOrder = serde_json::from_value(e["order"].clone()).unwrap();
    assert_eq!(order, expected);
    let nonce = e["nonce"].as_u64().unwrap();
    assert_eq!(nonce, (NOW + 12) * 1000);
    let digest = hex::encode(order_digest(&expected, nonce, false));
    assert_eq!(e["digest"], digest.as_str());
    assert_eq!(num(&e["target_e8"]), 89_999_999_999);
    assert_eq!(num(&e["current_e8"]), 0);

    let (to, args, attached) = call_to("sign");
    assert_eq!((to.as_str(), attached), (SIGNER, 1));
    let want = json!({
        "request": { "path": "parry-vault-hedge", "payload_v2": { "Ecdsa": digest }, "domain_id": 0 },
    });
    assert_eq!(args, want);
    assert_eq!(call_to("on_hedge_signed").1, json!({ "run_id": 2, "nonce": nonce }));

    set_results(NOW + 13, vec![signature_response()]);
    let sig = v.on_hedge_signed(2, nonce).unwrap();
    assert_eq!(sig.r, "1a".repeat(32));
    assert_eq!(sig.s, "2b".repeat(32));
    assert_eq!(sig.v, 28);
}

/// Margin that lands in the hedge account's Spot balance moves into Perps through a signed
/// `usdClassTransfer`: keeper or owner only, toward Perps only, with a nonce no hedge order used.
#[test]
fn margin_moves_from_spot_to_perps_with_a_signed_transfer() {
    let mut v = deploy();
    for who in [ALICE, RISK] {
        set(who, 0, NOW);
        let msg = panic_of(|| {
            v.hedge_margin_to_perp("997".into());
        });
        assert!(msg.contains("keeper or owner only"), "{msg}");
    }
    set(KEEPER, 0, NOW);
    let msg = panic_of(|| {
        v.hedge_margin_to_perp("-1".into());
    });
    assert!(msg.contains("bad transfer amount"), "{msg}");
    let mut low = ctx(KEEPER, 0, NOW);
    low.prepaid_gas(near_sdk::Gas::from_tgas(50));
    testing_env!(low.build());
    let msg = panic_of(|| {
        v.hedge_margin_to_perp("997".into());
    });
    assert!(msg.contains("attach at least 80 TGas"), "{msg}");

    set(KEEPER, 0, NOW);
    v.hedge_margin_to_perp("997".into());
    let e = vault_event("hedge_margin_to_perp");
    let nonce = e["nonce"].as_u64().unwrap();
    assert_eq!(nonce, NOW * 1000);
    let digest = hex::encode(usd_class_transfer_digest("997", true, nonce, false));
    assert_eq!((e["amount"].as_str(), e["digest"].as_str()), (Some("997"), Some(digest.as_str())));
    let (to, args, attached) = call_to("sign");
    assert_eq!((to.as_str(), attached), (SIGNER, 1));
    assert_eq!(
        args,
        json!({ "request": { "path": "parry-vault-hedge", "payload_v2": { "Ecdsa": digest }, "domain_id": 0 } })
    );
    assert_eq!(call_to("on_margin_signed").1, json!({ "nonce": nonce }));

    set_results(NOW + 1, vec![signature_response()]);
    let sig = v.on_margin_signed(nonce).unwrap();
    assert_eq!((sig.r, sig.s, sig.v), ("1a".repeat(32), "2b".repeat(32), 28));
    set_results(NOW + 1, vec![PromiseResult::Failed]);
    assert!(v.on_margin_signed(nonce).is_none());
    assert!(has_vault_event("hedge_sign_failed"));

    // The owner may move it too, and a second transfer in the same block takes the next nonce.
    set(OWNER, 0, NOW);
    v.hedge_margin_to_perp("3.5".into());
    assert_eq!(vault_event("hedge_margin_to_perp")["nonce"].as_u64(), Some(nonce + 1));
}

#[test]
fn one_order_per_report_and_increasing_nonces() {
    let mut v = deploy();
    register(&mut v, ALICE);
    let big = Hl { value_e6: 10_000 * USD, margin_e6: 10_000 * USD, ..Hl::default() };
    report(&mut v, 1, NOW, 20, big);
    deposit(&mut v, ALICE, 1_000 * NEAR);

    set(KEEPER, 0, NOW + 5);
    v.rebalance();
    set_results(NOW + 5, vec![rate(RATE)]);
    v.on_rebalance_rate();
    let first = vault_event("hedge_order")["nonce"].as_u64().unwrap();

    set(KEEPER, 0, NOW + 6);
    let msg = panic_of(|| {
        v.rebalance();
    });
    assert!(msg.contains("already signed for this report"), "{msg}");

    // A callback racing the first one is refused too.
    set_results(NOW + 6, vec![rate(RATE)]);
    v.on_rebalance_rate();
    assert!(!has_call("sign"));
    assert!(has_vault_event("hedge_skipped"));

    // Signing failed: the same report may be used again.
    set_results(NOW + 6, vec![PromiseResult::Failed]);
    assert!(v.on_hedge_signed(1, first).is_none());
    assert!(has_vault_event("hedge_sign_failed"));
    assert!(!v.hedge_order_signed);

    // Same block time as the first order: the nonce still increases.
    set(KEEPER, 0, NOW + 5);
    v.rebalance();
    set_results(NOW + 5, vec![rate(RATE)]);
    v.on_rebalance_rate();
    let second = vault_event("hedge_order")["nonce"].as_u64().unwrap();
    assert_eq!(second, first + 1);

    // A new report reopens rebalancing.
    report(&mut v, 2, NOW + 30, 20, big);
    assert!(!v.hedge_order_signed);
    set(KEEPER, 0, NOW + 31);
    v.rebalance();
}

#[test]
fn rebalance_needs_a_fresh_report() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl::default());
    set(KEEPER, 0, NOW + 901);
    let msg = panic_of(|| {
        v.rebalance();
    });
    assert!(msg.contains("older than 15 minutes"), "{msg}");
}

#[test]
fn queued_shares_are_not_hedged() {
    let mut v = deploy();
    register(&mut v, ALICE);
    register(&mut v, BOB);
    let big = Hl { value_e6: 100_000 * USD, margin_e6: 100_000 * USD, ..Hl::default() };
    report(&mut v, 1, NOW, 20, big);
    let a = deposit(&mut v, ALICE, 600 * NEAR);
    deposit(&mut v, BOB, 600 * NEAR);
    set(ALICE, 1, NOW + 5);
    v.request_withdraw(U128(a));
    let r = v.report.clone().unwrap();
    // Half the shares are queued: 90% of 600 NEAR.
    assert_eq!(v.hedge_plan(RATE, &r).target_e8, 540 * E8);
}

// ---------------------------------------------------------------------------------------------
// Reports and risk
// ---------------------------------------------------------------------------------------------

#[test]
fn report_authorization() {
    let mut v = deploy();
    let ok = report_json(5, NOW, 20, Hl::default());

    set(ALICE, 0, NOW);
    assert!(panic_of(|| v.on_vault_report(ok.clone())).contains("only the risk board"));

    set(RISK, 0, NOW);
    let other = report_json_for("other-vault.testnet", 5, NOW, 20, Hl::default());
    assert!(panic_of(|| v.on_vault_report(other)).contains("another vault"));
    let wrong_kind = ok.replace("\"vault_report\"", "\"risk_update\"");
    assert!(panic_of(|| v.on_vault_report(wrong_kind)).contains("not a vault report"));
    let wrong_asset = ok.replace("\"asset_index\":54", "\"asset_index\":0");
    assert!(panic_of(|| v.on_vault_report(wrong_asset)).contains("another asset index"));
    let bad_root = ok.replace(&"ab".repeat(32), &"AB".repeat(32));
    assert!(panic_of(|| v.on_vault_report(bad_root)).contains("64 lowercase hex"));
    assert!(panic_of(|| v.on_vault_report("{\"kind\":1}".into())).contains("malformed vault report"));

    v.on_vault_report(ok.clone());
    assert_eq!(v.latest_report().unwrap().run_id, 5);
    assert_eq!(vault_event("report_applied")["run_id"], 5);
    // Replays and older run ids are refused.
    assert!(panic_of(|| v.on_vault_report(ok.clone())).contains("run id must be newer"));
    let older = report_json(4, NOW, 20, Hl::default());
    assert!(panic_of(|| v.on_vault_report(older)).contains("run id must be newer"));
    let earlier = report_json(6, NOW - 1, 20, Hl::default());
    assert!(panic_of(|| v.on_vault_report(earlier)).contains("observed before the last one"));
    v.on_vault_report(report_json(6, NOW, 20, Hl::default()));
    assert_eq!(v.latest_report().unwrap().run_id, 6);

    // A new board starts its own run ids.
    set(OWNER, 1, NOW);
    v.set_risk(id("risk2.parry.testnet"));
    set("risk2.parry.testnet", 0, NOW + 1);
    v.on_vault_report(report_json(1, NOW + 1, 20, Hl::default()));
    assert_eq!(v.latest_report().unwrap().run_id, 1);
    set(RISK, 0, NOW + 2);
    assert!(panic_of(|| v.on_vault_report(report_json(9, NOW + 2, 20, Hl::default())))
        .contains("only the risk board"));
}

#[test]
fn risk_score_pauses_deposits_with_hysteresis() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 69, Hl::default());
    assert!(!v.vault_state().paused);
    report(&mut v, 2, NOW + 1, 70, Hl::default());
    assert_eq!(vault_event("deposits_paused")["score"], 70);
    assert!(v.vault_state().risk_paused);
    set(ALICE, 10 * NEAR, NOW + 2);
    assert!(panic_of(|| {
        v.deposit();
    })
    .contains("risk score is high"));
    // 65 is under 70 but not under 60: still paused, and no repeated event.
    report(&mut v, 3, NOW + 3, 65, Hl::default());
    assert!(v.vault_state().paused);
    assert!(!has_vault_event("deposits_paused") && !has_vault_event("deposits_resumed"));
    report(&mut v, 4, NOW + 4, 59, Hl::default());
    assert_eq!(vault_event("deposits_resumed")["score"], 59);
    assert!(!v.vault_state().paused);

    // The owner's pause is separate: a calm score does not lift it.
    set(OWNER, 1, NOW + 5);
    v.pause_deposits();
    report(&mut v, 5, NOW + 6, 10, Hl::default());
    let s = v.vault_state();
    assert!(s.paused && s.manual_paused && !s.risk_paused);
}

#[test]
fn risk_score_lowers_leverage_and_flags_margin() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 49, Hl::default());
    assert_eq!(v.hedge_status().effective_max_leverage_x100, 300);
    report(&mut v, 2, NOW + 1, 50, Hl::default());
    let e = vault_event("leverage_reduced");
    assert_eq!((e["score"].as_u64(), e["max_leverage_x100"].as_u64()), (Some(50), Some(200)));
    assert_eq!(v.hedge_status().effective_max_leverage_x100, 200);
    report(&mut v, 3, NOW + 2, 45, Hl::default());
    assert_eq!(v.hedge_status().effective_max_leverage_x100, 200);
    report(&mut v, 4, NOW + 3, 39, Hl::default());
    assert_eq!(vault_event("leverage_restored")["max_leverage_x100"], 300);
    assert_eq!(v.hedge_status().effective_max_leverage_x100, 300);

    report(&mut v, 5, NOW + 4, 85, Hl::default());
    assert_eq!(vault_event("margin_needed")["score"], 85);
    assert!(v.hedge_status().needs_margin);
    // 85 also pauses deposits and lowers leverage.
    assert!(v.vault_state().risk_paused);
    assert_eq!(v.hedge_status().effective_max_leverage_x100, 200);
    report(&mut v, 6, NOW + 5, 84, Hl::default());
    assert!(!v.hedge_status().needs_margin);
    assert!(!has_vault_event("margin_needed"));
}

// ---------------------------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------------------------

/// Runs `process_withdrawals` and its rate callback; returns how many were paid.
fn process(v: &mut Vault, secs: u64, r: u128) -> u32 {
    set(KEEPER, 0, secs);
    if let PromiseOrValue::Value(n) = v.process_withdrawals(10) {
        return n;
    }
    let n = call_to("on_withdraw_rate").1["max"].as_u64().unwrap() as u32;
    set_results(secs + 1, vec![rate(r)]);
    v.on_withdraw_rate(n)
}

/// (token, receiver, amount) of every `ft_transfer` the vault created.
fn ft_transfers() -> Vec<(String, String, u128)> {
    calls()
        .into_iter()
        .filter(|c| c.1 == "ft_transfer")
        .map(|c| (c.0, c.2["receiver_id"].as_str().unwrap().to_string(), num(&c.2["amount"])))
        .collect()
}

fn fund_buffer(v: &mut Vault, amount: u128) {
    set(USDC, 0, NOW);
    v.ft_on_transfer(id(OWNER), U128(amount), "buffer".into());
}

/// Alice and Bob each deposit 120 NEAR (100 LiNEAR) at 3 USD; returns Alice's shares.
fn two_holders(v: &mut Vault) -> u128 {
    register(v, ALICE);
    register(v, BOB);
    report(v, 1, NOW, 20, Hl::default());
    let a = deposit(v, ALICE, 120 * NEAR);
    deposit(v, BOB, 120 * NEAR);
    assert_eq!(v.staked_linear, 200 * NEAR);
    a
}

#[test]
fn request_withdraw_escrows_the_shares() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    set(ALICE, 0, NOW + 50);
    assert!(panic_of(|| {
        v.request_withdraw(U128(a));
    })
    .contains("exactly 1 yoctoNEAR"));
    set(ALICE, 1, NOW + 50);
    assert!(panic_of(|| {
        v.request_withdraw(U128(a + 1));
    })
    .contains("enough balance"));
    let id0 = v.request_withdraw(U128(a));
    assert_eq!(id0, 0);
    let t = events("nep141", "ft_transfer").pop().unwrap();
    assert_eq!((t[0]["old_owner_id"].as_str(), t[0]["new_owner_id"].as_str()), (Some(ALICE), Some(VAULT)));
    assert_eq!(v.ft_balance_of(id(VAULT)).0, a);
    assert_eq!(v.ft_balance_of(id(ALICE)).0, 0);
    let s = v.vault_state();
    assert_eq!((s.queued_shares.0, s.queue_length), (a, 1));
    assert_eq!(s.active_shares.0, s.total_shares.0 - a);
    assert_eq!(
        v.queue(None, None),
        vec![Withdrawal { id: 0, account: id(ALICE), shares: U128(a), requested_at: NOW + 50 }]
    );
    assert_eq!(v.withdrawal(0).unwrap().shares.0, a);

    // Shares cannot be parked with the escrow by a plain transfer.
    set(BOB, 1, NOW + 51);
    assert!(panic_of(|| v.ft_transfer(id(VAULT), U128(1), None)).contains("request_withdraw"));
}

#[test]
fn withdrawal_waits_for_a_later_report_and_pays_positive_pnl() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    fund_buffer(&mut v, 1_000 * USD);
    // The hedge is up 60 USD.
    report(&mut v, 2, NOW + 40, 20, Hl::pnl(60 * USD as i128));
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a));

    // The latest report was observed before the request: nothing is ready.
    assert_eq!(process(&mut v, NOW + 60, RATE), 0);
    assert!(calls().is_empty());

    report(&mut v, 3, NOW + 70, 20, Hl::pnl(60 * USD as i128));
    let supply = v.ft_total_supply().0;
    assert_eq!(process(&mut v, NOW + 71, RATE), 1);
    assert_eq!(
        ft_transfers(),
        vec![
            (LINEAR.to_string(), ALICE.to_string(), 100 * NEAR),
            (USDC.to_string(), ALICE.to_string(), 30 * USD)
        ]
    );
    let e = vault_event("withdrawal_processed");
    assert_eq!(num(&e["linear"]), 100 * NEAR);
    assert_eq!(num(&e["usdc"]), 30 * USD);
    assert_eq!(num(&e["usdc_owed"]), 0);
    assert_eq!(num(&e["pnl_e6"]), 30 * USD);
    let burn = events("nep141", "ft_burn").pop().unwrap();
    assert_eq!((burn[0]["owner_id"].as_str(), num(&burn[0]["amount"])), (Some(VAULT), a));

    assert_eq!(v.ft_total_supply().0, supply - a);
    assert_eq!(v.staked_linear, 100 * NEAR);
    assert_eq!(v.settled_pnl_e6, 30 * USD as i128);
    assert_eq!(v.buffer_usdc, 970 * USD);
    let s = v.vault_state();
    assert_eq!((s.queued_shares.0, s.queue_length), (0, 0));
    // Bob keeps his half: 100 LiNEAR at 1.2 × 3 = 360 USD, plus 30 USD of hedge equity.
    assert_eq!(s.hedge.equity_e6.0, 30 * USD as i128);
    assert_eq!(s.nav_e6.0, 390 * USD);
    assert!(v.withdrawal(0).is_none());
}

#[test]
fn withdrawal_with_negative_pnl_pays_less_linear() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    // The hedge is down 60 USD: NAV 720 − 60 = 660, Alice's half is worth 330 USD.
    report(&mut v, 2, NOW + 40, 20, Hl::pnl(-60 * USD as i128));
    let nav_before = v.vault_state().nav_e6.0;
    assert_eq!(nav_before, 660 * USD);
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a));
    report(&mut v, 3, NOW + 70, 20, Hl::pnl(-60 * USD as i128));
    assert_eq!(process(&mut v, NOW + 71, RATE), 1);

    // 330 USD at 3.6 USD per LiNEAR is 91.66… LiNEAR (rounded down); no USDC.
    let paid = nav::near_to_linear(nav::usd_e6_to_near(330 * USD, PRICE), RATE);
    assert_eq!(ft_transfers(), vec![(LINEAR.to_string(), ALICE.to_string(), paid)]);
    let e = vault_event("withdrawal_processed");
    assert_eq!(num(&e["usdc"]), 0);
    assert_eq!(e["pnl_e6"], "-30000000");
    // Bob's half of the LiNEAR stays his; the rest of Alice's half backs her share of the loss.
    assert_eq!(v.staked_linear, 100 * NEAR);
    assert_eq!(v.loss_backing_linear, 100 * NEAR - paid);
    assert_eq!(v.settled_pnl_e6, -30 * USD as i128);
    // Bob's position is exactly half of what it was: 360 − 30.
    let s = v.vault_state();
    assert_eq!(s.nav_e6.0, 330 * USD);
    assert_eq!(s.hedge.equity_e6.0, -30 * USD as i128);

    // The owner can release the loss backing to the margin provider.
    set(OWNER, 1, NOW + 80);
    v.release_loss_backing(U128(100 * NEAR - paid));
    assert_eq!(ft_transfers(), vec![(LINEAR.to_string(), OWNER.to_string(), 100 * NEAR - paid)]);
    assert_eq!(v.loss_backing_linear, 0);
    set_results(NOW + 81, vec![PromiseResult::Failed]);
    v.on_loss_backing_released(U128(100 * NEAR - paid));
    assert_eq!(v.loss_backing_linear, 100 * NEAR - paid);
}

#[test]
fn short_buffer_records_owed_usdc_and_claim_pays_it_later() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    fund_buffer(&mut v, 10 * USD);
    report(&mut v, 2, NOW + 40, 20, Hl::pnl(60 * USD as i128));
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a));
    report(&mut v, 3, NOW + 70, 20, Hl::pnl(60 * USD as i128));
    process(&mut v, NOW + 71, RATE);
    let e = vault_event("withdrawal_processed");
    assert_eq!((num(&e["usdc"]), num(&e["usdc_owed"])), (10 * USD, 20 * USD));
    assert_eq!(v.buffer_usdc, 0);
    assert_eq!(v.claimable(id(ALICE)), Claim { linear: U128(0), usdc: U128(0), usdc_owed: U128(20 * USD) });
    // The whole 30 USD is settled even though 20 is still owed.
    assert_eq!(v.settled_pnl_e6, 30 * USD as i128);

    set(ALICE, 0, NOW + 80);
    assert!(panic_of(|| {
        v.claim();
    })
    .contains("the USDC buffer is empty"));

    fund_buffer(&mut v, 15 * USD);
    set(ALICE, 0, NOW + 90);
    let sent = v.claim();
    assert_eq!(sent.usdc.0, 15 * USD);
    assert_eq!(ft_transfers(), vec![(USDC.to_string(), ALICE.to_string(), 15 * USD)]);
    assert_eq!(v.claimable(id(ALICE)).usdc_owed.0, 5 * USD);
    fund_buffer(&mut v, 50 * USD);
    set(ALICE, 0, NOW + 91);
    v.claim();
    assert_eq!(v.claimable(id(ALICE)), Claim::default());
    assert_eq!(v.buffer_usdc, 45 * USD);
}

#[test]
fn failed_transfers_become_claims_and_claim_retries_them() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    fund_buffer(&mut v, 100 * USD);
    report(&mut v, 2, NOW + 40, 20, Hl::pnl(60 * USD as i128));
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a));
    report(&mut v, 3, NOW + 70, 20, Hl::pnl(60 * USD as i128));
    process(&mut v, NOW + 71, RATE);
    let payouts = calls().into_iter().filter(|c| c.1 == "on_payout").map(|c| c.2).collect::<Vec<_>>();
    assert_eq!(payouts.len(), 2);
    assert_eq!(
        payouts[0],
        json!({ "account": ALICE, "token": "linear", "amount": (100 * NEAR).to_string() })
    );

    // Alice is not registered with LiNEAR: that transfer fails; the USDC one succeeds.
    set_results(NOW + 72, vec![PromiseResult::Failed]);
    assert!(!v.on_payout(id(ALICE), "linear".into(), U128(100 * NEAR)));
    assert_eq!(vault_event("payout_failed")["token"], "linear");
    set_results(NOW + 72, vec![ok_empty()]);
    assert!(v.on_payout(id(ALICE), "usdc".into(), U128(30 * USD)));
    assert_eq!(v.claimable(id(ALICE)), Claim { linear: U128(100 * NEAR), usdc: U128(0), usdc_owed: U128(0) });
    // Claims are outside NAV: Bob's NAV is untouched.
    assert_eq!(v.vault_state().nav_e6.0, 390 * USD);

    set(BOB, 0, NOW + 80);
    assert!(panic_of(|| {
        v.claim();
    })
    .contains("nothing to claim"));
    set(ALICE, 0, NOW + 80);
    let sent = v.claim();
    assert_eq!(sent.linear.0, 100 * NEAR);
    assert_eq!(ft_transfers(), vec![(LINEAR.to_string(), ALICE.to_string(), 100 * NEAR)]);
    assert_eq!(vault_event("claimed")["linear"], (100 * NEAR).to_string());
    assert_eq!(v.claimable(id(ALICE)), Claim::default());

    // Still failing: recorded again.
    set_results(NOW + 81, vec![PromiseResult::Failed]);
    v.on_payout(id(ALICE), "linear".into(), U128(100 * NEAR));
    assert_eq!(v.claimable(id(ALICE)).linear.0, 100 * NEAR);
}

#[test]
fn withdrawals_wait_for_a_fresh_report_and_go_in_order() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    let b = v.ft_balance_of(id(BOB)).0;
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a / 2));
    set(BOB, 1, NOW + 60);
    v.request_withdraw(U128(b));
    set(ALICE, 1, NOW + 70);
    v.request_withdraw(U128(a - a / 2));
    // Only the first predates this report.
    report(&mut v, 2, NOW + 55, 20, Hl::default());
    assert_eq!(process(&mut v, NOW + 56, RATE), 1);
    assert_eq!(v.queue(None, None)[0].id, 1);
    // The second predates this one; the third does not.
    report(&mut v, 3, NOW + 65, 20, Hl::default());
    assert_eq!(process(&mut v, NOW + 66, RATE), 1);
    assert_eq!(v.queue(None, None).len(), 1);
    assert_eq!(v.queue(None, None)[0].id, 2);
    assert_eq!(process(&mut v, NOW + 67, RATE), 0);

    set(KEEPER, 0, NOW + 65 + 901);
    assert!(panic_of(|| {
        v.process_withdrawals(4);
    })
    .contains("older than 15 minutes"));
}

// ---------------------------------------------------------------------------------------------
// Owner and views
// ---------------------------------------------------------------------------------------------

#[test]
fn owner_methods_need_the_owner_and_one_yocto() {
    let mut v = deploy();
    set(ALICE, 1, NOW);
    assert!(panic_of(|| v.set_hedge_ratio(8_000)).contains("owner only"));
    set(OWNER, 0, NOW);
    assert!(panic_of(|| v.set_hedge_ratio(8_000)).contains("exactly 1 yoctoNEAR"));
    set(OWNER, 1, NOW);
    assert!(panic_of(|| v.set_hedge_ratio(4_999)).contains("5000 to 10000"));
    assert!(panic_of(|| v.set_hedge_ratio(10_001)).contains("5000 to 10000"));
    v.set_hedge_ratio(10_000);
    assert_eq!(v.hedge_status().hedge_ratio_bps, 10_000);
    v.set_caps(U128(50 * NEAR), U128(2 * NEAR));
    assert_eq!((v.vault_state().deposit_cap.0, v.vault_state().min_deposit.0), (50 * NEAR, 2 * NEAR));
    assert!(panic_of(|| v.set_caps(U128(NEAR), U128(2 * NEAR))).contains("deposit_cap must be at least"));
    v.set_keeper(id("keeper2.parry.testnet"));
    assert_eq!(v.config().keeper, id("keeper2.parry.testnet"));
    assert_eq!(vault_event("config_updated")["key"], "keeper");
    set(ALICE, 1, NOW);
    assert!(panic_of(|| {
        v.release_loss_backing(U128(1));
    })
    .contains("owner only"));
}

#[test]
fn views_report_state_reserves_and_yield() {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, Hl { funding_e6: 2 * USD as i128, ..Hl::pnl(5 * USD as i128) });
    deposit(&mut v, ALICE, 120 * NEAR);
    // A later rate 1% higher.
    report(
        &mut v,
        2,
        NOW + 100,
        33,
        Hl { size_e8: -90 * E8 as i128, funding_e6: 3 * USD as i128, ..Hl::pnl(7 * USD as i128) },
    );
    set_results(NOW + 101, vec![rate(RATE * 101 / 100)]);
    v.on_withdraw_rate(0);

    set(ALICE, 0, NOW + 160);
    let s = v.vault_state();
    assert_eq!((s.risk_score, s.report_at, s.report_age_secs), (Some(33), Some(NOW + 100), Some(60)));
    assert_eq!(s.linear_rate_e24.0, RATE * 101 / 100);
    // 100 LiNEAR × 1.212 × 3 = 363.6 USD, less the insurance fund's 10% of the 3.6 USD staking
    // yield, plus 7 USD of hedge equity.
    assert_eq!(s.nav_e6.0, 370_240_000);
    assert!(s.insurance_value_usd_e6.0.abs_diff(360_000) <= 1, "rounded down");
    assert_eq!(s.hedge.current_e8.0, 90 * E8 as i128);
    assert_eq!(s.hedge.leverage_x100, 27);
    let reserves = v.reserves().unwrap();
    assert_eq!((reserves.root, reserves.ratio_bps, reserves.at), ("ab".repeat(32), 10_416, NOW + 100));
    assert_eq!(v.collateral_ratio(), Some(10_416));
    let y = v.yield_breakdown();
    assert_eq!(y.staking_rate_growth_bps, 100);
    assert_eq!(y.funding_e6.0, 3 * USD as i128);
    assert_eq!(y.hedge_pnl_e6.0, 7 * USD as i128);
    assert_eq!(v.share_price().0, nav::share_price_e6(s.nav_e6.0, s.total_shares.0));
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

fn big(v: u128) -> BigUint {
    BigUint::from(v)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    /// A deposit followed at once by a withdrawal of the same shares never returns more value
    /// than was deposited, whatever the vault held before, the hedge equity and the prices.
    #[test]
    fn deposit_then_withdraw_never_profits(
        linear in 0u128..2_000_000 * NEAR,
        r in E24..3 * E24,
        p in 1_000_000u128..100_000_000_000,
        equity in -1_000_000_000_000i128..1_000_000_000_000,
        supply in 0u128..10_000_000 * NEAR,
        d in 1_000u128..1_000_000 * NEAR,
    ) {
        // A vault with no shares holds nothing.
        let (linear, equity) = if supply == 0 { (0, 0) } else { (linear, equity) };
        let nav_up = nav::nav_e6(linear, r, p, equity, Rounding::Up);
        let value = nav::near_to_usd_e6(d, p, Rounding::Down);
        let Some(shares) = nav::shares_for(value, supply, nav_up) else { return Ok(()) };
        prop_assume!(shares > 0);
        let linear_after = linear + nav::near_to_linear(d, r);
        let out = nav::payout(shares, supply + shares, linear_after, r, p, equity);
        prop_assert!(out.linear + out.retained <= linear_after);
        let usdc = if out.pnl_e6 > 0 { out.pnl_e6 as u128 } else { 0 };
        // Both sides scaled by 1e50: LiNEAR × r × P versus D × P × 1e24.
        let received = big(out.linear) * big(r) * big(p) + big(usdc) * big(E24) * big(E24) * big(100);
        let deposited = big(d) * big(p) * big(E24);
        prop_assert!(received <= deposited, "received {} > deposited {}", received, deposited);
    }

    /// Shares round down: shares × NAV ≤ value × supply < (shares + 1) × NAV, and a result that
    /// does not fit is refused rather than wrapped.
    #[test]
    fn shares_round_down(
        value in 0u128..1_000_000_000_000_000,
        supply in 1u128..1_000_000_000 * E24,
        nav in 1u128..1_000_000_000_000_000,
    ) {
        match nav::shares_for(value, supply, nav) {
            Some(s) => {
                prop_assert!(big(s) * big(nav) <= big(value) * big(supply));
                prop_assert!(big(value) * big(supply) < (big(s) + big(1)) * big(nav));
            }
            None => prop_assert!(big(value) * big(supply) / big(nav) > big(u128::MAX)),
        }
    }

    /// Every order the vault builds is valid for Hyperliquid and stays inside the band.
    #[test]
    fn orders_are_valid_and_inside_the_band(
        mark in 1_000u128..10_000_000_000_000,
        sz in 0u8..=5,
        band in 1u32..=300,
        target in 0u128..10_000_000 * E8,
        current in -1_000_000i128 * E8 as i128..10_000_000 * E8 as i128,
    ) {
        let cfg = HedgeConfig { sz_decimals: sz, band_bps: band, ..hedge_config() };
        let Some(o) = order_for(&cfg, target, current, mark) else { return Ok(()) };
        let price = parse_e8(&o.price).unwrap();
        let size = parse_e8(&o.size).unwrap();
        prop_assert!(!o.price.ends_with('0') || !o.price.contains('.'));
        prop_assert!(!o.size.ends_with('0') || !o.size.contains('.'));
        let decimals = o.price.split_once('.').map(|(_, f)| f.len() as u32).unwrap_or(0);
        prop_assert!(decimals <= 6 - sz as u32);
        if decimals > 0 {
            let sig = o.price.replace('.', "").trim_start_matches('0').len();
            prop_assert!(sig <= 5, "{} has more than 5 significant figures", o.price);
        }
        prop_assert_eq!(size % 10u128.pow(8 - sz as u32), 0);
        let gap = (target as i128 - current).unsigned_abs();
        prop_assert!(size <= gap);
        prop_assert_eq!(o.reduce_only, o.is_buy);
        prop_assert_eq!(o.is_buy, (target as i128) < current);
        // Never more aggressive than the band.
        if o.is_buy {
            prop_assert!(big(price) * big(10_000) <= big(mark) * big(10_000 + band as u128));
        } else {
            prop_assert!(big(price) * big(10_000) >= big(mark) * big(10_000 - band as u128));
        }
    }

    /// A capped target never exceeds the maximum leverage.
    #[test]
    fn capped_target_respects_leverage(
        linear in 0u128..10_000_000 * NEAR,
        value in 0u128..100_000_000 * USD,
        lev in 100u32..=1_000,
        mark in 1_000_000u128..100_000_000_000,
    ) {
        let target = target_short_e8(linear, RATE, 1, 1, 10_000).min(leverage_cap_e8(value, lev, mark));
        if value > 0 {
            prop_assert!(order::leverage_x100(target, mark, value) <= lev);
        } else {
            prop_assert_eq!(target, 0);
        }
    }
}

#[test]
fn audit_dust_withdrawal_requests_empty_the_account_and_pay_their_place() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    assert!(a > crate::withdraw::MIN_WITHDRAW_SHARES);
    set(ALICE, 1, NOW + 50);
    assert!(panic_of(|| {
        v.request_withdraw(U128(1));
    })
    .contains("at least one share"));
    // One share is fine, and so is a whole balance smaller than a share that pays its place.
    v.request_withdraw(U128(crate::withdraw::MIN_WITHDRAW_SHARES));
    v.ft_transfer(id(BOB), U128(a - crate::withdraw::MIN_WITHDRAW_SHARES - 5), None);
    assert_eq!(v.ft_balance_of(id(ALICE)).0, 5);
    assert!(panic_of(|| {
        v.request_withdraw(U128(5));
    })
    .contains("attaches 0.005 NEAR"));
    set(ALICE, crate::withdraw::DUST_WITHDRAW_FEE, NOW + 51);
    v.request_withdraw(U128(5));
    assert_eq!(v.vault_state().queue_length, 2);
}

// ---------------------------------------------------------------------------------------------
// Audit regressions
// ---------------------------------------------------------------------------------------------

/// A deposit is priced at a fresh oracle price, but the hedge equity comes from a report up to
/// 15 minutes old. After NEAR fell, the short has gained more than the report shows: priced
/// against the stale equity, a deposit would buy shares below their value and take that gain
/// from the holders. The hedge is valued at the deposit's price instead.
#[test]
fn audit_deposit_values_the_hedge_at_the_deposit_price() {
    let mut v = deploy();
    register(&mut v, ALICE);
    register(&mut v, BOB);
    report(&mut v, 1, NOW, 20, Hl::default());
    let a = deposit(&mut v, ALICE, 100 * NEAR);
    // The report: a 90 NEAR short at a $3.00 mark, no equity yet.
    report(&mut v, 2, NOW + 10, 20, Hl { size_e8: -90 * E8 as i128, ..Hl::default() });
    // NEAR is at $2.95 when Bob deposits (1.7% from the mark, inside the 2% bound): the short is
    // up 90 × 0.05 = $4.50 that the report does not show.
    let b = deposit_at(&mut v, BOB, 100 * NEAR, NOW + 11, 295_000_000, RATE);
    let linear = nav::near_to_linear(100 * NEAR, RATE);
    let nav = nav::nav_e6(linear, RATE, 295_000_000, 4_500_000, Rounding::Up);
    assert_eq!(nav, 299_500_000);
    let value = nav::near_to_usd_e6(100 * NEAR, 295_000_000, Rounding::Down);
    assert_eq!(b, nav::shares_for(value, a, nav).unwrap());
    assert!(b < a, "Bob's $295 buys less than Alice's $300 of shares");
    // The view values the hedge at the same price.
    set(ALICE, 0, NOW + 12);
    assert_eq!(
        v.vault_state().nav_e6.0,
        nav::nav_e6(2 * linear, RATE, 295_000_000, 4_500_000, Rounding::Down)
    );
}

// ---------------------------------------------------------------------------------------------
// Insurance fund
// ---------------------------------------------------------------------------------------------

/// A report with extra top-level fields (the hedge ratio, its reason, the margin ratio).
fn report_with(v: &mut Vault, run_id: u64, at: u64, score: u8, hl: Hl, extra: Value) {
    let mut r: Value = serde_json::from_str(&report_json(run_id, at, score, hl)).unwrap();
    for (k, x) in extra.as_object().unwrap() {
        r[k] = x.clone();
    }
    set(RISK, 0, at);
    v.on_vault_report(r.to_string());
}

/// A short hedge (so funding deltas count) with `funding_e6` received over its life.
fn short_funded(funding_e6: i128) -> Hl {
    Hl { size_e8: -90 * E8 as i128, funding_e6, ..Hl::default() }
}

/// Alice holds 100 LiNEAR (120 NEAR at 1.2); the hedge is short.
fn funded_vault() -> Vault {
    let mut v = deploy();
    register(&mut v, ALICE);
    report(&mut v, 1, NOW, 20, short_funded(0));
    deposit(&mut v, ALICE, 120 * NEAR);
    v
}

#[test]
fn insurance_takes_ten_percent_of_positive_yield_outside_the_share_price() {
    let mut v = funded_vault();
    let linear_before = v.staked_linear;
    let price_before = v.share_price().0;

    // The rate grows 1% (1.2 NEAR of yield on 100 LiNEAR): 0.12 NEAR moves to the fund as LiNEAR
    // when the vault reads the rate.
    let r2 = RATE * 101 / 100;
    set_results(NOW + 5, vec![rate(r2)]);
    v.on_withdraw_rate(0);
    let fund_linear = nav::near_to_linear(12 * NEAR / 100, r2);
    assert_eq!(v.insurance().linear.0, fund_linear);
    assert_eq!(v.staked_linear, linear_before - fund_linear);
    // A rate seen before (or lower) skims nothing more.
    set_results(NOW + 6, vec![rate(RATE)]);
    v.on_withdraw_rate(0);
    set_results(NOW + 6, vec![rate(r2)]);
    v.on_withdraw_rate(0);
    assert_eq!(v.insurance().linear.0, fund_linear);

    // The next report: the hedge received 50 USD of funding, 5 USD of it moves to the fund.
    report(&mut v, 2, NOW + 10, 20, Hl { value_e6: MARGIN + 50 * USD, ..short_funded(50 * USD as i128) });
    let e = vault_event("insurance_inflow");
    assert_eq!(
        e,
        json!({ "linear": fund_linear.to_string(), "usdc_e6": (5 * USD).to_string(), "report_at": NOW + 10 })
    );
    let i = v.insurance();
    assert_eq!(i.usdc_e6.0, 5 * USD);
    assert_eq!(i.share_bps, 1_000);
    // The depositors keep the other 45 USD of the funding in their hedge equity.
    assert_eq!(v.hedge_status().equity_e6.0, 45 * USD as i128);
    // The share price excludes the fund: the staking growth less the fund's tenth, plus 45 USD.
    set(ALICE, 0, NOW + 11);
    let s = v.vault_state();
    let expected = nav::nav_e6(linear_before - fund_linear, r2, PRICE, 45 * USD as i128, Rounding::Down);
    assert_eq!(s.nav_e6.0, expected);
    assert!(v.share_price().0 > price_before);
    assert_eq!(s.insurance_value_usd_e6.0, i.value_usd_e6.0);
    // 5 USD of USDC and 0.12 NEAR of LiNEAR at 3 USD.
    assert!(i.value_usd_e6.0.abs_diff(5 * USD + 360_000) <= 1, "{}", i.value_usd_e6.0);

    let h = v.insurance_history(None, None);
    assert_eq!(h.len(), 1);
    assert_eq!((h[0].event.as_str(), h[0].report_at), ("insurance_inflow", Some(NOW + 10)));

    // A report with no new yield moves nothing and announces nothing.
    report(&mut v, 3, NOW + 20, 20, Hl { value_e6: MARGIN + 50 * USD, ..short_funded(50 * USD as i128) });
    assert!(!has_vault_event("insurance_inflow"));
}

#[test]
fn funding_deltas_need_a_position_in_both_reports() {
    let mut v = deploy();
    report(&mut v, 1, NOW, 20, Hl { funding_e6: 100 * USD as i128, ..Hl::default() });
    // A position opens: no delta against a report without one.
    report(&mut v, 2, NOW + 10, 20, short_funded(0));
    assert!(v.insurance.funding_window.is_empty());
    report(&mut v, 3, NOW + 20, 20, short_funded(-30 * USD as i128));
    assert_eq!(v.insurance.funding_window, vec![-30 * USD as i128]);
    assert_eq!(v.insurance().negative_funding_e6.0, 30 * USD);
    assert_eq!(v.insurance().recent_funding_e6.0, -30 * USD as i128);
    // The window keeps the newest 12 deltas.
    for k in 0..13 {
        report(
            &mut v,
            4 + k,
            NOW + 30 + k,
            20,
            short_funded(-30 * USD as i128 + (k as i128 + 1) * USD as i128),
        );
    }
    assert_eq!(v.insurance.funding_window.len(), insurance::FUNDING_WINDOW);
}

/// A vault whose fund holds 10 USD of USDC and about 3.6 USD of LiNEAR, after the hedge received
/// funding and then paid 30 USD of it.
fn vault_with_fund() -> Vault {
    let mut v = funded_vault();
    set_results(NOW + 5, vec![rate(RATE * 101 / 100)]);
    v.on_withdraw_rate(0);
    set_results(NOW + 6, vec![rate(RATE * 111 / 100)]);
    v.on_withdraw_rate(0);
    report(&mut v, 2, NOW + 10, 20, short_funded(100 * USD as i128));
    report(&mut v, 3, NOW + 20, 20, short_funded(70 * USD as i128));
    assert_eq!(v.insurance().usdc_e6.0, 10 * USD);
    v
}

fn pay(v: &mut Vault, who: &str, kind: &str, amount: u128, report_at: u64, secs: u64) -> String {
    set(who, 0, secs);
    panic_of(|| {
        v.insurance_pay(kind.into(), U128(amount), report_at);
    })
}

#[test]
fn negative_funding_payout_returns_value_to_the_depositors() {
    let mut v = vault_with_fund();
    let at = NOW + 20;
    assert!(pay(&mut v, ALICE, "negative_funding", USD, at, NOW + 21).contains("keeper only"));
    assert!(pay(&mut v, KEEPER, "negative_funding", USD, at - 10, NOW + 21).contains("latest report"));
    assert!(pay(&mut v, KEEPER, "fees", USD, at, NOW + 21).contains("kind must be"));
    // The last reports show 70 USD received net: nothing is payable.
    assert!(pay(&mut v, KEEPER, "negative_funding", USD, at, NOW + 21).contains("no net negative funding"));

    // Funding turns: 100 USD more paid, the window is net negative.
    report(&mut v, 4, NOW + 30, 20, short_funded(-30 * USD as i128));
    let at = NOW + 30;
    assert!(
        pay(&mut v, KEEPER, "negative_funding", 131 * USD, at, NOW + 31).contains("above the fund's value")
    );

    let equity_before = v.hedge_status().equity_e6.0;
    let linear_before = v.staked_linear;
    set(KEEPER, 0, NOW + 31);
    let reason = v.insurance_pay("negative_funding".into(), U128(3 * USD), at);
    assert!(reason.contains("not covered yet"), "{reason}");
    let e = vault_event("insurance_paid");
    assert_eq!(
        (e["kind"].as_str(), e["amount_usd_e6"].as_str()),
        (Some("negative_funding"), Some("3000000"))
    );
    // Paid from the fund's USDC: the depositors' hedge equity rises by 3 USD.
    assert_eq!(v.hedge_status().equity_e6.0, equity_before + 3 * USD as i128);
    assert_eq!(v.insurance().usdc_e6.0, 7 * USD);
    assert_eq!(v.insurance().covered_negative_funding_e6.0, 3 * USD);

    let fund_linear = v.insurance().linear.0;
    set(KEEPER, 0, NOW + 32);
    // 25% of the day's value (about 14 USD at the first payout) caps the day at about 3.5 USD.
    let msg = panic_of(|| {
        v.insurance_pay("negative_funding".into(), U128(USD), at);
    });
    assert!(msg.contains("per-day cap"), "{msg}");
    // The next day the cap starts over at a quarter of what is left (about 11 USD).
    let day2 = NOW + 86_400;
    report(&mut v, 5, day2, 20, short_funded(-40 * USD as i128));
    assert!(pay(&mut v, KEEPER, "negative_funding", 3 * USD, day2, day2 + 1).contains("per-day cap"));
    set(KEEPER, 0, day2 + 1);
    v.insurance_pay("negative_funding".into(), U128(2 * USD), day2);
    assert_eq!(v.insurance().paid_today_e6.0, 2 * USD);
    assert_eq!(v.insurance().paid_total_e6.0, 5 * USD);
    assert_eq!(v.insurance().usdc_e6.0, 5 * USD);
    assert_eq!(v.insurance().linear.0, fund_linear);
    assert_eq!(v.staked_linear, linear_before);
    let history = v.insurance_history(None, Some(2));
    assert_eq!(
        history.iter().map(|h| h.event.as_str()).collect::<Vec<_>>(),
        vec!["insurance_paid", "insurance_paid"]
    );
    assert_eq!(history[0].at, day2 + 1);
}

#[test]
fn payouts_past_the_usdc_use_the_funds_linear() {
    let mut v = vault_with_fund();
    v.insurance.max_payout_e6 = 1_000 * USD;
    v.insurance.cap_per_day_bps = 10_000;
    report(&mut v, 4, NOW + 30, 20, short_funded(-60 * USD as i128));
    let linear_before = v.staked_linear;
    let fund_linear = v.insurance().linear.0;
    set(KEEPER, 0, NOW + 31);
    v.insurance_pay("negative_funding".into(), U128(12 * USD), NOW + 30);
    // 10 USD of USDC, then 2 USD of LiNEAR at the last rate and price.
    let moved = nav::near_to_linear(nav::usd_e6_to_near(2 * USD, PRICE), v.linear_rate_e24);
    assert_eq!(v.insurance().usdc_e6.0, 0);
    assert_eq!(v.insurance().linear.0, fund_linear - moved);
    assert_eq!(v.staked_linear, linear_before + moved);
    // At most the negative funding not yet covered: 160 USD paid over the reports, 12 covered.
    // (A fund large enough that the value and the day's cap do not bind first.)
    v.insurance.linear = 1_000 * NEAR;
    v.insurance.day_value_e6 = 10_000 * USD;
    let msg = pay(&mut v, KEEPER, "negative_funding", 149 * USD, NOW + 30, NOW + 32);
    assert!(msg.contains("not yet covered"), "{msg}");
    assert_eq!(pay(&mut v, KEEPER, "negative_funding", 148 * USD, NOW + 30, NOW + 32), "no panic");
}

#[test]
fn per_payout_cap_binds() {
    let mut v = vault_with_fund();
    v.insurance.max_payout_e6 = 2 * USD;
    report(&mut v, 4, NOW + 30, 20, short_funded(-60 * USD as i128));
    assert!(
        pay(&mut v, KEEPER, "negative_funding", 2 * USD + 1, NOW + 30, NOW + 31).contains("per-payout cap")
    );
    assert_eq!(pay(&mut v, KEEPER, "negative_funding", 2 * USD, NOW + 30, NOW + 31), "no panic");
}

#[test]
fn hedge_slippage_payout_is_bounded_by_the_signed_order() {
    let mut v = vault_with_fund();
    v.insurance.cap_per_day_bps = 10_000;
    let big = Hl { value_e6: 10_000 * USD, margin_e6: 10_000 * USD, ..short_funded(70 * USD as i128) };
    report(&mut v, 4, NOW + 30, 20, big);
    assert!(pay(&mut v, KEEPER, "hedge_slippage", USD, NOW + 30, NOW + 31).contains("no hedge order"));
    set(KEEPER, 0, NOW + 31);
    v.rebalance();
    set_results(NOW + 31, vec![rate(RATE * 111 / 100)]);
    v.on_rebalance_rate();
    let order = v.insurance.last_order.clone().unwrap();
    assert_eq!(order.report_at, NOW + 30);
    // The fill shows only in a later report.
    assert!(pay(&mut v, KEEPER, "hedge_slippage", USD, NOW + 30, NOW + 32).contains("later report"));
    report(&mut v, 5, NOW + 40, 20, big);
    // Bound: size × mark × band (2%).
    let bound = order.size_e8.0 * order.mark_e8.0 / 10_000_000_000 * 200 / 10_000;
    assert!(bound > 0 && bound < 10 * USD, "{bound}");
    assert!(pay(&mut v, KEEPER, "hedge_slippage", bound + 1, NOW + 30, NOW + 41).contains("band"));
    assert_eq!(pay(&mut v, KEEPER, "hedge_slippage", bound, NOW + 30, NOW + 41), "no panic");
    assert!(pay(&mut v, KEEPER, "hedge_slippage", 1, NOW + 30, NOW + 42).contains("already compensated"));
}

#[test]
fn margin_top_up_earmarks_value_while_margin_is_needed() {
    let mut v = vault_with_fund();
    v.insurance.cap_per_day_bps = 10_000;
    assert!(pay(&mut v, KEEPER, "margin_top_up", USD, NOW + 20, NOW + 21).contains("does not need margin"));
    report(&mut v, 4, NOW + 30, 90, short_funded(70 * USD as i128));
    let equity = v.hedge_status().equity_e6.0;
    let nav_before = v.vault_state().nav_e6.0;
    set(KEEPER, 0, NOW + 31);
    v.insurance_pay("margin_top_up".into(), U128(11 * USD), NOW + 30);
    let i = v.insurance();
    assert_eq!(i.margin_reserved_usdc_e6.0, 10 * USD);
    assert!(i.margin_reserved_linear.0 > 0);
    assert!(i.margin_reserved_usd_e6.0.abs_diff(11 * USD) <= 1);
    // Earmarked value is neither the fund's nor the depositors'.
    assert_eq!(v.hedge_status().equity_e6.0, equity);
    set(ALICE, 0, NOW + 32);
    assert_eq!(v.vault_state().nav_e6.0, nav_before);

    // The owner takes the earmarked LiNEAR to route it to the hedge account.
    let reserved = i.margin_reserved_linear.0;
    set(ALICE, 1, NOW + 33);
    assert!(panic_of(|| {
        v.release_margin_reserve(U128(1));
    })
    .contains("owner only"));
    set(OWNER, 1, NOW + 33);
    assert!(panic_of(|| {
        v.release_margin_reserve(U128(reserved + 1));
    })
    .contains("exceeds"));
    v.release_margin_reserve(U128(reserved));
    assert_eq!(ft_transfers(), vec![(LINEAR.to_string(), OWNER.to_string(), reserved)]);
    set_results(NOW + 34, vec![PromiseResult::Failed]);
    assert!(!v.on_margin_released(U128(reserved)));
    assert_eq!(v.insurance().margin_reserved_linear.0, reserved, "a failed transfer restores it");
}

#[test]
fn insurance_payouts_need_a_fresh_report() {
    let mut v = vault_with_fund();
    report(&mut v, 4, NOW + 30, 20, short_funded(-60 * USD as i128));
    assert!(pay(&mut v, KEEPER, "negative_funding", USD, NOW + 30, NOW + 30 + 901)
        .contains("older than 15 minutes"));
}

#[test]
fn insurance_settings_are_owner_only_and_bounded() {
    let mut v = deploy();
    set(ALICE, 1, NOW);
    assert!(panic_of(|| v.set_insurance(500, 2_000, U128(USD))).contains("owner only"));
    set(OWNER, 1, NOW);
    assert!(panic_of(|| v.set_insurance(5_001, 2_000, U128(USD))).contains("at most 5000"));
    assert!(panic_of(|| v.set_insurance(500, 0, U128(USD))).contains("1 to 10000"));
    assert!(panic_of(|| v.set_insurance(500, 2_000, U128(0))).contains("positive"));
    v.set_insurance(500, 2_000, U128(USD));
    let c = v.config();
    assert_eq!(
        (c.insurance_share_bps, c.insurance_cap_per_day_bps, c.insurance_max_payout_e6.0),
        (500, 2_000, USD)
    );
}

// ---------------------------------------------------------------------------------------------
// Report-carried hedge ratio
// ---------------------------------------------------------------------------------------------

#[test]
fn the_report_sets_the_hedge_ratio_inside_the_bounds() {
    let mut v = deploy();
    register(&mut v, ALICE);
    let big = Hl { value_e6: 100_000 * USD, margin_e6: 100_000 * USD, ..Hl::default() };
    report(&mut v, 1, NOW, 20, big);
    deposit(&mut v, ALICE, 1_200 * NEAR);
    let s = v.hedge_status();
    assert_eq!((s.hedge_ratio_bps, s.hedge_ratio_min_bps, s.hedge_ratio_max_bps), (9_000, 7_000, 9_000));
    assert_eq!(s.hedge_ratio_reason, "the configured hedge ratio");
    assert_eq!(v.config().hedge_ratio_min_bps, 7_000);

    let why = "7-day funding is -8.0% a year: shorts pay, hedge leans to 82% (min 70%)";
    report_with(
        &mut v,
        2,
        NOW + 10,
        20,
        big,
        json!({ "hedge_ratio_bps": 8_200, "hedge_ratio_reason": why, "margin_ratio": 640 }),
    );
    assert_eq!(vault_event("hedge_ratio_set"), json!({ "hedge_ratio_bps": 8_200, "reason": why }));
    let r = v.report.clone().unwrap();
    // 1000 LiNEAR... 1200 NEAR staked; 82% is 984 NEAR.
    assert_eq!(v.hedge_plan(RATE, &r).target_e8, 984 * E8);
    let s = v.hedge_status();
    assert_eq!(
        (s.hedge_ratio_bps, s.hedge_ratio_reason.as_str(), s.margin_ratio_bps),
        (8_200, why, Some(640))
    );

    // Outside the bounds it is brought inside them.
    report_with(&mut v, 3, NOW + 20, 20, big, json!({ "hedge_ratio_bps": 5_000 }));
    assert_eq!(v.hedge_status().hedge_ratio_bps, 7_000);
    report_with(&mut v, 4, NOW + 30, 20, big, json!({ "hedge_ratio_bps": 10_000 }));
    assert_eq!(v.hedge_status().hedge_ratio_bps, 9_000);
    // A report without one goes back to the configured ratio.
    report(&mut v, 5, NOW + 40, 20, big);
    assert_eq!(v.hedge_status().hedge_ratio_bps, 9_000);
    assert_eq!(v.hedge_status().margin_ratio_bps, None);

    let long = "x".repeat(281);
    set(RISK, 0, NOW + 50);
    let mut r: Value = serde_json::from_str(&report_json(6, NOW + 50, 20, big)).unwrap();
    r["hedge_ratio_reason"] = json!(long);
    assert!(panic_of(|| v.on_vault_report(r.to_string())).contains("at most 280"));
}

#[test]
fn hedge_ratio_floor_is_owner_set_within_bounds() {
    let mut v = deploy();
    set(ALICE, 1, NOW);
    assert!(panic_of(|| v.set_hedge_ratio_min(6_000)).contains("owner only"));
    set(OWNER, 1, NOW);
    assert!(panic_of(|| v.set_hedge_ratio_min(9_100)).contains("at most hedge_ratio_bps"));
    assert!(panic_of(|| v.set_hedge_ratio_min(4_000)).contains("5000 to 10000"));
    v.set_hedge_ratio_min(6_000);
    assert!(panic_of(|| v.set_hedge_ratio(5_500)).contains("at least hedge_ratio_min_bps"));
    v.set_hedge_ratio(8_000);
    assert_eq!(v.hedge_status().hedge_ratio_bps, 8_000);
}

// ---------------------------------------------------------------------------------------------
// Claim totals
// ---------------------------------------------------------------------------------------------

#[test]
fn pending_claims_are_totalled_for_the_reserves() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    fund_buffer(&mut v, 10 * USD);
    report(&mut v, 2, NOW + 40, 20, Hl::pnl(60 * USD as i128));
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a));
    report(&mut v, 3, NOW + 70, 20, Hl::pnl(60 * USD as i128));
    process(&mut v, NOW + 71, RATE);
    // 20 USD owed, then the LiNEAR transfer fails.
    set_results(NOW + 72, vec![PromiseResult::Failed]);
    v.on_payout(id(ALICE), "linear".into(), U128(100 * NEAR));
    set(ALICE, 0, NOW + 73);
    let s = v.vault_state();
    assert_eq!((s.claims_linear.0, s.claims_usdc_e6.0), (100 * NEAR, 20 * USD));
    fund_buffer(&mut v, 5 * USD);
    set(ALICE, 0, NOW + 74);
    v.claim();
    let s = v.vault_state();
    assert_eq!((s.claims_linear.0, s.claims_usdc_e6.0), (0, 15 * USD));
}

// ---------------------------------------------------------------------------------------------
// Migration from the deployed layout
// ---------------------------------------------------------------------------------------------

/// Rewrites `v`'s state in the layout deployed before the insurance fund.
fn as_deployed(v: Vault) {
    let mut old = migrate::VaultV1 {
        owner_id: v.owner_id,
        network: v.network,
        risk: v.risk,
        keeper: v.keeper,
        linear: v.linear,
        wnear: v.wnear,
        usdc: v.usdc,
        oracle: v.oracle,
        signer: v.signer,
        hedge: v.hedge,
        deposit_cap: v.deposit_cap,
        min_deposit: v.min_deposit,
        token: v.token,
        staked_linear: v.staked_linear,
        pending_deposit_near: v.pending_deposit_near,
        settled_pnl_e6: v.settled_pnl_e6,
        loss_backing_linear: v.loss_backing_linear,
        buffer_usdc: v.buffer_usdc,
        linear_rate_e24: v.linear_rate_e24,
        first_linear_rate_e24: v.first_linear_rate_e24,
        near_price_e8: v.near_price_e8,
        report: v.report,
        last_run_id: v.last_run_id,
        hedge_order_signed: v.hedge_order_signed,
        last_hedge_nonce: v.last_hedge_nonce,
        manual_paused: v.manual_paused,
        risk_paused: v.risk_paused,
        leverage_reduced: v.leverage_reduced,
        needs_margin: v.needs_margin,
        withdrawals: v.withdrawals,
        withdrawal_head: v.withdrawal_head,
        next_withdrawal_id: v.next_withdrawal_id,
        queued_shares: v.queued_shares,
        claims: v.claims,
    };
    old.withdrawals.flush();
    old.claims.flush();
    near_sdk::env::state_write(&old);
    near_sdk::env::storage_remove(b"layout");
}

#[test]
fn migrate_keeps_every_balance_and_adds_the_fund() {
    let mut v = deploy();
    let a = two_holders(&mut v);
    report(&mut v, 2, NOW + 40, 20, short_funded(5 * USD as i128));
    set(ALICE, 1, NOW + 50);
    v.request_withdraw(U128(a / 2));
    set(BOB, 0, NOW + 60);
    let before = v.vault_state();
    let queue = v.queue(None, None);
    let config = v.config();
    as_deployed(v);

    set(ALICE, 0, NOW + 61);
    assert!(panic_of(|| {
        Vault::migrate();
    })
    .contains("owner only"));
    set(OWNER, 0, NOW + 61);
    let mut v = Vault::migrate();
    let after = v.vault_state();
    assert_eq!(
        (after.total_shares, after.staked_linear, after.nav_e6, after.queued_shares, after.queue_length),
        (before.total_shares, before.staked_linear, before.nav_e6, before.queued_shares, before.queue_length)
    );
    assert_eq!(v.ft_balance_of(id(ALICE)).0, a - a / 2);
    assert_eq!(v.queue(None, None), queue);
    assert_eq!(v.config().hedge, config.hedge);
    assert_eq!(v.config().hedge_ratio_min_bps, 7_000);
    let i = v.insurance();
    assert_eq!((i.linear.0, i.usdc_e6.0, i.share_bps, i.cap_per_day_bps), (0, 0, 1_000, 2_500));
    assert!(v.insurance_history(None, None).is_empty());
    // The rate already seen is the fund's starting mark: nothing from before is skimmed.
    set_results(NOW + 62, vec![rate(RATE)]);
    v.on_withdraw_rate(0);
    assert_eq!(v.insurance().linear.0, 0);

    // The vault keeps working: reports, deposits and the queue.
    near_sdk::env::state_write(&v);
    // The first report after the migration sets the fund's funding mark; the next one's 10 USD
    // of funding puts 1 USD in the fund.
    report(&mut v, 3, NOW + 70, 20, short_funded(15 * USD as i128));
    assert_eq!(v.insurance().usdc_e6.0, 0);
    report(&mut v, 4, NOW + 71, 20, short_funded(25 * USD as i128));
    assert_eq!(v.insurance().usdc_e6.0, USD);
    assert_eq!(process(&mut v, NOW + 72, RATE), 1);
    deposit_at(&mut v, BOB, 10 * NEAR, NOW + 73, PRICE, RATE);

    // It runs once.
    set(OWNER, 0, NOW + 80);
    assert!(panic_of(|| {
        Vault::migrate();
    })
    .contains("already migrated"));
}

#[test]
fn migrate_can_run_from_the_vault_account_in_the_deploy_batch() {
    let mut v = deploy();
    two_holders(&mut v);
    as_deployed(v);
    set(VAULT, 0, NOW + 1);
    let v = Vault::migrate();
    assert_eq!(v.config().owner_id, id(OWNER));
}

#[test]
fn a_new_vault_needs_no_migration() {
    let v = deploy();
    near_sdk::env::state_write(&v);
    set(OWNER, 0, NOW);
    assert!(panic_of(|| {
        Vault::migrate();
    })
    .contains("already migrated"));
}

// ---------------------------------------------------------------------------------------------
// Audit regressions (insurance)
// ---------------------------------------------------------------------------------------------

/// The deployed enclave reports funding since the position opened; the enclave built with the
/// fund reports the coin's lifetime funding. Measured against the report stored before the
/// migration, the first report after it would read the difference as funding received (and skim
/// a tenth of it) or paid (and open negative-funding payouts). The fund takes deltas only between
/// reports it measured itself.
#[test]
fn audit_migration_does_not_read_a_funding_jump_as_yield() {
    let mut v = deploy();
    two_holders(&mut v);
    report(&mut v, 2, NOW + 10, 20, short_funded(0));
    as_deployed(v);
    set(OWNER, 0, NOW + 20);
    let mut v = Vault::migrate();
    report(&mut v, 3, NOW + 30, 20, short_funded(300 * USD as i128));
    assert!(!has_vault_event("insurance_inflow"));
    assert_eq!(v.insurance().usdc_e6.0, 0);
    assert!(v.insurance.funding_window.is_empty());
    // From there on, real deltas count.
    report(&mut v, 4, NOW + 40, 20, short_funded(310 * USD as i128));
    assert_eq!(v.insurance().usdc_e6.0, USD);
}
