//! Parry Earn, the delta-neutral vault, on a local sandbox node: the real LiNEAR and wNEAR code
//! from testnet, Parry's oracle, risk board and test USDC, and the stand-in MPC signer. Every
//! report reaches the vault as on testnet: signed by the enclave key, verified by the risk board
//! and forwarded by it to the vault.
//!
//! LiNEAR runs with no validators here. Its `deposit_and_stake` still mints LiNEAR at `ft_price`
//! and keeps the NEAR as stake to settle in the next epoch, so the vault stakes for real while
//! the rate stays at exactly 1 NEAR per LiNEAR (no staking rewards accrue in a sandbox).
//!
//! Run `contracts/scripts/build.sh` and `contracts/scripts/fetch-fixtures.sh` first.

mod common;

use anyhow::Result;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::{Account, AccountId, Contract};
use parry_common::hyperliquid::{order_digest, HlOrder};
use parry_common::math::{checked_mul_div, Rounding};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// LiNEAR's `ft_price` while no staking rewards have accrued: 1 NEAR per LiNEAR, scaled 1e24.
const RATE_E24: u128 = NEAR;
/// NEAR at 3.00 USD, scaled 1e8: the oracle feed and the default hedge mark.
const PRICE_E8: u128 = 300_000_000;
/// Operator margin in the hedge account, USD e6 (the test USDC unit is also 1e6).
const MARGIN_E6: u128 = 1_000 * USDC;
const HEDGE_PATH: &str = "parry-vault-hedge";
const HEDGE_RATIO_BPS: u128 = 9_000;
/// yoctoNEAR × price_e8 / this = USD e6.
const YOCTO_PRICE_TO_USD_E6: u128 = 100_000_000_000_000_000_000_000_000;
/// Share units per USD e6 for the first deposit: one share (1e24) per USD.
const FIRST_SHARES_PER_USD_E6: u128 = 1_000_000_000_000_000_000;
/// yoctoNEAR per Hyperliquid size unit (1e24 / 1e8).
const YOCTO_PER_E8: u128 = 10_000_000_000_000_000;

/// The hedge account as a vault report describes it.
#[derive(Clone, Copy)]
struct Hedge {
    /// Position size, 1e8; negative is short.
    size_e8: i128,
    /// Account value, USD e6.
    value_e6: u128,
    /// Operator margin, USD e6 (reported as `margin_baseline_e6`).
    margin_e6: u128,
    mark_e8: u128,
    funding_e6: i128,
}

impl Hedge {
    /// No position, and an account holding exactly the operator margin.
    fn flat() -> Self {
        Hedge { size_e8: 0, value_e6: MARGIN_E6, margin_e6: MARGIN_E6, mark_e8: PRICE_E8, funding_e6: 0 }
    }

    /// The account value `pnl_e6` above (or below) the operator margin.
    fn pnl(pnl_e6: i128) -> Self {
        Hedge { value_e6: (MARGIN_E6 as i128 + pnl_e6) as u128, ..Hedge::flat() }
    }

    fn short(self, size_e8: u128) -> Self {
        Hedge { size_e8: -(size_e8 as i128), ..self }
    }

    fn mark(self, mark_e8: u128) -> Self {
        Hedge { mark_e8, ..self }
    }
}

/// The proof-of-reserves summary of a vault report.
struct Reserves {
    root: String,
    leaves: u32,
    total_e6: u128,
    liabilities_e6: u128,
    ratio_bps: u32,
}

impl Default for Reserves {
    fn default() -> Self {
        Reserves {
            root: "ab".repeat(32),
            leaves: 12,
            total_e6: 5_000 * USDC,
            liabilities_e6: 4_800 * USDC,
            ratio_bps: 10_416,
        }
    }
}

/// The shared stack plus LiNEAR and the vault, wired as on testnet: the risk board forwards
/// vault reports to the vault, and the vault is registered with wNEAR and test USDC.
struct Earn {
    s: Stack,
    linear: Contract,
    vault: Contract,
}

impl Earn {
    async fn new() -> Result<Self> {
        Self::with_codes(Stack::new().await?, &wasm("parry_vault")).await
    }

    /// The stack `s` with LiNEAR and a vault running `vault_code`.
    async fn with_codes(s: Stack, vault_code: &[u8]) -> Result<Self> {
        let linear = s.user("linear", 30).await?.deploy(&fixture("linear")).await?.into_result()?;
        ok(linear.call("new").args_json(json!({ "owner_id": s.root.id() })).transact().await?)?;

        let vault = s.user("vault", 30).await?.deploy(vault_code).await?.into_result()?;
        ok(vault
            .call("new")
            .args_json(json!({
                "owner_id": s.root.id(),
                "network": "testnet",
                "risk": s.risk.id(),
                "keeper": s.root.id(),
                "linear": linear.id(),
                "wnear": s.wrap.id(),
                "usdc": s.usdc.id(),
                "oracle": s.oracle.id(),
                "signer": s.signer.id(),
                "hedge": {
                    "asset": "NEAR", "asset_index": 54, "sz_decimals": 1, "hedge_ratio_bps": HEDGE_RATIO_BPS,
                    "max_leverage_x100": 300, "band_bps": 200,
                },
                "deposit_cap": (10_000 * NEAR).to_string(),
                "min_deposit": NEAR.to_string(),
            }))
            .transact()
            .await?)?;
        call(&s.root, s.risk.id(), "set_vault", json!({ "account_id": vault.id() }), 1, 30).await?;
        for token in [s.wrap.id(), s.usdc.id()] {
            register(&s.root, token, vault.id()).await?;
        }
        Ok(Earn { s, linear, vault })
    }

    fn report(&self, vault: &AccountId, score: u8, h: Hedge, r: &Reserves) -> Value {
        json!({
            "kind": "vault_report",
            "vault": vault,
            "score": score,
            "components": {
                "liquidation_bps": 1200, "margin_bps": 800, "funding_bps": 500,
                "oracle_bps": 300, "rate_bps": 200, "reserves_bps": 500,
            },
            "hedge": {
                "asset_index": 54,
                "size_e8": h.size_e8.to_string(),
                "entry_e8": PRICE_E8.to_string(),
                "account_value_e6": h.value_e6.to_string(),
                "unrealized_e6": (h.value_e6 as i128 - h.margin_e6 as i128 - h.funding_e6).to_string(),
                "funding_e6": h.funding_e6.to_string(),
                "margin_baseline_e6": h.margin_e6.to_string(),
                "mark_e8": h.mark_e8.to_string(),
                "liquidation_e8": (h.mark_e8 * 2).to_string(),
            },
            "reserves": {
                "root": r.root,
                "leaves": r.leaves,
                "total_usd_e6": r.total_e6.to_string(),
                "liabilities_usd_e6": r.liabilities_e6.to_string(),
                "ratio_bps": r.ratio_bps,
            },
        })
    }

    /// Signs a vault report with the enclave key and submits it to the risk board, and checks
    /// that the board forwarded it and the vault applied it. Returns the whole transaction.
    async fn submit(&self, score: u8, h: Hedge) -> Result<Done> {
        self.submit_with(score, h, &Reserves::default()).await
    }

    async fn submit_with(&self, score: u8, h: Hedge, r: &Reserves) -> Result<Done> {
        self.submit_report(score, self.report(self.vault.id(), score, h, r)).await
    }

    /// A report with extra top-level fields (the hedge ratio, its reason, the margin ratio).
    async fn submit_extra(&self, score: u8, h: Hedge, extra: Value) -> Result<Done> {
        let mut report = self.report(self.vault.id(), score, h, &Reserves::default());
        for (k, v) in extra.as_object().unwrap() {
            report[k] = v.clone();
        }
        self.submit_report(score, report).await
    }

    async fn submit_report(&self, score: u8, report: Value) -> Result<Done> {
        let d = self.s.submit_report(report).await?;
        let forwarded = events_from(&d, self.s.risk.id(), "vault_reported");
        assert_eq!(forwarded.len(), 1);
        assert_eq!(forwarded[0]["forwarded"], true);
        let applied = events_from(&d, self.vault.id(), "report_applied");
        assert_eq!(applied.len(), 1, "the vault applies the forwarded report: {:?}", d.logs());
        assert_eq!(applied[0]["score"], score);
        assert_eq!(applied[0]["run_id"], self.s.run_id.get());
        Ok(d)
    }

