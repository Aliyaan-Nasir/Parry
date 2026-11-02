use super::*;
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const T0: u64 = 1_800_000_000;
const NEAR_USD: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const USDC_USD: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn id(hex: &str) -> PriceIdentifier {
    serde_json::from_value(json!(hex)).unwrap()
}

fn ctx(who: &str, secs: u64, yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("oracle.parry.testnet"))
        .predecessor_account_id(account(who))
        .signer_account_id(account(who))
        .block_timestamp(secs * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .build());
}

fn at(who: &str, secs: u64) {
    ctx(who, secs, 0);
}

fn deploy() -> Contract {
    at("owner.testnet", T0);
    Contract::new(account("owner.testnet"), vec![account("keeper.testnet")], "testnet".into(), 2_500)
}

fn update(hex: &str, price: i64, publish_time: i64) -> PriceUpdate {
    PriceUpdate {
        price_id: id(hex),
        price: I64(price),
        conf: U64(price as u64 / 1_000),
        expo: -8,
        publish_time,
    }
}

/// An oracle with NEAR/USD at 3.00 (expo -8) and USDC/USD at 1.00, both published at T0.
fn fed() -> Contract {
    let mut c = deploy();
    at("keeper.testnet", T0);
    c.update_prices(vec![update(NEAR_USD, 300_000_000, T0 as i64), update(USDC_USD, 100_000_000, T0 as i64)]);
    c
}

fn feed_near(c: &mut Contract, price: i64, publish_time: u64) {
    at("keeper.testnet", publish_time);
    c.update_prices(vec![update(NEAR_USD, price, publish_time as i64)]);
}

// ----- Initialisation ----------------------------------------------------------------------

#[test]
#[should_panic(expected = "this oracle runs on testnet only")]
fn new_refuses_mainnet() {
    at("owner.near", T0);
    Contract::new(account("owner.near"), vec![], "mainnet".into(), 2_500);
}

#[test]
#[should_panic(expected = "this oracle runs on testnet only")]
fn new_refuses_any_spelling_but_testnet() {
    at("owner.testnet", T0);
    Contract::new(account("owner.testnet"), vec![], "Testnet".into(), 2_500);
}

#[test]
#[should_panic(expected = "max_shock_bps must be at most 5000")]
fn new_refuses_max_shock_above_5000() {
    at("owner.testnet", T0);
    Contract::new(account("owner.testnet"), vec![], "testnet".into(), 5_001);
}

#[test]
fn new_accepts_max_shock_of_5000() {
    at("owner.testnet", T0);
    let c = Contract::new(account("owner.testnet"), vec![], "testnet".into(), 5_000);
    assert_eq!(c.status().max_shock_bps, 5_000);
}

// ----- Wire format -------------------------------------------------------------------------

