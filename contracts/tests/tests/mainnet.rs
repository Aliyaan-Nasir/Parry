//! #mainnet rehearsal: Parry configured as `deployments/mainnet.json` plans it, on a local sandbox
//! that runs the code mainnet runs today for everything Parry does not own.
//!
//! - Rhea lending (`contract.main.burrow.near`), wNEAR (`wrap.near`), the Rhea exchange
//!   (`v2.ref-finance.near`), LiNEAR (`linear-protocol.near`) and Circle's native USDC are imported
//!   from mainnet with their current code, under their mainnet account ids (read over mainnet RPC).
//! - The factory, the protected accounts, the risk board and the vault get `network: "mainnet"`,
//!   so envelopes, owner requests and Hyperliquid digests (source "a") take their mainnet form.
//! - A full rescue (repay, then an atomic deleverage on a real-code pool) and a vault cycle
//!   (deposit into real-code LiNEAR, a mainnet hedge order, a withdrawal) run end to end.
//!
//! What it cannot rehearse: Chain Signatures (`v1.signer` needs the MPC network; a stand-in
//! answers at that id), the price oracle's live feed (Parry's Pyth-interface code stands in at
//! `aggregate-oracle.near`'s id, with prices the test posts), and the off-chain services (OutLayer,
//! NEAR AI, 1Click, Hyperliquid), which have their own tests. MAINNET_RPC_URL overrides the RPC.

mod common;

use anyhow::Result;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const INNER: u128 = 1_000_000_000_000;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A top-level mainnet name made in the sandbox with a key the test holds.
async fn top_level(worker: &Worker<Sandbox>, name: &str, near: u128) -> Result<Account> {
    let key = SecretKey::from_random(KeyType::ED25519);
    worker
        .patch(&id(name))
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(near)).storage_usage(182))
        .access_key(key.public_key(), AccessKey::full_access())
        .transact()
        .await?;
    Ok(Account::from_secret_key(id(name), key, worker))
}