    /// A NEAR deposit with gas for the whole flow (pricing, stake, mint).
    async fn deposit(&self, who: &Account, amount: u128) -> Result<ExecutionFinalResult> {
        try_call(who, self.vault.id(), "deposit", json!({}), amount, 300).await
    }

    /// A NEAR deposit that must mint shares; returns the transaction and the shares minted.
    async fn deposit_ok(&self, who: &Account, amount: u128) -> Result<(Done, u128)> {
        let d = ok(self.deposit(who, amount).await?)?;
        assert!(d.0.receipt_failures().is_empty(), "no receipt of a deposit fails");
        let shares = num(&d.json::<Value>()?);
        assert!(shares > 0, "the deposit minted shares: {:?}", d.logs());
        Ok((d, shares))
    }

    async fn rebalance(&self) -> Result<ExecutionFinalResult> {
        try_call(&self.s.root, self.vault.id(), "rebalance", json!({}), 0, 300).await
    }

    async fn process(&self) -> Result<Done> {
        call(&self.s.root, self.vault.id(), "process_withdrawals", json!({ "max": 4 }), 0, 300).await
    }

    /// The owner tops up the settlement buffer with test USDC.
    async fn fund_buffer(&self, amount: u128) -> Result<Done> {
        call(
            &self.s.root,
            self.s.usdc.id(),
            "ft_transfer_call",
            json!({ "receiver_id": self.vault.id(), "amount": amount.to_string(), "msg": "buffer" }),
            1,
            100,
        )
        .await
    }

    async fn view(&self, method: &str, args: Value) -> Result<Value> {
        view(&self.s.worker, self.vault.id(), method, args).await
    }

    async fn state(&self) -> Result<Value> {
        self.view("vault_state", json!({})).await
    }

    async fn shares_of(&self, who: &AccountId) -> Result<u128> {
        balance(self, self.vault.id(), who).await
    }

    async fn linear_of(&self, who: &AccountId) -> Result<u128> {
        balance(self, self.linear.id(), who).await
    }

    async fn usdc_of(&self, who: &AccountId) -> Result<u128> {
        balance(self, self.s.usdc.id(), who).await
    }

    /// NEAR one EARN registration costs, which a first deposit pays out of its amount.
    async fn storage_cost(&self) -> Result<u128> {
        Ok(num(&self.view("storage_balance_bounds", json!({})).await?["min"]))
    }

    /// Feeds NEAR at 3.00 USD now, so a deposit made within two minutes can be priced.
    async fn feed(&self) -> Result<()> {
        self.s.feed(PRICE_E8 as i64).await
    }

    /// (caller, path, payload) of every request the mock signer received.
    async fn sign_requests(&self) -> Result<Vec<(String, String, String)>> {
        view(&self.s.worker, self.s.signer.id(), "requests", json!({})).await
    }
}

async fn balance(e: &Earn, token: &AccountId, who: &AccountId) -> Result<u128> {
    Ok(num(&view::<Value>(&e.s.worker, token, "ft_balance_of", json!({ "account_id": who })).await?))
}

async fn register(from: &Account, token: &AccountId, who: &AccountId) -> Result<()> {
    call(
        from,
        token,
        "storage_deposit",
        json!({ "account_id": who, "registration_only": true }),
        NEAR / 50,
        30,
    )
    .await?;
    Ok(())
}

/// A JSON decimal string as u128.
fn num(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("not a decimal string: {v}")).parse().unwrap()
}

/// A JSON decimal string as i128.
fn signed(v: &Value) -> i128 {
    v.as_str().unwrap_or_else(|| panic!("not a decimal string: {v}")).parse().unwrap()
}

fn mul_div(a: u128, b: u128, c: u128, rounding: Rounding) -> u128 {
    checked_mul_div(a, b, c, rounding).expect("test amounts stay in range")
}

/// USD e6 that `near` yoctoNEAR is worth at `price_e8`.
fn usd_e6(near: u128, price_e8: u128, rounding: Rounding) -> u128 {
    mul_div(near, price_e8, YOCTO_PRICE_TO_USD_E6, rounding)
}

/// `v` (scaled 1e8) as Hyperliquid's decimal string without trailing zeros.
fn decimal_e8(v: u128) -> String {
    let (whole, frac) = (v / 100_000_000, v % 100_000_000);
    if frac == 0 {
        return whole.to_string();
    }
    format!("{whole}.{}", format!("{frac:08}").trim_end_matches('0'))
}

/// NEP-297 events named `name` that `contract` itself logged in the transaction (several
/// contracts here emit `nep141` events of the same name).
fn events_from(d: &Done, contract: &AccountId, name: &str) -> Vec<Value> {
    d.0.receipt_outcomes()
        .iter()
        .filter(|o| &o.executor_id == contract)
        .flat_map(|o| o.logs.iter())
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|e| e["event"] == name)
        .map(|e| e["data"].clone())
        .collect()
}

/// The single event named `name` that `contract` logged.
fn event_from(d: &Done, contract: &AccountId, name: &str) -> Value {
    let mut all = events_from(d, contract, name);
    assert_eq!(all.len(), 1, "exactly one {name} event from {contract}: {:?}", d.logs());
    all.pop().unwrap()
}

/// (token, amount) of every payout the vault recorded as failed, sorted.
fn failed_payouts(d: &Done, vault: &AccountId) -> Vec<(String, u128)> {
    let mut all: Vec<(String, u128)> = events_from(d, vault, "payout_failed")
        .iter()
        .map(|f| (f["token"].as_str().unwrap().to_string(), num(&f["amount"])))
        .collect();
    all.sort();
    all
}