#[test]
fn price_serializes_exactly_like_pyth() {
    let price = Price { price: I64(-12_345), conf: U64(678), expo: -8, publish_time: 1_700_000_000 };
    assert_eq!(
        serde_json::to_string(&price).unwrap(),
        r#"{"price":"-12345","conf":"678","expo":-8,"publish_time":1700000000}"#
    );
    let back: Price =
        serde_json::from_str(r#"{"price":"300000000","conf":"300000","expo":-8,"publish_time":1800000000}"#)
            .unwrap();
    assert_eq!(back.price, I64(300_000_000));
}

#[test]
fn view_results_serialize_like_pyth() {
    let c = fed();
    at("reader.testnet", T0 + 1);
    let got = serde_json::to_string(&c.get_price_no_older_than(id(NEAR_USD), 60)).unwrap();
    assert_eq!(got, r#"{"price":"300000000","conf":"300000","expo":-8,"publish_time":1800000000}"#);
    let missing = id(&"00".repeat(32));
    assert_eq!(serde_json::to_string(&c.get_price_no_older_than(missing, 60)).unwrap(), "null");
}

#[test]
fn price_identifier_is_64_hex_chars() {
    let lower = id(NEAR_USD);
    assert_eq!(serde_json::to_string(&lower).unwrap(), format!("\"{NEAR_USD}\""));
    // Either case is read (as the Pyth contract does), lowercase is always written.
    let upper = id(&NEAR_USD.to_uppercase());
    assert_eq!(upper, lower);
    assert_eq!(upper.to_string(), NEAR_USD);
    for bad in [&NEAR_USD[2..], &format!("0x{}", &NEAR_USD[2..]), &format!("{NEAR_USD}00"), &"zz".repeat(32)]
    {
        assert!(serde_json::from_value::<PriceIdentifier>(json!(bad)).is_err(), "{bad}");
    }
}

#[test]
fn list_prices_is_a_map_keyed_by_hex_id() {
    let c = fed();
    at("reader.testnet", T0 + 1);
    let unknown = "11".repeat(32);
    let map = c.list_prices(vec![id(NEAR_USD), id(&unknown)]);
    let value = serde_json::to_value(&map).unwrap();
    assert_eq!(
        value,
        json!({
            NEAR_USD: { "price": "300000000", "conf": "300000", "expo": -8, "publish_time": T0 },
            unknown: null,
        })
    );
}

// ----- Feeding -------------------------------------------------------------------------------

#[test]
fn feeder_update_is_served_by_every_view() {
    let c = fed();
    at("reader.testnet", T0 + 10);
    let expected = Price { price: I64(300_000_000), conf: U64(300_000), expo: -8, publish_time: T0 as i64 };
    assert_eq!(c.get_price(id(NEAR_USD)), Some(expected));
    assert_eq!(c.get_price_unsafe(id(NEAR_USD)), Some(expected));
    assert_eq!(c.get_price_no_older_than(id(NEAR_USD), 10), Some(expected));
    assert_eq!(c.get_ema_price(id(NEAR_USD)), Some(expected));
    assert_eq!(c.get_ema_price_unsafe(id(NEAR_USD)), Some(expected));
    assert_eq!(c.get_ema_price_no_older_than(id(NEAR_USD), 10), Some(expected));
    assert!(c.price_feed_exists(id(NEAR_USD)));
    assert!(!c.price_feed_exists(id(&"22".repeat(32))));
    assert_eq!(c.get_price_unsafe(id(&"22".repeat(32))), None);
}

#[test]
fn update_emits_one_price_updated_event_with_the_list() {
    let mut c = deploy();
    at("keeper.testnet", T0);
    c.update_prices(vec![update(NEAR_USD, 300_000_000, T0 as i64), update(USDC_USD, 100_000_000, T0 as i64)]);
    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    let event: serde_json::Value =
        serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(
        event,
        json!({
            "standard": "parry-oracle",
            "version": "1.0.0",
            "event": "price_updated",
            "data": [
                { "price_id": NEAR_USD, "price": "300000000", "conf": "300000", "expo": -8, "publish_time": T0 },
                { "price_id": USDC_USD, "price": "100000000", "conf": "100000", "expo": -8, "publish_time": T0 },
            ],
        })
    );
}

#[test]
#[should_panic(expected = "feeders only")]
fn non_feeder_update_is_refused() {
    let mut c = deploy();
    at("mallory.testnet", T0);
    c.update_prices(vec![update(NEAR_USD, 300_000_000, T0 as i64)]);
}

#[test]
#[should_panic(expected = "is not newer than the stored")]
fn same_publish_time_is_refused() {
    let mut c = fed();
    feed_near(&mut c, 310_000_000, T0);
}

#[test]
#[should_panic(expected = "is not newer than the stored")]
fn older_publish_time_is_refused() {
    let mut c = fed();
    feed_near(&mut c, 310_000_000, T0 - 1);
}

#[test]
fn newer_publish_time_replaces_the_price() {
    let mut c = fed();
    feed_near(&mut c, 310_000_000, T0 + 1);
    assert_eq!(c.get_price_unsafe(id(NEAR_USD)).unwrap().price, I64(310_000_000));
}

#[test]
fn publish_time_up_to_60_s_ahead_is_accepted() {
    let mut c = fed();
    at("keeper.testnet", T0 + 5);
    c.update_prices(vec![update(NEAR_USD, 310_000_000, (T0 + 65) as i64)]);
    // A publish time ahead of the block counts as fresh.
    assert!(c.get_price_no_older_than(id(NEAR_USD), 0).is_some());
}

#[test]
#[should_panic(expected = "publish_time is more than 60 s in the future")]
fn publish_time_more_than_60_s_ahead_is_refused() {
    let mut c = fed();
    at("keeper.testnet", T0 + 5);
    c.update_prices(vec![update(NEAR_USD, 310_000_000, (T0 + 66) as i64)]);
}

#[test]
#[should_panic(expected = "price must be positive")]
fn zero_price_is_refused() {
    let mut c = fed();
    feed_near(&mut c, 0, T0 + 1);
}

#[test]
#[should_panic(expected = "price must be positive")]
fn negative_price_is_refused() {
    let mut c = fed();
    feed_near(&mut c, -1, T0 + 1);
}

#[test]
#[should_panic(expected = "expo -6 differs from the feed's -8")]
fn expo_change_is_refused() {
    let mut c = fed();
    at("keeper.testnet", T0 + 1);
    let mut u = update(NEAR_USD, 3_000_000, (T0 + 1) as i64);
    u.expo = -6;
    c.update_prices(vec![u]);
}

#[test]
#[should_panic(expected = "is not newer than the stored")]
fn one_bad_update_refuses_the_whole_batch() {
    let mut c = fed();
    at("keeper.testnet", T0 + 1);
    c.update_prices(vec![update(USDC_USD, 100_000_001, (T0 + 1) as i64), update(NEAR_USD, 1, T0 as i64)]);
}

#[test]
#[should_panic(expected = "at most 64 updates per call")]
fn oversized_batch_is_refused() {
    let mut c = deploy();
    at("keeper.testnet", T0);
    c.update_prices((0..65).map(|i| update(NEAR_USD, 1, i + 1)).collect());
}

#[test]
#[should_panic(expected = "no updates")]
fn empty_batch_is_refused() {
    let mut c = deploy();
    at("keeper.testnet", T0);
    c.update_prices(vec![]);
}

// ----- Staleness ------------------------------------------------------------------------------

#[test]
fn no_older_than_boundary_is_inclusive() {
    let c = fed();
    at("reader.testnet", T0 + 30);
    assert!(c.get_price_no_older_than(id(NEAR_USD), 30).is_some());
    assert!(c.get_price_no_older_than(id(NEAR_USD), 29).is_none());
    assert!(c.get_ema_price_no_older_than(id(NEAR_USD), 30).is_some());
    assert!(c.get_ema_price_no_older_than(id(NEAR_USD), 29).is_none());
    // `unsafe` ignores age.
    assert!(c.get_price_unsafe(id(NEAR_USD)).is_some());
}

#[test]
fn get_price_uses_a_60_s_max_age() {
    let c = fed();
    at("reader.testnet", T0 + 60);
    assert!(c.get_price(id(NEAR_USD)).is_some());
    assert!(c.get_ema_price(id(NEAR_USD)).is_some());
    assert!(c.list_prices(vec![id(NEAR_USD)])[&id(NEAR_USD)].is_some());
    at("reader.testnet", T0 + 61);
    assert!(c.get_price(id(NEAR_USD)).is_none());
    assert!(c.get_ema_price(id(NEAR_USD)).is_none());
    assert!(c.list_prices(vec![id(NEAR_USD)])[&id(NEAR_USD)].is_none());
    assert!(c.get_price_unsafe(id(NEAR_USD)).is_some());
}

// ----- Shock ----------------------------------------------------------------------------------

#[test]
fn shock_moves_the_price_and_keeps_the_fed_publish_time() {
    let mut c = fed();
    at("tester.testnet", T0 + 5);
    let view = c.shock(id(NEAR_USD), -2_000);
    assert_eq!(
        view,
        ShockView {
            bps: -2_000,
            by: account("tester.testnet"),
            at: T0 + 5,
            expires_at: T0 + 5 + SHOCK_DURATION_SECS,
            shocked_price: I64(240_000_000),
            fed_price: I64(300_000_000),
        }
    );
    let price = c.get_price(id(NEAR_USD)).unwrap();
    assert_eq!(
        price,
        Price { price: I64(240_000_000), conf: U64(300_000), expo: -8, publish_time: T0 as i64 }
    );
    assert_eq!(c.get_price_no_older_than(id(NEAR_USD), 60).unwrap().price, I64(240_000_000));
    assert_eq!(c.get_ema_price_unsafe(id(NEAR_USD)).unwrap().price, I64(240_000_000));
    // Other feeds are untouched.
    assert_eq!(c.get_price(id(USDC_USD)).unwrap().price, I64(100_000_000));
    assert_eq!(c.shock_of(id(NEAR_USD)), Some(view));
    assert_eq!(c.shock_of(id(USDC_USD)), None);

    let logs = get_logs();
    let event: serde_json::Value =
        serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(
        event,
        json!({
            "standard": "parry-oracle",
            "version": "1.0.0",
            "event": "shock_applied",
            "data": {
                "price_id": NEAR_USD,
                "bps": -2000,
                "by": "tester.testnet",
                "at": T0 + 5,
                "expires_at": T0 + 5 + SHOCK_DURATION_SECS,
                "fed_price": "300000000",
                "shocked_price": "240000000",
            },
        })
    );
}

#[test]
fn shock_never_makes_a_price_stale_and_staleness_still_applies() {
    let mut c = fed();
    at("tester.testnet", T0 + 50);
    c.shock(id(NEAR_USD), 1_000);
    assert!(c.get_price(id(NEAR_USD)).is_some());
    // Without new feeds the shocked price goes stale like the fed one would.
    at("reader.testnet", T0 + 61);
    assert!(c.get_price(id(NEAR_USD)).is_none());
}

#[test]
fn shock_follows_the_fed_price() {
    let mut c = fed();
    at("tester.testnet", T0 + 1);
    c.shock(id(NEAR_USD), -2_000);
    feed_near(&mut c, 320_000_000, T0 + 2);
    assert_eq!(c.get_price(id(NEAR_USD)).unwrap().price, I64(256_000_000));
    let view = c.shock_of(id(NEAR_USD)).unwrap();
    assert_eq!((view.fed_price, view.shocked_price), (I64(320_000_000), I64(256_000_000)));
}

#[test]
fn shock_at_the_bound_is_accepted_both_ways() {
    let mut c = fed();
    at("a.testnet", T0);
    assert_eq!(c.shock(id(NEAR_USD), 2_500).shocked_price, I64(375_000_000));
    at("b.testnet", T0 + 10);
    assert_eq!(c.shock(id(NEAR_USD), -2_500).shocked_price, I64(225_000_000));
}

#[test]
#[should_panic(expected = "|bps| must be at most 2500")]
fn shock_above_the_bound_is_refused() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), 2_501);
}