async fn sub(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

fn envelope(key: &SigningKey, account: &AccountId, nonce: u64, action: Value) -> (String, String) {
    let text = json!({
        "account": account, "network": "mainnet", "nonce": nonce, "issued_at": now_secs(),
        "review_hash": "3a".repeat(32), "trigger": { "score": 80, "tier": "critical", "health_bps": 10_400 }, "action": action,
    })
    .to_string();
    let mut data = b"parry-guardian:v1:".to_vec();
    data.extend_from_slice(text.as_bytes());
    (text.clone(), STANDARD.encode(key.sign(&Sha256::digest(&data)).to_bytes()))
}

fn signed_report(key: &SigningKey, mut report: Value, run_id: u64) -> Value {
    report["run_id"] = json!(run_id);
    report["at"] = json!(now_secs());
    let text = report.to_string();
    let mut data = b"parry-risk:v1:".to_vec();
    data.extend_from_slice(text.as_bytes());
    json!({ "report_json": text, "signature": STANDARD.encode(key.sign(&Sha256::digest(&data)).to_bytes()) })
}

#[tokio::test]
async fn mainnet_configuration_rescues_a_position_and_runs_a_vault_cycle() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let rpc = std::env::var("MAINNET_RPC_URL").unwrap_or_else(|_| "https://rpc.mainnet.fastnear.com".into());
    let mainnet = near_workspaces::mainnet().rpc_addr(&rpc).await?;
    let usdc_id = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

    // The code mainnet runs today, under its mainnet ids.
    let mut imported = vec![];
    for name in
        ["contract.main.burrow.near", "wrap.near", "v2.ref-finance.near", "linear-protocol.near", usdc_id]
    {
        let c = worker
            .import_contract(&id(name), &mainnet)
            .initial_balance(NearToken::from_near(10_000))
            .transact()
            .await?;
        eprintln!("imported {name}: {}", code_hash(&c.view_code().await?));
        imported.push(c);
    }
    let (lending, wrap, dex, linear, usdc) =
        (&imported[0], &imported[1], &imported[2], &imported[3], &imported[4]);
    assert_eq!(
        code_hash(&lending.view_code().await?),
        "6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa",
        "lending is still v0.16.2"
    );

    let sandbox_root = worker.root_account()?;
    let second = sub(&sandbox_root, "circle", 10).await?;
    let root = top_level(&worker, "parryguard.near", 2_000).await?;
    let signer = top_level(&worker, "v1.signer", 10).await?;
    signer.deploy(&wasm("parry_test_mock_signer")).await?.into_result()?;
    let oracle = top_level(&worker, "aggregate-oracle.near", 10).await?;
    // Parry's Pyth-interface oracle stands in for the live feed (its init takes "testnet" by design).
    oracle.deploy(&wasm("parry_oracle")).await?.into_result()?;
    call(&oracle, oracle.id(), "new", json!({ "owner_id": oracle.id(), "feeders": [oracle.id()], "network": "testnet", "max_shock_bps": 4000 }), 0, 50).await?;
    let feed = |price: i64, t: u64| {
        json!({ "updates": [
            { "price_id": NEAR_USD, "price": price.to_string(), "conf": "1", "expo": -8, "publish_time": t },
            { "price_id": USDC_USD, "price": "100000000", "conf": "1", "expo": -8, "publish_time": t },
        ]})
    };
    let mut published = now_secs();
    call(&oracle, oracle.id(), "update_prices", feed(300_000_000, published), 0, 50).await?;

    // Imported contracts start without state: initialize them as their operators did.
    call(&sandbox_root, wrap.id(), "new", json!({}), 0, 50).await?;
    let both = json!([sandbox_root.id(), second.id()]);
    call(&sandbox_root, usdc.id(), "init", json!({ "admin_ids": both, "master_minter_ids": both, "owner_ids": both, "pauser_ids": both, "blocklister_id": sandbox_root.id(),
        "metadata": { "spec": "ft-1.0.0", "name": "USDC", "symbol": "USDC", "decimals": 6 } }), 0, 300).await?;
    for action in [
        json!({ "ConfigureController": { "controller_id": sandbox_root.id(), "minter_id": sandbox_root.id() } }),
        json!({ "ConfigureController": { "controller_id": second.id(), "minter_id": sandbox_root.id() } }),
        json!({ "ConfigureMinterAllowance": { "controller_id": sandbox_root.id(), "minter_allowance": (100_000_000 * USDC).to_string() } }),
    ] {
        let request: u32 =
            call(&sandbox_root, usdc.id(), "create_multisig_request", json!({ "action": action }), 0, 100)
                .await?
                .json()?;
        for approver in [&sandbox_root, &second] {
            call(approver, usdc.id(), "approve_multisig_request", json!({ "request_id": request }), 0, 100)
                .await?;
        }
        call(&sandbox_root, usdc.id(), "execute_multisig_request", json!({ "request_id": request }), 0, 100)
            .await?;
    }
    call(&sandbox_root, dex.id(), "new", json!({ "owner_id": root.id(), "boost_farm_id": root.id(), "burrowland_id": lending.id(), "exchange_fee": 4, "referral_fee": 1 }), 0, 100).await?;
    call(&sandbox_root, linear.id(), "new", json!({ "owner_id": root.id() }), 0, 100).await?;
    call(&sandbox_root, lending.id(), "new", json!({ "config": {
        "oracle_account_id": oracle.id(), "pyth_oracle_account_id": oracle.id(), "ref_exchange_id": dex.id(), "owner_id": root.id(),
        "booster_token_id": wrap.id(), "booster_decimals": 24, "max_num_assets": 20, "maximum_recency_duration_sec": 90, "maximum_staleness_duration_sec": 90,
        "lp_tokens_info_valid_duration_sec": 600, "pyth_price_valid_duration_sec": 120, "minimum_staking_duration_sec": 2592000, "maximum_staking_duration_sec": 7776000,
        "x_booster_multiplier_at_maximum_staking_duration": 30000, "force_closing_enabled": true, "enable_price_oracle": false, "enable_pyth_oracle": true,
        "contract_mode": "Running", "boost_suppress_factor": 1000, "dcl_id": dex.id(), "pause_operator_id": null,
    }}), 0, 100).await?;
    let asset = |ratio: u32, extra: u8| {
        json!({
            "reserve_ratio": 2500, "beneficiaries": {}, "target_utilization": 8000, "target_utilization_rate": "1000000000003593629036885046",
            "max_utilization_rate": "1000000000039724853136740579", "holding_position_fee_rate": "1000000000000000000000000000", "volatility_ratio": ratio,
            "extra_decimals": extra, "can_deposit": true, "can_withdraw": true, "can_use_as_collateral": true, "can_borrow": true, "net_tvl_multiplier": 0,
            "max_change_rate": null, "supplied_limit": "1000000000000000000000000000000000", "borrowed_limit": "1000000000000000000000000000000000", "min_borrowed_amount": "1000000000",
        })
    };
    call(
        &root,
        lending.id(),
        "add_asset",
        json!({ "token_id": wrap.id(), "asset_config": asset(7500, 0) }),
        1,
        50,
    )
    .await?;
    call(
        &root,
        lending.id(),
        "add_asset",
        json!({ "token_id": usdc.id(), "asset_config": asset(9500, 12) }),
        1,
        50,
    )
    .await?;
    let pyth = |d: u8, pid: &str| json!({ "decimals": d, "fraction_digits": 4, "price_identifier": pid, "extra_call": null, "default_price": null });
    call(
        &root,
        lending.id(),
        "add_token_pyth_info",
        json!({ "token_id": wrap.id(), "token_pyth_info": pyth(24, NEAR_USD) }),
        1,
        50,
    )
    .await?;
    call(
        &root,
        lending.id(),
        "add_token_pyth_info",
        json!({ "token_id": usdc.id(), "token_pyth_info": pyth(6, USDC_USD) }),
        1,
        50,
    )
    .await?;

    // Liquidity: USDC minted the way Circle mints it, supplied to lending, and a wNEAR/USDC pool.
    let usdc_storage: Value = view(&worker, usdc.id(), "storage_balance_bounds", json!({})).await?;
    let usdc_min: u128 = usdc_storage["min"].as_str().unwrap().parse()?;
    for who in [root.id(), lending.id(), dex.id()] {
        call(
            &root,
            usdc.id(),
            "storage_deposit",
            json!({ "account_id": who, "registration_only": true }),
            usdc_min,
            30,
        )
        .await?;
        call(
            &root,
            wrap.id(),
            "storage_deposit",
            json!({ "account_id": who, "registration_only": true }),
            NEAR / 100,
            30,
        )
        .await?;
    }
    call(
        &sandbox_root,
        usdc.id(),
        "mint",
        json!({ "to": root.id(), "amount": (500_000 * USDC).to_string() }),
        0,
        50,
    )
    .await?;
    call(&root, lending.id(), "storage_deposit", json!({ "account_id": root.id() }), NEAR / 4, 30).await?;
    call(
        &root,
        usdc.id(),
        "ft_transfer_call",
        json!({ "receiver_id": lending.id(), "amount": (200_000 * USDC).to_string(), "msg": "" }),
        1,
        150,
    )
    .await?;
    call(
        &root,
        dex.id(),
        "storage_deposit",
        json!({ "account_id": root.id(), "registration_only": false }),
        NEAR,
        30,
    )
    .await?;
    let pool: u64 = call(
        &root,
        dex.id(),
        "add_simple_pool",
        json!({ "tokens": [wrap.id(), usdc.id()], "fee": 25 }),
        NEAR / 10,
        50,
    )
    .await?
    .json()?;
    call(&root, dex.id(), "register_tokens", json!({ "token_ids": [wrap.id(), usdc.id()] }), 1, 30).await?;
    call(&root, wrap.id(), "near_deposit", json!({}), 600 * NEAR, 30).await?;
    call(
        &root,
        wrap.id(),
        "ft_transfer_call",
        json!({ "receiver_id": dex.id(), "amount": (500 * NEAR).to_string(), "msg": "" }),
        1,
        100,
    )
    .await?;
    call(
        &root,
        usdc.id(),
        "ft_transfer_call",
        json!({ "receiver_id": dex.id(), "amount": (1_500 * USDC).to_string(), "msg": "" }),
        1,
        100,
    )
    .await?;
    call(
        &root,
        dex.id(),
        "add_liquidity",
        json!({ "pool_id": pool, "amounts": [(500 * NEAR).to_string(), (1_500 * USDC).to_string()] }),
        NEAR / 100,
        100,
    )
    .await?;

    // Parry under parryguard.near, network "mainnet".
    let enclave = SigningKey::from_bytes(&[77u8; 32]);
    let risk = sub(&root, "risk", 20).await?;
    risk.deploy(&wasm("parry_risk")).await?.into_result()?;
    call(&risk, risk.id(), "new", json!({ "owner_id": root.id(), "enclave_key": ed25519_key(&enclave), "wasm_sha256": "cd".repeat(32), "vault": format!("vault.{}", root.id()) }), 0, 50).await?;
    let code = sub(&root, "code", 80).await?;
    code.deploy(&wasm("parry_test_publisher")).await?.into_result()?;
    let account_code = wasm("parry_account");
    call(&code, code.id(), "publish", json!({ "code": STANDARD.encode(&account_code) }), 0, 300).await?;
    let factory = sub(&root, "accounts", 20).await?;
    factory.deploy(&wasm("parry_accounts")).await?.into_result()?;
    let protocol = json!({
        "lending": lending.id(), "oracle": oracle.id(), "dex": dex.id(), "risk": risk.id(), "signer": signer.id(), "factory": factory.id(),
        "tokens": [
            { "token_id": wrap.id(), "symbol": "wNEAR", "decimals": 24, "extra_decimals": 0, "price_id": NEAR_USD, "rate_call": null, "mark": "NEAR" },
            { "token_id": usdc.id(), "symbol": "USDC", "decimals": 6, "extra_decimals": 12, "price_id": USDC_USD, "rate_call": null, "mark": null },
        ],
    });
    call(&factory, factory.id(), "new", json!({ "owner": root.id(), "network": "mainnet", "protocol": protocol, "account_code": code_hash(&account_code) }), 0, 50).await?;

    // A person's protected account, a leveraged position, a mandate.
    let alice = sub(&sandbox_root, "alice", 400).await?;
    let acct: AccountId =
        call(&alice, factory.id(), "create_account", json!({ "near_account": alice.id() }), NEAR / 2, 250)
            .await?
            .json::<Option<AccountId>>()?
            .expect("created");
    alice.transfer_near(&acct, NearToken::from_near(140)).await?.into_result()?;
    let owner = |actions: Value| call(&alice, &acct, "owner_call", json!({ "actions": actions }), 1, 300);
    owner(json!([
        { "call": { "receiver_id": wrap.id(), "method_name": "near_deposit", "args": "e30=", "deposit": (130 * NEAR).to_string(), "gas": "20000000000000" } },
        { "supply": { "token": wrap.id(), "amount": (100 * NEAR).to_string() } },
    ])).await?;
    owner(json!([{ "borrow": { "token": usdc.id(), "amount": (150 * USDC).to_string() } }])).await?;
    call(&sandbox_root, usdc.id(), "mint", json!({ "to": acct, "amount": (60 * USDC).to_string() }), 0, 50)
        .await?;
    let guardian_key = SigningKey::from_bytes(&[78u8; 32]);
    owner(json!([{ "set_mandate": { "mandate": {
        "guardian_key": ed25519_key(&guardian_key), "powers": ["repay", "deleverage"],
        "limits": [{ "token": usdc.id(), "reserve": (200 * USDC).to_string(), "daily": (120 * USDC).to_string() }, { "token": wrap.id(), "reserve": (40 * NEAR).to_string(), "daily": (80 * NEAR).to_string() }],
        "max_actions_per_day": 10, "min_health_after_bps": 10_500, "max_slippage_bps": 300, "hl": null, "evm": null, "sealed": null,
        "expires_at": now_secs() + 86_400,
    }}}])).await?;

    // NEAR falls to $2.50: the guardian repays from the reserve, then deleverages on the real pool.
    published = published.max(now_secs()) + 1;
    call(&oracle, oracle.id(), "update_prices", feed(250_000_000, published), 0, 50).await?;
    call(&risk, risk.id(), "submit", signed_report(&enclave, json!({ "kind": "risk_update", "positions": [], "marks": [{ "asset": "NEAR", "asset_index": 74, "price_e8": "250000000" }] }), now_secs() * 1000), 0, 100).await?;
    let relayer = sub(&sandbox_root, "relayer", 20).await?;
    let (e, s) = envelope(
        &guardian_key,
        &acct,
        1,
        json!({ "repay": { "token": usdc.id(), "amount": (50 * USDC).to_string() } }),
    );
    let r =
        ok(try_call(&relayer, &acct, "guardian_execute", json!({ "envelope": e, "signature": s }), 0, 300)
            .await?)?;
    assert_eq!(r.events("guardian_acted").len(), 1);
    let lines: Value = view(&worker, lending.id(), "get_account", json!({ "account_id": acct })).await?;
    let debt: u128 = lines["borrowed"][0]["balance"].as_str().unwrap().parse()?;
    assert!(debt < 101 * USDC * INNER, "debt after repay {debt}");

    published = published.max(now_secs()) + 1;
    call(&oracle, oracle.id(), "update_prices", feed(250_000_000, published), 0, 50).await?;
    let (e, s) = envelope(
        &guardian_key,
        &acct,
        2,
        json!({ "deleverage": {
            "collateral": wrap.id(), "amount": (20 * NEAR).to_string(), "pool_id": pool, "debt": usdc.id(), "min_out": (49 * USDC).to_string(),
        }}),
    );
    let r =
        ok(try_call(&relayer, &acct, "guardian_execute", json!({ "envelope": e, "signature": s }), 0, 900)
            .await?)?;
    assert_eq!(r.events("deleverage_completed").len(), 1, "logs: {:#?}", r.logs());
    let lines: Value = view(&worker, lending.id(), "get_account", json!({ "account_id": acct })).await?;
    assert_eq!(lines["collateral"][0]["balance"], (80 * NEAR).to_string());

    // The vault on mainnet ids: deposit into real-code LiNEAR, a mainnet hedge order, a withdrawal.
    let vault = sub(&root, "vault", 20).await?;
    vault.deploy(&wasm("parry_vault")).await?.into_result()?;
    call(&vault, vault.id(), "new", json!({
        "owner_id": root.id(), "network": "mainnet", "risk": risk.id(), "keeper": root.id(), "linear": linear.id(), "wnear": wrap.id(), "usdc": usdc.id(),
        "oracle": oracle.id(), "signer": signer.id(),
        "hedge": { "asset": "NEAR", "asset_index": 74, "sz_decimals": 1, "hedge_ratio_bps": 9000, "max_leverage_x100": 300, "band_bps": 200 },
        "deposit_cap": (1_000 * NEAR).to_string(), "min_deposit": NEAR.to_string(),
    }), 0, 100).await?;
    for (token, deposit) in [(wrap.id(), NEAR / 100), (usdc.id(), usdc_min), (linear.id(), NEAR / 100)] {
        call(
            &root,
            token,
            "storage_deposit",
            json!({ "account_id": vault.id(), "registration_only": true }),
            deposit,
            30,
        )
        .await?;
    }
    let vault_report = |run: u64, account_value: u128, size: i128| {
        json!({
            "kind": "vault_report", "vault": vault.id(), "score": 12,
            "components": { "liquidation_bps": 0, "margin_bps": 0, "funding_bps": 0, "oracle_bps": 0, "rate_bps": 0, "reserves_bps": 0 },
            "hedge": { "asset_index": 74, "size_e8": size.to_string(), "entry_e8": "250000000", "account_value_e6": account_value.to_string(), "unrealized_e6": "0",
                       "funding_e6": "0", "margin_baseline_e6": account_value.to_string(), "mark_e8": "250000000", "liquidation_e8": "0" },
            "reserves": { "root": "ab".repeat(32), "leaves": 4, "total_usd_e6": "0", "liabilities_usd_e6": "0", "ratio_bps": 10000 },
            "run_id": run,
        })
    };
    published = published.max(now_secs()) + 1;
    call(&oracle, oracle.id(), "update_prices", feed(250_000_000, published), 0, 50).await?;
    let run0 = now_secs() * 1000 + 10;
    call(
        &risk,
        risk.id(),
        "submit",
        signed_report(&enclave, vault_report(run0, 1_000 * USDC, 0), run0),
        0,
        120,
    )
    .await?;
    let bob = sub(&sandbox_root, "bob", 100).await?;
    let shares: String = call(&bob, vault.id(), "deposit", json!({}), 50 * NEAR, 200)
        .await?
        .json::<Value>()
        .map(|v| v.as_str().map(String::from).unwrap_or(v.to_string()))?;
    let held: String = view(&worker, vault.id(), "ft_balance_of", json!({ "account_id": bob.id() })).await?;
    assert!(held.parse::<u128>()? > 0, "shares {shares} held {held}");
    let linear_held: String =
        view(&worker, linear.id(), "ft_balance_of", json!({ "account_id": vault.id() })).await?;
    assert!(linear_held.parse::<u128>()? >= 49 * NEAR, "LiNEAR {linear_held}");

    let order = call(&root, vault.id(), "rebalance", json!({}), 0, 300).await?;
    let ev = order.events("hedge_order");
    assert_eq!(ev.len(), 1, "logs: {:#?}", order.logs());
    // The digest is the mainnet form (agent source "a"), recomputed independently here.
    let o = &ev[0]["order"];
    let hl = parry_common::hyperliquid::HlOrder {
        asset_index: o["asset_index"].as_u64().unwrap() as u32,
        is_buy: o["is_buy"].as_bool().unwrap(),
        price: o["price"].as_str().unwrap().into(),
        size: o["size"].as_str().unwrap().into(),
        reduce_only: o["reduce_only"].as_bool().unwrap(),
        tif: o["tif"].as_str().unwrap().into(),
    };
    let digest =
        hex::encode(parry_common::hyperliquid::order_digest(&hl, ev[0]["nonce"].as_u64().unwrap(), true));
    assert_eq!(ev[0]["digest"].as_str().unwrap(), digest);
    assert_eq!(hl.asset_index, 74);

    call(
        &bob,
        linear.id(),
        "storage_deposit",
        json!({ "account_id": bob.id(), "registration_only": true }),
        NEAR / 100,
        30,
    )
    .await?;
    call(
        &bob,
        usdc.id(),
        "storage_deposit",
        json!({ "account_id": bob.id(), "registration_only": true }),
        usdc_min,
        30,
    )
    .await?;
    call(&bob, vault.id(), "request_withdraw", json!({ "shares": held }), 1, 50).await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    published = published.max(now_secs()) + 1;
    call(&oracle, oracle.id(), "update_prices", feed(250_000_000, published), 0, 50).await?;
    let run1 = now_secs() * 1000 + 20;
    call(
        &risk,
        risk.id(),
        "submit",
        signed_report(&enclave, vault_report(run1, 1_000 * USDC, -(45 * 100_000_000)), run1),
        0,
        120,
    )
    .await?;
    let paid = call(&root, vault.id(), "process_withdrawals", json!({ "max": 4 }), 0, 300).await?;
    assert_eq!(paid.events("withdrawal_processed").len(), 1, "logs: {:#?}", paid.logs());
    let bob_linear: String =
        view(&worker, linear.id(), "ft_balance_of", json!({ "account_id": bob.id() })).await?;
    assert!(bob_linear.parse::<u128>()? >= 49 * NEAR, "bob's LiNEAR {bob_linear}");
    Ok(())
}