/// Blocks until the host clock is past `secs`, so the next report is observed after it (the
/// sandbox stamps blocks with the same clock).
fn wait_past(secs: u64) {
    while now_secs() <= secs {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Scenario 1, deposits. Before any report the vault refuses deposits (and the runtime returns
/// the NEAR). After a signed report with a mark close to the oracle price, a NEAR deposit is
/// priced at the oracle, staked into LiNEAR, and mints EARN at 1 USD per share; a second deposit
/// after a report with positive hedge equity is priced against the NAV, which now includes it.
#[tokio::test]
async fn deposits_need_a_report_then_stake_into_linear_and_mint_at_nav() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    let alice = s.user("alice", 300).await?;
    let bob = s.user("bob", 300).await?;
    let cost = e.storage_cost().await?;
    e.feed().await?;

    // No report yet: refused before the vault takes anything.
    let before = alice.view_account().await?.balance.as_yoctonear();
    let refused = err(e.deposit(&alice, 10 * NEAR).await?);
    assert!(refused.contains("the latest vault report is older than 15 minutes"), "{refused}");
    let spent = before - alice.view_account().await?.balance.as_yoctonear();
    assert!(spent < NEAR / 2, "only gas was spent, the 10 NEAR came back: {spent}");
    assert_eq!(e.state().await?["total_shares"], "0");

    // A signed report, its mark 3.01 within 2% of the oracle's 3.00.
    e.submit(10, Hedge::flat().mark(301_000_000)).await?;
    let state = e.state().await?;
    assert_eq!(
        (state["risk_score"].as_u64(), state["near_price_e8"].as_str()),
        (Some(10), Some("301000000"))
    );

    let (d, shares) = e.deposit_ok(&alice, 100 * NEAR).await?;
    let net = 100 * NEAR - cost;
    let started = event_from(&d, vault, "deposit_started");
    assert_eq!(started["account"], alice.id().as_str());
    assert_eq!((num(&started["amount"]), num(&started["storage"])), (net, cost));
    assert_eq!(started["source"], "near");
    let priced = event_from(&d, vault, "deposit_priced");
    assert_eq!((num(&priced["price_e8"]), num(&priced["linear_rate_e24"])), (PRICE_E8, RATE_E24));
    // The first deposit mints one share (1e24 units) per USD: net × 3.00.
    let value = usd_e6(net, PRICE_E8, Rounding::Down);
    assert_eq!(shares, value * FIRST_SHARES_PER_USD_E6);
    assert_eq!(num(&priced["shares"]), shares);
    let staked = event_from(&d, vault, "deposit_staked");
    assert_eq!((num(&staked["linear"]), num(&staked["shares"])), (net, shares));
    let mint = event_from(&d, vault, "ft_mint");
    assert_eq!((mint[0]["owner_id"].as_str(), num(&mint[0]["amount"])), (Some(alice.id().as_str()), shares));
    // LiNEAR minted the stake to the vault at 1:1.
    let staked_by_linear = event_from(&d, e.linear.id(), "stake");
    assert_eq!(staked_by_linear[0]["account_id"], vault.as_str());
    assert_eq!(num(&staked_by_linear[0]["staked_amount"]), net);
    assert_eq!(e.linear_of(vault).await?, net);
    assert_eq!(e.shares_of(alice.id()).await?, shares);

    let state = e.state().await?;
    assert_eq!(num(&state["staked_linear"]), net);
    assert_eq!(num(&state["total_shares"]), shares);
    assert_eq!(num(&state["nav_e6"]), value);
    assert_eq!(num(&state["share_price_e6"]), 1_000_000);
    assert_eq!(num(&state["pending_deposit_near"]), 0);
    assert_eq!(num(&e.view("share_price", json!({})).await?), 1_000_000);

    // The hedge is up 15 USD: the share price rises, so Bob's deposit buys fewer shares.
    e.submit(10, Hedge::pnl(15 * USDC as i128)).await?;
    e.feed().await?;
    let nav_up = usd_e6(net, PRICE_E8, Rounding::Up) + 15 * USDC;
    let (d, bob_shares) = e.deposit_ok(&bob, 50 * NEAR).await?;
    let bob_net = 50 * NEAR - cost;
    let bob_value = usd_e6(bob_net, PRICE_E8, Rounding::Down);
    assert_eq!(bob_shares, mul_div(bob_value, shares, nav_up, Rounding::Down));
    assert!(bob_shares < bob_value * FIRST_SHARES_PER_USD_E6, "a share is worth more than 1 USD now");
    assert_eq!(num(&event_from(&d, vault, "deposit_staked")["linear"]), bob_net);
    assert_eq!(e.shares_of(bob.id()).await?, bob_shares);
    assert_eq!(e.linear_of(vault).await?, net + bob_net);

    let state = e.state().await?;
    let nav = usd_e6(net + bob_net, PRICE_E8, Rounding::Down) + 15 * USDC;
    assert_eq!(num(&state["nav_e6"]), nav);
    assert_eq!(num(&state["total_shares"]), shares + bob_shares);
    assert_eq!(signed(&state["hedge"]["equity_e6"]), 15 * USDC as i128);
    assert!(num(&state["share_price_e6"]) > 1_000_000);

    // A report whose mark is more than 2% from the oracle: the deposit is priced, refused and
    // refunded in the callback, and no shares are minted.
    e.submit(10, Hedge::pnl(15 * USDC as i128).mark(320_000_000)).await?;
    e.feed().await?;
    let carol = s.user("carol", 50).await?;
    let before = carol.view_account().await?.balance.as_yoctonear();
    let d = ok(e.deposit(&carol, 10 * NEAR).await?)?;
    assert_eq!(d.json::<Value>()?, "0");
    let refund = event_from(&d, vault, "deposit_refunded");
    assert_eq!(num(&refund["amount"]), 10 * NEAR - cost);
    assert_eq!(refund["reason"], "oracle price is more than 2% away from the hedge mark");
    let spent = before - carol.view_account().await?.balance.as_yoctonear();
    assert!(spent < cost + NEAR / 2, "the deposit came back, less the registration: {spent}");
    assert_eq!(e.shares_of(carol.id()).await?, 0);
    assert_eq!(num(&e.state().await?["pending_deposit_near"]), 0);
    assert_eq!(e.linear_of(vault).await?, net + bob_net);
    Ok(())
}

/// Scenario 2, the hedge. `rebalance` needs a report; after deposits it builds the short that
/// hedges 90% of the staked NEAR, emits it with its agent digest, and has the mock signer sign
/// exactly that digest at `parry-vault-hedge`, returning `{ r, s, v }`. A second call before the
/// next report signs nothing; a report showing a partial fill allows one more order with a larger
/// nonce, and a report showing the target reached leaves the hedge in band.
#[tokio::test]
async fn rebalance_signs_one_hyperliquid_order_per_report() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    let refused = err(e.rebalance().await?);
    assert!(refused.contains("rebalance waits for a fresh report"), "{refused}");

    e.submit(10, Hedge::flat()).await?;
    e.feed().await?;
    let alice = s.user("alice", 300).await?;
    let bob = s.user("bob", 300).await?;
    e.deposit_ok(&alice, 100 * NEAR).await?;
    e.deposit_ok(&bob, 50 * NEAR).await?;
    let linear = e.linear_of(vault).await?;

    // Target: 90% of the staked NEAR (LiNEAR at 1:1), in Hyperliquid units, sold at
    // mark × (1 - 2%) = 2.94 in lots of 0.1 NEAR.
    let target_e8 = linear * HEDGE_RATIO_BPS / 10_000 / YOCTO_PER_E8;
    let size_e8 = target_e8 - target_e8 % 10_000_000;
    let order = |size_e8: u128| HlOrder {
        asset_index: 54,
        is_buy: false,
        price: "2.94".into(),
        size: decimal_e8(size_e8),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let expected = order(size_e8);
    assert_eq!(expected.size, "134.9");

    let d = ok(e.rebalance().await?)?;
    let ev = event_from(&d, vault, "hedge_order");
    assert_eq!(ev["order"], serde_json::to_value(&expected)?);
    assert_eq!((num(&ev["target_e8"]), signed(&ev["current_e8"])), (target_e8, 0));
    let nonce = ev["nonce"].as_u64().unwrap();
    let digest = hex::encode(order_digest(&expected, nonce, false));
    assert_eq!(ev["digest"], digest.as_str());
    assert_eq!(e.sign_requests().await?, vec![(vault.to_string(), HEDGE_PATH.to_string(), digest.clone())]);
    // The signature recovers to the vault's derived key at the hedge path, as on testnet.
    assert_signed_by(&e.s.worker, e.s.signer.id(), vault, HEDGE_PATH, &digest, &d.json::<Value>()?).await?;
    assert!(events_from(&d, vault, "hedge_sign_failed").is_empty());

    // The same report cannot sign a second order.
    let refused = err(e.rebalance().await?);
    assert!(refused.contains("a hedge order was already signed for this report"), "{refused}");
    assert_eq!(e.sign_requests().await?.len(), 1);

    // The next report shows 100 NEAR filled: one more order for the rest, with a larger nonce.
    e.submit(10, Hedge::flat().short(100 * 100_000_000)).await?;
    let d = ok(e.rebalance().await?)?;
    let ev = event_from(&d, vault, "hedge_order");
    let rest = order(size_e8 - 100 * 100_000_000);
    assert_eq!(rest.size, "34.9");
    assert_eq!(ev["order"], serde_json::to_value(&rest)?);
    assert_eq!(signed(&ev["current_e8"]), 100 * 100_000_000);
    let next_nonce = ev["nonce"].as_u64().unwrap();
    assert!(next_nonce > nonce);
    let digest = hex::encode(order_digest(&rest, next_nonce, false));
    assert_eq!(ev["digest"], digest.as_str());
    let requests = e.sign_requests().await?;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1], (vault.to_string(), HEDGE_PATH.to_string(), digest));

    // The target is reached: in band, nothing to sign.
    e.submit(10, Hedge::flat().short(size_e8)).await?;
    let d = ok(e.rebalance().await?)?;
    assert_eq!(d.json::<Value>()?, Value::Null);
    let band = event_from(&d, vault, "hedge_in_band");
    assert_eq!((num(&band["target_e8"]), signed(&band["current_e8"])), (target_e8, size_e8 as i128));
    assert!(events_from(&d, vault, "hedge_order").is_empty());
    assert_eq!(e.sign_requests().await?.len(), 2);
    Ok(())
}