#[test]
#[should_panic(expected = "|bps| must be at most 2500")]
fn shock_below_the_bound_is_refused() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_501);
}

#[test]
#[should_panic(expected = "bps must not be zero")]
fn zero_shock_is_refused() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), 0);
}

#[test]
#[should_panic(expected = "unknown price id")]
fn shock_on_unknown_feed_is_refused() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(&"33".repeat(32)), 100);
}

#[test]
fn shocked_price_stays_positive_and_does_not_wrap() {
    assert_eq!(shocked_price(1, -5_000), 1);
    assert_eq!(shocked_price(3, -5_000), 1);
    assert_eq!(shocked_price(10_000, 1), 10_001);
    assert_eq!(shocked_price(i64::MAX, 5_000), i64::MAX);
}

#[test]
#[should_panic(expected = "one shock per account per 60 s")]
fn caller_is_limited_to_one_shock_per_60_s_across_feeds() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), 100);
    at("a.testnet", T0 + 59);
    c.shock(id(USDC_USD), 100);
}

#[test]
fn caller_may_shock_again_after_60_s() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), 100);
    at("a.testnet", T0 + 60);
    c.shock(id(USDC_USD), 100);
    assert!(c.shock_of(id(USDC_USD)).is_some());
}

#[test]
#[should_panic(expected = "one shock per price id per 10 s")]
fn feed_is_limited_to_one_shock_per_10_s_across_callers() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), 100);
    at("b.testnet", T0 + 9);
    c.shock(id(NEAR_USD), 200);
}