/// Scenario 3, the risk levers, applied in code from the score in signed reports. 50 and above
/// lowers the hedge's leverage cap from 3x to 2x (here the cap binds, so the target short
/// shrinks); 70 and above pauses deposits; 85 and above flags margin. Each lever only lifts once
/// the score falls below its lower line (60 to resume, 40 to restore leverage).
#[tokio::test]
async fn risk_score_pauses_deposits_and_lowers_leverage() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    // A 100 USD hedge account caps the short at 100 NEAR at 3x and 66.66666666 NEAR at 2x.
    let small = Hedge { value_e6: 100 * USDC, margin_e6: 100 * USDC, ..Hedge::flat() };
    let cap_3x = 100 * 100_000_000;
    let cap_2x = 100 * USDC * 200 * 100_000_000 / PRICE_E8;
    assert_eq!(cap_2x, 6_666_666_666);

    e.submit(10, small).await?;
    e.feed().await?;
    let alice = s.user("alice", 300).await?;
    let bob = s.user("bob", 300).await?;
    e.deposit_ok(&alice, 150 * NEAR).await?;
    let state = e.state().await?;
    assert_eq!(state["paused"], false);
    assert_eq!(state["hedge"]["effective_max_leverage_x100"], 300);
    assert_eq!(num(&state["hedge"]["target_e8"]), cap_3x);

    let d = e.submit(55, small).await?;
    let reduced = event_from(&d, vault, "leverage_reduced");
    assert_eq!((reduced["score"].as_u64(), reduced["max_leverage_x100"].as_u64()), (Some(55), Some(200)));
    assert!(events_from(&d, vault, "deposits_paused").is_empty());
    let state = e.state().await?;
    assert_eq!(state["hedge"]["effective_max_leverage_x100"], 200);
    assert_eq!(num(&state["hedge"]["target_e8"]), cap_2x);
    assert_eq!(state["paused"], false);

    let d = e.submit(75, small).await?;
    assert_eq!(event_from(&d, vault, "deposits_paused")["score"], 75);
    assert!(events_from(&d, vault, "leverage_reduced").is_empty(), "already reduced");
    let state = e.state().await?;
    assert_eq!((state["paused"].as_bool(), state["risk_paused"].as_bool()), (Some(true), Some(true)));
    assert_eq!(state["manual_paused"], false);
    assert_eq!(state["risk_score"], 75);
    e.feed().await?;
    let refused = err(e.deposit(&bob, 10 * NEAR).await?);
    assert!(refused.contains("deposits are paused: the vault risk score is high"), "{refused}");
    assert_eq!(e.shares_of(bob.id()).await?, 0);

    let d = e.submit(90, small).await?;
    assert_eq!(event_from(&d, vault, "margin_needed")["score"], 90);
    assert_eq!(e.state().await?["hedge"]["needs_margin"], true);

    // 65 is below the pause line but not below the resume line: still paused.
    let d = e.submit(65, small).await?;
    assert!(events_from(&d, vault, "deposits_resumed").is_empty());
    assert!(events_from(&d, vault, "margin_needed").is_empty());
    let state = e.state().await?;
    assert_eq!(state["paused"], true);
    assert_eq!(state["hedge"]["needs_margin"], false);
    assert_eq!(state["hedge"]["effective_max_leverage_x100"], 200);

    let d = e.submit(30, small).await?;
    assert_eq!(event_from(&d, vault, "deposits_resumed")["score"], 30);
    let restored = event_from(&d, vault, "leverage_restored");
    assert_eq!((restored["score"].as_u64(), restored["max_leverage_x100"].as_u64()), (Some(30), Some(300)));
    let state = e.state().await?;
    assert_eq!(state["paused"], false);
    assert_eq!(state["hedge"]["effective_max_leverage_x100"], 300);
    assert_eq!(num(&state["hedge"]["target_e8"]), cap_3x);
    e.feed().await?;
    let (_, shares) = e.deposit_ok(&bob, 10 * NEAR).await?;
    assert_eq!(e.shares_of(bob.id()).await?, shares);
    Ok(())
}