#[test]
fn new_shock_replaces_the_active_one_without_compounding() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    at("b.testnet", T0 + 10);
    let view = c.shock_of(id(NEAR_USD)).unwrap();
    assert_eq!(view.by, account("a.testnet"));
    let replaced = c.shock(id(NEAR_USD), -2_000);
    // -20% of the fed 3.00, not of the shocked 2.40.
    assert_eq!(replaced.shocked_price, I64(240_000_000));
    assert_eq!(replaced.by, account("b.testnet"));
    assert_eq!(replaced.expires_at, T0 + 10 + SHOCK_DURATION_SECS);
}

#[test]
fn shock_expires_after_30_minutes() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    feed_near(&mut c, 300_000_000, T0 + SHOCK_DURATION_SECS - 1);
    assert_eq!(c.get_price(id(NEAR_USD)).unwrap().price, I64(240_000_000));
    feed_near(&mut c, 300_000_000, T0 + SHOCK_DURATION_SECS);
    assert_eq!(c.get_price(id(NEAR_USD)).unwrap().price, I64(300_000_000));
    assert_eq!(c.shock_of(id(NEAR_USD)), None);
}

#[test]
fn applier_can_reset_its_shock() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    at("a.testnet", T0 + 1);
    c.reset_shock(id(NEAR_USD));
    assert_eq!(c.get_price(id(NEAR_USD)).unwrap().price, I64(300_000_000));
    assert_eq!(c.shock_of(id(NEAR_USD)), None);
    let event: serde_json::Value =
        serde_json::from_str(get_logs()[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(
        event,
        json!({
            "standard": "parry-oracle",
            "version": "1.0.0",
            "event": "shock_reset",
            "data": { "price_id": NEAR_USD, "by": "a.testnet", "expired": false },
        })
    );
}

#[test]
fn owner_can_reset_any_shock() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    at("owner.testnet", T0 + 1);
    c.reset_shock(id(NEAR_USD));
    assert_eq!(c.shock_of(id(NEAR_USD)), None);
}