/// Scenario 4, withdrawals. `request_withdraw` escrows the shares with the vault and queues
/// them; `process_withdrawals` pays nothing until a report observed after the request. With
/// positive hedge PnL and a buffer the owner funded, the leaver gets LiNEAR pro rata plus USDC;
/// with negative PnL the leaver gets less LiNEAR than pro rata, the rest backing the loss.
#[tokio::test]
async fn withdrawals_pay_linear_pro_rata_and_settle_hedge_pnl() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    e.submit(10, Hedge::flat()).await?;
    e.feed().await?;
    let alice = s.user("alice", 300).await?;
    let bob = s.user("bob", 300).await?;
    // LiNEAR and test USDC both refuse transfers to accounts not registered with them.
    for who in [&alice, &bob] {
        for token in [e.linear.id(), s.usdc.id()] {
            register(who, token, who.id()).await?;
        }
    }
    let (_, alice_shares) = e.deposit_ok(&alice, 100 * NEAR).await?;
    let (_, bob_shares) = e.deposit_ok(&bob, 50 * NEAR).await?;
    let linear = e.linear_of(vault).await?;
    let supply = alice_shares + bob_shares;

    let d = e.fund_buffer(100 * USDC).await?;
    let funded = event_from(&d, vault, "buffer_funded");
    assert_eq!((num(&funded["amount"]), num(&funded["buffer"])), (100 * USDC, 100 * USDC));
    assert_eq!(e.usdc_of(vault).await?, 100 * USDC);

    // Alice asks to withdraw half her shares: they move to the vault's escrow.
    let half = alice_shares / 2;
    let d = call(&alice, vault, "request_withdraw", json!({ "shares": half.to_string() }), 1, 30).await?;
    assert_eq!(d.json::<u64>()?, 0);
    let requested = event_from(&d, vault, "withdrawal_requested");
    assert_eq!((requested["id"].as_u64(), num(&requested["shares"])), (Some(0), half));
    let moved = event_from(&d, vault, "ft_transfer");
    assert_eq!(moved[0]["old_owner_id"], alice.id().as_str());
    assert_eq!(moved[0]["new_owner_id"], vault.as_str());
    assert_eq!(e.shares_of(alice.id()).await?, alice_shares - half);
    assert_eq!(e.shares_of(vault).await?, half);
    let queue = e.view("queue", json!({})).await?;
    assert_eq!(queue.as_array().unwrap().len(), 1);
    assert_eq!((queue[0]["account"].as_str(), num(&queue[0]["shares"])), (Some(alice.id().as_str()), half));
    let requested_at = queue[0]["requested_at"].as_u64().unwrap();
    let state = e.state().await?;
    assert_eq!((num(&state["queued_shares"]), state["queue_length"].as_u64()), (half, Some(1)));
    assert_eq!(num(&state["active_shares"]), supply - half);

    // The latest report predates the request: nothing is ready.
    let d = e.process().await?;
    assert_eq!(d.json::<u32>()?, 0);
    assert_eq!(e.linear_of(alice.id()).await?, 0);
    assert_eq!(e.view("queue", json!({})).await?.as_array().unwrap().len(), 1);

    // A later report: the hedge is up 45 USD over the operator margin.
    wait_past(requested_at);
    e.submit(10, Hedge::pnl(45 * USDC as i128).short(13_000_000_000)).await?;
    let d = e.process().await?;
    assert_eq!(d.json::<u32>()?, 1);
    assert!(d.0.receipt_failures().is_empty(), "both payouts succeed");
    let alice_linear = mul_div(linear, half, supply, Rounding::Down);
    let alice_usdc = mul_div(45 * USDC, half, supply, Rounding::Down);
    let paid = event_from(&d, vault, "withdrawal_processed");
    assert_eq!((paid["id"].as_u64(), paid["account"].as_str()), (Some(0), Some(alice.id().as_str())));
    assert_eq!((num(&paid["shares"]), num(&paid["linear"])), (half, alice_linear));
    assert_eq!((num(&paid["usdc"]), num(&paid["usdc_owed"])), (alice_usdc, 0));
    assert_eq!(signed(&paid["pnl_e6"]), alice_usdc as i128);
    let burn = event_from(&d, vault, "ft_burn");
    assert_eq!((burn[0]["owner_id"].as_str(), num(&burn[0]["amount"])), (Some(vault.as_str()), half));
    assert_eq!(e.linear_of(alice.id()).await?, alice_linear);
    assert_eq!(e.usdc_of(alice.id()).await?, alice_usdc);
    assert_eq!(e.linear_of(vault).await?, linear - alice_linear);
    assert_eq!(e.usdc_of(vault).await?, 100 * USDC - alice_usdc);
    assert_eq!(e.shares_of(vault).await?, 0);
    let state = e.state().await?;
    let supply = supply - half;
    assert_eq!(num(&state["total_shares"]), supply);
    assert_eq!((num(&state["queued_shares"]), state["queue_length"].as_u64()), (0, Some(0)));
    assert_eq!(num(&state["staked_linear"]), linear - alice_linear);
    assert_eq!(num(&state["buffer_usdc"]), 100 * USDC - alice_usdc);
    assert_eq!(signed(&state["settled_pnl_e6"]), alice_usdc as i128);
    assert!(e.view("queue", json!({})).await?.as_array().unwrap().is_empty());

    // Bob leaves after the hedge fell to 60 USD below the operator margin.
    let linear = linear - alice_linear;
    let d = call(&bob, vault, "request_withdraw", json!({ "shares": bob_shares.to_string() }), 1, 30).await?;
    assert_eq!(d.json::<u64>()?, 1);
    let requested_at = e.view("withdrawal", json!({ "id": 1 })).await?["requested_at"].as_u64().unwrap();
    wait_past(requested_at);
    e.submit(10, Hedge::pnl(-60 * USDC as i128).short(13_000_000_000)).await?;
    let d = e.process().await?;
    assert_eq!(d.json::<u32>()?, 1);

    // Equity: -60 USD, less the 45 USD share already settled with Alice.
    let equity = -60 * USDC as i128 - alice_usdc as i128;
    let loss = mul_div(equity.unsigned_abs(), bob_shares, supply, Rounding::Up);
    let nav = usd_e6(linear, PRICE_E8, Rounding::Down) - equity.unsigned_abs();
    let value = mul_div(nav, bob_shares, supply, Rounding::Down);
    let pro_rata = mul_div(linear, bob_shares, supply, Rounding::Down);
    let bob_linear = mul_div(value, YOCTO_PRICE_TO_USD_E6, PRICE_E8, Rounding::Down);
    assert!(bob_linear < pro_rata, "a negative hedge share pays fewer LiNEAR");
    let paid = event_from(&d, vault, "withdrawal_processed");
    assert_eq!((num(&paid["shares"]), num(&paid["linear"])), (bob_shares, bob_linear));
    assert_eq!((num(&paid["usdc"]), num(&paid["usdc_owed"])), (0, 0));
    assert_eq!(signed(&paid["pnl_e6"]), -(loss as i128));
    assert_eq!(num(&event_from(&d, vault, "ft_burn")[0]["amount"]), bob_shares);
    assert_eq!(e.linear_of(bob.id()).await?, bob_linear);
    assert_eq!(e.usdc_of(bob.id()).await?, 0);
    assert_eq!(e.shares_of(bob.id()).await?, 0);
    let state = e.state().await?;
    assert_eq!(num(&state["total_shares"]), supply - bob_shares);
    assert_eq!(num(&state["staked_linear"]), linear - pro_rata);
    assert_eq!(num(&state["loss_backing_linear"]), pro_rata - bob_linear);
    assert_eq!(signed(&state["settled_pnl_e6"]), alice_usdc as i128 - loss as i128);
    assert_eq!(num(&state["buffer_usdc"]), 100 * USDC - alice_usdc);
    // The vault still holds the remaining depositors' LiNEAR and the loss backing.
    assert_eq!(e.linear_of(vault).await?, linear - bob_linear);
    Ok(())
}

/// Scenario 5, wNEAR. A wNEAR `ft_transfer_call` with msg "deposit" is unwrapped by the vault,
/// then priced, staked and minted like a NEAR deposit; a transfer with any other msg is refused
/// and the wNEAR goes back to the sender.
#[tokio::test]
async fn wnear_deposits_unwrap_then_stake() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    let cost = e.storage_cost().await?;
    e.submit(10, Hedge::flat()).await?;
    let carol = s.user("carol", 100).await?;
    register(&carol, s.wrap.id(), carol.id()).await?;
    call(&carol, s.wrap.id(), "near_deposit", json!({}), 30 * NEAR, 30).await?;
    assert_eq!(balance(&e, s.wrap.id(), carol.id()).await?, 30 * NEAR);

    e.feed().await?;
    let d = call(
        &carol,
        s.wrap.id(),
        "ft_transfer_call",
        json!({ "receiver_id": vault, "amount": (20 * NEAR).to_string(), "msg": "deposit" }),
        1,
        300,
    )
    .await?;
    assert!(d.0.receipt_failures().is_empty(), "no receipt of the deposit fails");
    // The wrap contract's resolver sees all 20 wNEAR used.
    assert_eq!(num(&d.json::<Value>()?), 20 * NEAR);
    let net = 20 * NEAR - cost;
    let started = event_from(&d, vault, "deposit_started");
    assert_eq!(
        (started["source"].as_str(), started["account"].as_str()),
        (Some("wnear"), Some(carol.id().as_str()))
    );
    assert_eq!((num(&started["amount"]), num(&started["storage"])), (net, cost));
    let shares = usd_e6(net, PRICE_E8, Rounding::Down) * FIRST_SHARES_PER_USD_E6;
    let staked = event_from(&d, vault, "deposit_staked");
    assert_eq!((num(&staked["linear"]), num(&staked["shares"])), (net, shares));
    assert_eq!(balance(&e, s.wrap.id(), carol.id()).await?, 10 * NEAR);
    assert_eq!(balance(&e, s.wrap.id(), vault).await?, 0, "the vault unwrapped all of it");
    assert_eq!(e.linear_of(vault).await?, net);
    assert_eq!(e.shares_of(carol.id()).await?, shares);
    assert_eq!(num(&e.state().await?["staked_linear"]), net);

    // An unknown msg: the vault refuses and the wrap contract refunds the transfer.
    let d = call(
        &carol,
        s.wrap.id(),
        "ft_transfer_call",
        json!({ "receiver_id": vault, "amount": (5 * NEAR).to_string(), "msg": "stake" }),
        1,
        300,
    )
    .await?;
    assert_eq!(d.json::<Value>()?, "0");
    assert!(events_from(&d, vault, "deposit_started").is_empty());
    assert_eq!(balance(&e, s.wrap.id(), carol.id()).await?, 10 * NEAR);
    assert_eq!(e.shares_of(carol.id()).await?, shares);
    assert_eq!(e.linear_of(vault).await?, net);
    Ok(())
}

/// Scenario 6, proof of reserves. The vault's views (`reserves`, `collateral_ratio`,
/// `latest_report`, `vault_state`, `yield_breakdown`) show the latest report it accepted, and
/// agree with the risk board's record of it. A report for another vault, one signed by another
/// key, and a report sent straight to the vault leave them unchanged.
#[tokio::test]
async fn reserve_views_follow_the_latest_report() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    assert_eq!(e.view("reserves", json!({})).await?, Value::Null);
    assert_eq!(e.view("collateral_ratio", json!({})).await?, Value::Null);
    assert_eq!(e.view("latest_report", json!({})).await?, Value::Null);
    assert_eq!(e.state().await?["reserves"], Value::Null);

    let first = Reserves {
        root: "1f".repeat(32),
        leaves: 3,
        total_e6: 5_000 * USDC,
        liabilities_e6: 4_800 * USDC,
        ratio_bps: 10_416,
    };
    let hedge = Hedge { funding_e6: 2_500_000, ..Hedge::pnl(12 * USDC as i128) };
    let d = e.submit_with(20, hedge, &first).await?;
    let at = event_from(&d, vault, "report_applied")["at"].as_u64().unwrap();
    let run_id = s.run_id.get();
    let expect = |r: &Reserves, at: u64| {
        json!({
            "root": r.root, "leaves": r.leaves, "total_usd_e6": r.total_e6.to_string(),
            "liabilities_usd_e6": r.liabilities_e6.to_string(), "ratio_bps": r.ratio_bps, "at": at,
        })
    };
    assert_eq!(e.view("reserves", json!({})).await?, expect(&first, at));
    assert_eq!(e.view("collateral_ratio", json!({})).await?, 10_416);
    assert_eq!(e.state().await?["reserves"], expect(&first, at));
    let latest = e.view("latest_report", json!({})).await?;
    assert_eq!(
        (latest["run_id"].as_u64(), latest["at"].as_u64(), latest["score"].as_u64()),
        (Some(run_id), Some(at), Some(20))
    );
    assert_eq!(latest["hedge"]["account_value_e6"], (MARGIN_E6 + 12 * USDC).to_string());
    let y = e.view("yield_breakdown", json!({})).await?;
    assert_eq!((signed(&y["funding_e6"]), signed(&y["hedge_pnl_e6"])), (2_500_000, 12 * USDC as i128));
    assert_eq!(y["staking_rate_growth_bps"], 0);
    let board: Value = view(&s.worker, s.risk.id(), "latest_vault_report", json!({})).await?;
    assert_eq!(board["key_index"], 0);
    assert_eq!(board["report"]["run_id"], run_id);
    assert_eq!(board["report"]["vault"], vault.as_str());
    assert_eq!(board["report"]["reserves"]["root"], first.root.as_str());
    assert_eq!(board["report"]["reserves"]["ratio_bps"], first.ratio_bps);

    // A report about another vault is recorded by the board but not forwarded here.
    let other: AccountId = "other-vault.test.near".parse()?;
    let elsewhere = Reserves { root: "2e".repeat(32), ..Reserves::default() };
    let d = s.submit_report(e.report(&other, 20, Hedge::flat(), &elsewhere)).await?;
    assert_eq!(event_from(&d, s.risk.id(), "vault_reported")["forwarded"], false);
    assert!(events_from(&d, vault, "report_applied").is_empty());
    let board: Value = view(&s.worker, s.risk.id(), "latest_vault_report", json!({})).await?;
    assert_eq!(board["report"]["vault"], other.as_str());
    assert_eq!(e.view("reserves", json!({})).await?, expect(&first, at));

    // A report signed by a key that is not the enclave's is refused by the board.
    let forged = Reserves { root: "3d".repeat(32), ..Reserves::default() };
    let mut report = e.report(vault, 20, Hedge::flat(), &forged);
    report["run_id"] = json!(s.run_id.get() + 1);
    report["at"] = json!(now_secs());
    let text = report.to_string();
    let mut signed_bytes = b"parry-risk:v1:".to_vec();
    signed_bytes.extend_from_slice(text.as_bytes());
    let rogue = SigningKey::from_bytes(&[7u8; 32]).sign(&Sha256::digest(&signed_bytes));
    let refused = err(try_call(
        &s.root,
        s.risk.id(),
        "submit",
        json!({ "report_json": text, "signature": STANDARD.encode(rogue.to_bytes()) }),
        0,
        100,
    )
    .await?);
    assert!(refused.contains("signature does not verify against the enclave key"), "{refused}");
    // The same JSON sent straight to the vault: only the board may report.
    let refused =
        err(try_call(&s.root, vault, "on_vault_report", json!({ "report_json": text }), 0, 30).await?);
    assert!(refused.contains("only the risk board reports to the vault"), "{refused}");
    assert_eq!(e.view("reserves", json!({})).await?, expect(&first, at));

    // The next signed report replaces the reserves.
    let second = Reserves {
        root: "4c".repeat(32),
        leaves: 4,
        total_e6: 5_200 * USDC,
        liabilities_e6: 5_000 * USDC,
        ratio_bps: 10_400,
    };
    wait_past(at);
    let d = e.submit_with(25, Hedge::pnl(-3 * USDC as i128), &second).await?;
    let at2 = event_from(&d, vault, "report_applied")["at"].as_u64().unwrap();
    assert!(at2 > at);
    assert_eq!(e.view("reserves", json!({})).await?, expect(&second, at2));
    assert_eq!(e.view("collateral_ratio", json!({})).await?, 10_400);
    assert_eq!(e.state().await?["reserves"], expect(&second, at2));
    assert_eq!(e.state().await?["risk_score"], 25);
    let y = e.view("yield_breakdown", json!({})).await?;
    assert_eq!((signed(&y["funding_e6"]), signed(&y["hedge_pnl_e6"])), (0, -3 * USDC as i128));
    let board: Value = view(&s.worker, s.risk.id(), "latest_vault_report", json!({})).await?;
    assert_eq!(board["report"]["reserves"]["root"], second.root.as_str());
    assert_eq!(board["report"]["vault"], vault.as_str());
    Ok(())
}

/// Payouts that cannot be delivered become claims. LiNEAR and test USDC both refuse transfers
/// to accounts not registered with them, so a leaver registered with neither receives nothing:
/// both transfers fail and become the leaver's claim, next to the hedge PnL the buffer could not
/// cover yet. A claim made before registering fails again and is kept whole; once the leaver is
/// registered and the owner has topped up the buffer, `claim` pays all of it.
#[tokio::test]
async fn failed_payouts_become_claims() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    e.submit(10, Hedge::flat()).await?;
    e.feed().await?;
    let alice = s.user("alice", 300).await?;
    let (_, shares) = e.deposit_ok(&alice, 60 * NEAR).await?;
    let linear = e.linear_of(vault).await?;
    e.fund_buffer(5 * USDC).await?;

    call(&alice, vault, "request_withdraw", json!({ "shares": shares.to_string() }), 1, 30).await?;
    let requested_at = e.view("withdrawal", json!({ "id": 0 })).await?["requested_at"].as_u64().unwrap();
    wait_past(requested_at);
    // The only holder leaves with all of the 30 USD hedge PnL; the buffer covers 5.
    e.submit(10, Hedge::pnl(30 * USDC as i128)).await?;
    let d = e.process().await?;
    assert_eq!(d.json::<u32>()?, 1);
    let paid = event_from(&d, vault, "withdrawal_processed");
    assert_eq!(
        (num(&paid["linear"]), num(&paid["usdc"]), num(&paid["usdc_owed"])),
        (linear, 5 * USDC, 25 * USDC)
    );
    let both = vec![("linear".to_string(), linear), ("usdc".to_string(), 5 * USDC)];
    assert_eq!(failed_payouts(&d, vault), both);
    assert_eq!((e.linear_of(alice.id()).await?, e.usdc_of(alice.id()).await?), (0, 0));
    assert_eq!(e.linear_of(vault).await?, linear, "the LiNEAR stayed with the vault");
    assert_eq!(e.usdc_of(vault).await?, 5 * USDC, "the USDC stayed with the vault");
    let owed = json!({
        "linear": linear.to_string(), "usdc": (5 * USDC).to_string(), "usdc_owed": (25 * USDC).to_string(),
    });
    assert_eq!(e.view("claimable", json!({ "account_id": alice.id() })).await?, owed);
    let state = e.state().await?;
    assert_eq!((num(&state["staked_linear"]), num(&state["total_shares"])), (0, 0));
    assert_eq!(num(&state["buffer_usdc"]), 0);

    // Still unregistered: the claim sends both again, both fail, and the claim is kept whole.
    let d = call(&alice, vault, "claim", json!({}), 0, 100).await?;
    assert_eq!(failed_payouts(&d, vault), both);
    assert_eq!(e.view("claimable", json!({ "account_id": alice.id() })).await?, owed);

    for token in [e.linear.id(), s.usdc.id()] {
        register(&alice, token, alice.id()).await?;
    }
    e.fund_buffer(50 * USDC).await?;
    let d = call(&alice, vault, "claim", json!({}), 0, 100).await?;
    assert!(d.0.receipt_failures().is_empty(), "the claim's transfers succeed");
    let sent = json!({ "linear": linear.to_string(), "usdc": (30 * USDC).to_string(), "usdc_owed": "0" });
    assert_eq!(d.json::<Value>()?, sent);
    let claimed = event_from(&d, vault, "claimed");
    assert_eq!((num(&claimed["linear"]), num(&claimed["usdc"])), (linear, 30 * USDC));
    assert!(failed_payouts(&d, vault).is_empty());
    assert_eq!(e.linear_of(alice.id()).await?, linear);
    assert_eq!(e.usdc_of(alice.id()).await?, 30 * USDC);
    assert_eq!(
        e.view("claimable", json!({ "account_id": alice.id() })).await?,
        json!({ "linear": "0", "usdc": "0", "usdc_owed": "0" })
    );
    assert_eq!(num(&e.state().await?["buffer_usdc"]), 25 * USDC);
    assert_eq!((e.linear_of(vault).await?, e.usdc_of(vault).await?), (0, 25 * USDC));
    Ok(())
}