#[test]
#[should_panic(expected = "only the account that applied the shock or the owner")]
fn stranger_cannot_reset_an_active_shock() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    at("b.testnet", T0 + SHOCK_DURATION_SECS - 1);
    c.reset_shock(id(NEAR_USD));
}

#[test]
fn anyone_can_clear_an_expired_shock() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    at("b.testnet", T0 + SHOCK_DURATION_SECS);
    c.reset_shock(id(NEAR_USD));
    assert!(get_logs()[0].contains("\"expired\":true"));
}

#[test]
#[should_panic(expected = "no shock")]
fn reset_without_a_shock_is_refused() {
    let mut c = fed();
    at("owner.testnet", T0);
    c.reset_shock(id(NEAR_USD));
}

#[test]
#[should_panic(expected = "one shock per price id per 10 s")]
fn reset_does_not_skip_the_feed_rate_limit() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    c.reset_shock(id(NEAR_USD));
    at("b.testnet", T0 + 5);
    c.shock(id(NEAR_USD), -2_000);
}

#[test]
fn rate_limit_window_prunes_itself() {
    let mut c = fed();
    for i in 0..5u64 {
        at(&format!("caller{i}.testnet"), T0 + i * 10);
        c.shock(id(NEAR_USD), 100);
    }
    assert_eq!(c.recent_shocks.get().len(), 5);
    // One second before the shock at T0 + 40 leaves the window: it stays, the four older go.
    at("late.testnet", T0 + 40 + CALLER_SHOCK_INTERVAL_SECS - 1);
    c.shock(id(NEAR_USD), 100);
    assert_eq!(c.recent_shocks.get().len(), 1 + 1);
}

#[test]
fn lowered_bound_applies_to_new_shocks_only() {
    let mut c = fed();
    at("a.testnet", T0);
    c.shock(id(NEAR_USD), -2_000);
    ctx("owner.testnet", T0 + 1, 1);
    c.set_max_shock_bps(1_000);
    at("reader.testnet", T0 + 2);
    assert_eq!(c.get_price(id(NEAR_USD)).unwrap().price, I64(240_000_000));
    assert_eq!(c.status().max_shock_bps, 1_000);
}

// ----- Owner -----------------------------------------------------------------------------------

#[test]
fn owner_manages_feeders() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.add_feeder(account("keeper2.testnet"));
    at("keeper2.testnet", T0);
    c.update_prices(vec![update(NEAR_USD, 300_000_000, T0 as i64)]);
    ctx("owner.testnet", T0 + 1, 1);
    c.remove_feeder(account("keeper.testnet"));
    assert_eq!(c.status().feeders, vec![account("keeper2.testnet")]);
}

#[test]
#[should_panic(expected = "feeders only")]
fn removed_feeder_cannot_update() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.remove_feeder(account("keeper.testnet"));
    at("keeper.testnet", T0);
    c.update_prices(vec![update(NEAR_USD, 300_000_000, T0 as i64)]);
}

#[test]
#[should_panic(expected = "owner only")]
fn non_owner_cannot_add_feeder() {
    let mut c = deploy();
    ctx("mallory.testnet", T0, 1);
    c.add_feeder(account("mallory.testnet"));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_call_needs_one_yocto() {
    let mut c = deploy();
    at("owner.testnet", T0);
    c.set_max_shock_bps(100);
}

#[test]
#[should_panic(expected = "max_shock_bps must be at most 5000")]
fn owner_cannot_raise_the_bound_above_5000() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.set_max_shock_bps(5_001);
}

#[test]
#[should_panic(expected = "already a feeder")]
fn adding_an_existing_feeder_is_refused() {
    let mut c = deploy();
    ctx("owner.testnet", T0, 1);
    c.add_feeder(account("keeper.testnet"));
}

#[test]
fn status_reports_configuration_and_feed_times() {
    let mut c = fed();
    feed_near(&mut c, 301_000_000, T0 + 7);
    let status = serde_json::to_value(c.status()).unwrap();
    assert_eq!(
        status,
        json!({
            "owner_id": "owner.testnet",
            "feeders": ["keeper.testnet"],
            "network": "testnet",
            "max_shock_bps": 2500,
            "feeds": [
                { "price_id": NEAR_USD, "publish_time": T0 + 7 },
                { "price_id": USDC_USD, "publish_time": T0 },
            ],
        })
    );
}