/// A full batch. Five withdrawals from two holders wait in the queue; one `process_withdrawals`
/// call settles the four oldest, in queue order, with both payouts of each delivered inside the
/// one transaction's gas, and the fifth waits for the next call. Every payout is the leaver's pro
/// rata share of what is left at its turn: LiNEAR and the hedge equity not yet settled.
#[tokio::test]
async fn withdrawals_settle_in_queue_order_four_per_call() -> Result<()> {
    let e = Earn::new().await?;
    let (s, vault) = (&e.s, e.vault.id());
    e.submit(10, Hedge::flat()).await?;
    e.feed().await?;
    let alice = s.user("alice", 300).await?;
    let bob = s.user("bob", 300).await?;
    for who in [&alice, &bob] {
        for token in [e.linear.id(), s.usdc.id()] {
            register(who, token, who.id()).await?;
        }
    }
    let (_, a) = e.deposit_ok(&alice, 80 * NEAR).await?;
    let (_, b) = e.deposit_ok(&bob, 40 * NEAR).await?;
    e.fund_buffer(100 * USDC).await?;

    let requests = [(&alice, a / 4), (&bob, b / 3), (&alice, a / 4), (&bob, b / 3), (&alice, a / 4)];
    for (id, (who, shares)) in requests.iter().enumerate() {
        let d = call(who, vault, "request_withdraw", json!({ "shares": shares.to_string() }), 1, 30).await?;
        assert_eq!(d.json::<u64>()?, id as u64);
    }
    let queue = e.view("queue", json!({})).await?;
    let ids: Vec<u64> = queue.as_array().unwrap().iter().map(|w| w["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![0, 1, 2, 3, 4]);
    wait_past(queue[4]["requested_at"].as_u64().unwrap());
    e.submit(10, Hedge::pnl(20 * USDC as i128)).await?;

    let (mut linear, mut supply, mut settled) = (e.linear_of(vault).await?, a + b, 0u128);
    let mut paid = std::collections::HashMap::<String, (u128, u128)>::new();
    let mut settle = |who: &Account, shares: u128| -> (u128, u128) {
        let l = mul_div(linear, shares, supply, Rounding::Down);
        let usdc = mul_div(20 * USDC - settled, shares, supply, Rounding::Down);
        (linear, supply, settled) = (linear - l, supply - shares, settled + usdc);
        let total = paid.entry(who.id().to_string()).or_default();
        *total = (total.0 + l, total.1 + usdc);
        (l, usdc)
    };

    let d = e.process().await?;
    assert_eq!(d.json::<u32>()?, 4);
    assert!(d.0.receipt_failures().is_empty(), "all eight payouts succeed");
    let processed = events_from(&d, vault, "withdrawal_processed");
    assert_eq!(processed.len(), 4);
    for (id, w) in processed.iter().enumerate() {
        let (who, shares) = requests[id];
        let (l, usdc) = settle(who, shares);
        assert_eq!((w["id"].as_u64(), w["account"].as_str()), (Some(id as u64), Some(who.id().as_str())));
        assert_eq!((num(&w["shares"]), num(&w["linear"]), num(&w["usdc"])), (shares, l, usdc));
    }
    assert_eq!(events_from(&d, vault, "ft_burn").len(), 4);
    let queue = e.view("queue", json!({})).await?;
    assert_eq!(queue.as_array().unwrap().len(), 1);
    assert_eq!(queue[0]["id"], 4);
    assert_eq!(e.state().await?["queue_length"], 1);

    let d = e.process().await?;
    assert_eq!(d.json::<u32>()?, 1);
    let w = event_from(&d, vault, "withdrawal_processed");
    let (l, usdc) = settle(requests[4].0, requests[4].1);
    assert_eq!((w["id"].as_u64(), num(&w["linear"]), num(&w["usdc"])), (Some(4), l, usdc));
    assert_eq!(e.process().await?.json::<u32>()?, 0);

    for who in [&alice, &bob] {
        let (l, usdc) = paid[who.id().as_str()];
        assert_eq!((e.linear_of(who.id()).await?, e.usdc_of(who.id()).await?), (l, usdc));
    }
    assert_eq!(e.shares_of(alice.id()).await?, a - 3 * (a / 4));
    assert_eq!(e.shares_of(bob.id()).await?, b - 2 * (b / 3));
    let state = e.state().await?;
    assert_eq!((num(&state["total_shares"]), num(&state["staked_linear"])), (supply, linear));
    assert_eq!((num(&state["queued_shares"]), state["queue_length"].as_u64()), (0, Some(0)));
    assert_eq!(signed(&state["settled_pnl_e6"]), settled as i128);
    assert_eq!(e.linear_of(vault).await?, linear);
    assert_eq!(e.usdc_of(vault).await?, 100 * USDC - settled);
    Ok(())
}

/// Redeploys `contract` with `code` and runs `migrate` in the same batch, from the contract's own
/// account, as a deployment would.
async fn deploy_and_migrate(contract: &Contract, code: &[u8]) -> Result<ExecutionFinalResult> {
    Ok(contract
        .as_account()
        .batch(contract.id())
        .deploy(code)
        .call(
            near_workspaces::operations::Function::new("migrate")
                .args_json(json!({}))
                .gas(near_workspaces::types::Gas::from_tgas(100)),
        )
        .transact()
        .await?)
}

/// The insurance fund: a tenth of the funding the hedge receives moves into it (outside the share
/// price); when the hedge pays funding, the keeper pays some of it back to the depositors within
/// the day's cap; and a report's funding-aware hedge ratio sizes the hedge.
#[tokio::test]
async fn insurance_fund_takes_funding_yield_and_pays_negative_funding() -> Result<()> {
    let e = Earn::new().await?;
    let vault = e.vault.id();
    let alice = e.s.user("alice", 300).await?;
    e.feed().await?;
    e.submit(10, Hedge::flat()).await?;
    let (_, _) = e.deposit_ok(&alice, 100 * NEAR).await?;
    let staked = num(&e.state().await?["staked_linear"]);

    let short = |funding: i128| Hedge { funding_e6: funding, ..Hedge::pnl(funding).short(90 * 100_000_000) };
    e.submit(10, short(0)).await?;
    let d = e.submit(10, short(100 * USDC as i128)).await?;
    let inflow = event_from(&d, vault, "insurance_inflow");
    assert_eq!((num(&inflow["usdc_e6"]), num(&inflow["linear"])), (10 * USDC, 0));
    let fund = e.view("insurance", json!({})).await?;
    assert_eq!(
        (num(&fund["usdc_e6"]), num(&fund["value_usd_e6"]), fund["share_bps"].as_u64()),
        (10 * USDC, 10 * USDC, Some(1_000))
    );
    // The share price excludes the fund: the depositors keep 90 of the 100 USD.
    let state = e.state().await?;
    assert_eq!(signed(&state["hedge"]["equity_e6"]), 90 * USDC as i128);
    assert_eq!(num(&state["nav_e6"]), usd_e6(staked, PRICE_E8, Rounding::Down) + 90 * USDC);

    // Funding turns: the hedge pays 150 USD by the next report.
    e.submit(10, short(-50 * USDC as i128)).await?;
    let state = e.state().await?;
    let at = state["report_at"].as_u64().unwrap();
    let args = |amount: u128| json!({ "kind": "negative_funding", "amount_usd_e6": amount.to_string(), "report_at": at });
    assert!(err(try_call(&alice, vault, "insurance_pay", args(USDC), 0, 30).await?).contains("keeper only"));
    let d = ok(try_call(&e.s.root, vault, "insurance_pay", args(2 * USDC), 0, 30).await?)?;
    let paid = event_from(&d, vault, "insurance_paid");
    assert_eq!((paid["kind"].as_str(), num(&paid["amount_usd_e6"])), (Some("negative_funding"), 2 * USDC));
    assert_eq!(num(&e.view("insurance", json!({})).await?["usdc_e6"]), 8 * USDC);
    // Back to the depositors: equity is −50 − 8 instead of −50 − 10.
    assert_eq!(signed(&e.state().await?["hedge"]["equity_e6"]), -58 * USDC as i128);
    // A quarter of the 10 USD fund per day: 0.5 USD more is the most today.
    assert!(
        err(try_call(&e.s.root, vault, "insurance_pay", args(USDC), 0, 30).await?).contains("per-day cap")
    );
    let history = e.view("insurance_history", json!({ "from": 0, "limit": 10 })).await?;
    let kinds: Vec<&str> = history.as_array().unwrap().iter().map(|h| h["event"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["insurance_paid", "insurance_inflow"]);

    // A funding-aware ratio of 80% sizes the hedge.
    let why = "7-day funding is -12.0% a year: shorts pay, hedge leans to 80% (min 70%)";
    let big = Hedge { value_e6: 100_000 * USDC, margin_e6: 100_000 * USDC, ..Hedge::flat() };
    e.submit_extra(
        10,
        big,
        json!({ "hedge_ratio_bps": 8_000, "hedge_ratio_reason": why, "margin_ratio": 900 }),
    )
    .await?;
    let hedge = e.view("hedge_status", json!({})).await?;
    assert_eq!(
        (hedge["hedge_ratio_bps"].as_u64(), hedge["hedge_ratio_reason"].as_str()),
        (Some(8_000), Some(why))
    );
    assert_eq!(hedge["margin_ratio_bps"].as_u64(), Some(900));
    let latest = view::<Value>(&e.s.worker, e.s.risk.id(), "latest_vault_report", json!({})).await?;
    assert_eq!(latest["report"]["hedge_ratio_bps"], 8_000);
    let d = ok(e.rebalance().await?)?;
    let order = event_from(&d, vault, "hedge_order");
    let staked = num(&e.state().await?["staked_linear"]);
    assert_eq!(num(&order["target_e8"]), staked * 8_000 / 10_000 / YOCTO_PER_E8);
    Ok(())
}

/// The vault and the risk board deployed on testnet, holding state, take this code and migrate:
/// balances, shares, the queue, the report histories, the run ids and the enclave key stay; the
/// insurance fund, the hedge ratio and certificate anchors start working.
#[tokio::test]
async fn the_deployed_vault_and_risk_board_migrate_with_their_state() -> Result<()> {
    let s = Stack::with_risk_code(&fixture("risk-v1")).await?;
    let e = Earn::with_codes(s, &fixture("vault-v1")).await?;
    let (s, vault) = (&e.s, e.vault.id());
    let alice = s.user("alice", 300).await?;
    let bob = s.user("bob", 300).await?;
    for who in [&alice, &bob] {
        register(who, e.linear.id(), who.id()).await?;
    }
    e.feed().await?;
    e.submit(10, Hedge::flat()).await?;
    let (_, a) = e.deposit_ok(&alice, 100 * NEAR).await?;
    e.deposit_ok(&bob, 50 * NEAR).await?;
    e.submit(10, Hedge::pnl(15 * USDC as i128)).await?;
    s.submit_report(json!({ "kind": "sealing_key", "public_key": "5e".repeat(32) })).await?;
    call(&alice, vault, "request_withdraw", json!({ "shares": (a / 2).to_string() }), 1, 50).await?;
    let requested = now_secs();

    let state = e.state().await?;
    let queue = e.view("queue", json!({})).await?;
    let board = |m: &'static str| view::<Value>(&s.worker, s.risk.id(), m, json!({}));
    let (run_ids, stats, sealing, enclave, latest) = (
        board("last_run_ids").await?,
        board("stats").await?,
        board("sealing_key").await?,
        board("get_enclave").await?,
        board("latest_vault_report").await?,
    );
    assert!(err(try_call(
        s.risk.as_account(),
        s.risk.id(),
        "certificate",
        json!({ "hash": "ab".repeat(32) }),
        0,
        30
    )
    .await?)
    .contains("MethodNotFound"));

    // The deploy batches: the code, then `migrate`, from each contract's own account.
    let r = deploy_and_migrate(&s.risk, &wasm("parry_risk")).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let r = deploy_and_migrate(&e.vault, &wasm("parry_vault")).await?;
    assert!(r.is_success(), "{:?}", r.failures());

    let after = e.state().await?;
    for k in [
        "total_shares",
        "staked_linear",
        "nav_e6",
        "queued_shares",
        "settled_pnl_e6",
        "buffer_usdc",
        "linear_rate_e24",
    ] {
        assert_eq!(after[k], state[k], "{k}");
    }
    assert_eq!(after["queue_length"], state["queue_length"]);
    assert_eq!(e.view("queue", json!({})).await?, queue);
    assert_eq!(e.shares_of(alice.id()).await?, a - a / 2);
    let fund = e.view("insurance", json!({})).await?;
    assert_eq!((num(&fund["linear"]), num(&fund["usdc_e6"])), (0, 0));
    assert_eq!(e.view("config", json!({})).await?["hedge_ratio_min_bps"], 7_000);

    let mut want_ids = run_ids.clone();
    want_ids["certificate"] = json!(0);
    assert_eq!(board("last_run_ids").await?, want_ids);
    let mut want_stats = stats.clone();
    want_stats["certificates"] = json!(0);
    assert_eq!(board("stats").await?, want_stats);
    assert_eq!(board("sealing_key").await?, sealing);
    assert_eq!(board("get_enclave").await?, enclave);
    assert_eq!(board("latest_vault_report").await?, latest, "the stored report reads the same");

    // Migrating twice is refused.
    let again = deploy_and_migrate(&e.vault, &wasm("parry_vault")).await?;
    assert!(err(again).contains("already migrated"));

    // Both keep working: a report with the new fields reaches the vault, the queue pays, and the
    // board anchors certificates.
    wait_past(requested);
    e.feed().await?;
    let d = e
        .submit_extra(
            10,
            Hedge::pnl(15 * USDC as i128),
            json!({ "hedge_ratio_bps": 8_500, "hedge_ratio_reason": "full funding", "margin_ratio": 100 }),
        )
        .await?;
    assert_eq!(event_from(&d, vault, "hedge_ratio_set")["hedge_ratio_bps"], 8_500);
    let d = e.process().await?;
    assert_eq!(events_from(&d, vault, "withdrawal_processed").len(), 1);
    let d = s
        .submit_report(json!({ "kind": "certificate", "hash": "ce".repeat(32), "reader": "lender.testnet", "expires_at": now_secs() + 3_600 }))
        .await?;
    assert_eq!(event_from(&d, s.risk.id(), "certificate_anchored")["reader"], "lender.testnet");
    let cert =
        view::<Value>(&s.worker, s.risk.id(), "certificate", json!({ "hash": "ce".repeat(32) })).await?;
    assert_eq!(cert["reader"], "lender.testnet");
    e.deposit_ok(&bob, 10 * NEAR).await?;
    Ok(())
}
