//! The whole Parry protect stack on a local sandbox node, wired as on testnet: the real lending
//! wasm (byte for byte mainnet's), the real exchange and wNEAR wasm from testnet, Parry's oracle,
//! test USDC, risk board, factory and protected-account code, and a stand-in MPC signer.
//!
//! Run `contracts/scripts/build.sh` and `contracts/scripts/fetch-fixtures.sh` first.

#![allow(dead_code)]

use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const USDC: u128 = 1_000_000;
pub const NEAR_USD: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
pub const USDC_USD: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

pub fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{}/../target/near/{name}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("missing {path}: run contracts/scripts/build.sh first"))
}

pub fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/../target/fixtures/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path)
        .unwrap_or_else(|_| panic!("missing {path}: run contracts/scripts/fetch-fixtures.sh first"))
}

pub fn code_hash(code: &[u8]) -> String {
    bs58::encode(Sha256::digest(code)).into_string()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// A successful transaction; receipt failures inside it are printed, not hidden.
pub struct Done(pub ExecutionFinalResult);

impl Done {
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        Ok(self.0.clone().json()?)
    }
    pub fn logs(&self) -> Vec<String> {
        self.0.logs().into_iter().map(String::from).collect()
    }
    pub fn has_log(&self, needle: &str) -> bool {
        self.logs().iter().any(|l| l.contains(needle))
    }
    /// Parsed NEP-297 events of the given name.
    pub fn events(&self, name: &str) -> Vec<Value> {
        self.logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .filter_map(|j| serde_json::from_str::<Value>(j).ok())
            .filter(|e| e["event"] == name)
            .map(|e| e["data"].clone())
            .collect()
    }
}

pub fn ok(r: ExecutionFinalResult) -> Result<Done> {
    if !r.is_success() {
        bail!("transaction failed: {:#?}", r.failures());
    }
    for f in r.receipt_failures() {
        eprintln!("receipt failure (tolerated): {:?}", f.clone().into_result().err());
    }
    Ok(Done(r))
}

/// The transaction's error text, or "ok" when it succeeded.
pub fn err(r: ExecutionFinalResult) -> String {
    if r.is_success() {
        return "ok".into();
    }
    format!("{:?}", r.failures())
}

pub async fn call(
    from: &Account,
    to: &AccountId,
    method: &str,
    args: Value,
    deposit: u128,
    tgas: u64,
) -> Result<Done> {
    ok(from
        .call(to, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

pub async fn try_call(
    from: &Account,
    to: &AccountId,
    method: &str,
    args: Value,
    deposit: u128,
    tgas: u64,
) -> Result<ExecutionFinalResult> {
    Ok(from
        .call(to, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?)
}

pub async fn view<T: serde::de::DeserializeOwned>(
    worker: &Worker<Sandbox>,
    id: &AccountId,
    method: &str,
    args: Value,
) -> Result<T> {
    Ok(worker.view(id, method).args_json(args).await?.json()?)
}

pub struct Stack {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub wrap: Contract,
    pub usdc: Contract,
    pub boost: Contract,
    pub oracle: Contract,
    pub dex: Contract,
    pub lending: Contract,
    pub risk: Contract,
    pub signer: Contract,
    pub factory: Contract,
    pub enclave: SigningKey,
    pub pool_id: u64,
    pub run_id: std::cell::Cell<u64>,
    pub published: std::cell::Cell<i64>,
}

async fn sub(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn deploy(root: &Account, name: &str, code: &[u8], near: u128) -> Result<Contract> {
    let acc = sub(root, name, near).await?;
    Ok(acc.deploy(code).await?.into_result()?)
}

pub fn ed25519_key(k: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(k.verifying_key().as_bytes()).into_string())
}

impl Stack {
    pub async fn new() -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let wrap = deploy(&root, "wrap", &fixture("wrap"), 50).await?;
        ok(wrap.call("new").args_json(json!({})).transact().await?)?;

        let token = wasm("parry_token");
        let usdc = deploy(&root, "usdc", &token, 10).await?;
        ok(usdc
            .call("new")
            .args_json(json!({
                "owner_id": root.id(), "name": "USD Coin (Parry test)", "symbol": "USDC", "decimals": 6,
                "icon": null, "faucet_amount": (1_000 * USDC).to_string(), "faucet_period_secs": 3600,
            }))
            .transact()
            .await?)?;
        let boost = deploy(&root, "boost", &token, 10).await?;
        ok(boost
            .call("new")
            .args_json(json!({
                "owner_id": root.id(), "name": "Booster (Parry test)", "symbol": "BOOST", "decimals": 18,
                "icon": null, "faucet_amount": "1", "faucet_period_secs": 3600,
            }))
            .transact()
            .await?)?;

        let oracle = deploy(&root, "oracle", &wasm("parry_oracle"), 10).await?;
        ok(oracle
            .call("new")
            .args_json(json!({ "owner_id": root.id(), "feeders": [root.id()], "network": "testnet", "max_shock_bps": 4000 }))
            .transact()
            .await?)?;

        let signer = deploy(&root, "signer", &wasm("parry_test_mock_signer"), 10).await?;

        let enclave = SigningKey::from_bytes(&[42u8; 32]);
        let risk = deploy(&root, "risk", &wasm("parry_risk"), 20).await?;
        ok(risk
            .call("new")
            .args_json(json!({ "owner_id": root.id(), "enclave_key": ed25519_key(&enclave), "wasm_sha256": "ab".repeat(32), "vault": null }))
            .transact()
            .await?)?;

        let dex = deploy(&root, "dex", &fixture("dex"), 50).await?;
        ok(dex
            .call("new")
            .args_json(json!({ "owner_id": root.id(), "boost_farm_id": root.id(), "burrowland_id": root.id(), "exchange_fee": 4, "referral_fee": 1 }))
            .transact()
            .await?)?;

        let lending = deploy(&root, "lending", &fixture("lending"), 60).await?;
        ok(lending
            .call("new")
            .args_json(json!({ "config": {
                "oracle_account_id": oracle.id(),
                "pyth_oracle_account_id": oracle.id(),
                "ref_exchange_id": dex.id(),
                "owner_id": root.id(),
                "booster_token_id": boost.id(),
                "booster_decimals": 18,
                "max_num_assets": 20,
                "maximum_recency_duration_sec": 90,
                "maximum_staleness_duration_sec": 90,
                "lp_tokens_info_valid_duration_sec": 600,
                "pyth_price_valid_duration_sec": 120,
                "minimum_staking_duration_sec": 2592000,
                "maximum_staking_duration_sec": 7776000,
                "x_booster_multiplier_at_maximum_staking_duration": 30000,
                "force_closing_enabled": true,
                "enable_price_oracle": false,
                "enable_pyth_oracle": true,
                "contract_mode": "Running",
                "boost_suppress_factor": 1000,
                "dcl_id": dex.id(),
                "pause_operator_id": null,
            }}))
            .transact()
            .await?)?;

        // The factory and the published account code.
        let publisher = deploy(&root, "code", &wasm("parry_test_publisher"), 80).await?;
        let account_code = wasm("parry_account");
        ok(publisher
            .call("publish")
            .args_json(json!({ "code": STANDARD.encode(&account_code) }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)?;
        let factory = deploy(&root, "accounts", &wasm("parry_accounts"), 20).await?;

        let mut s = Stack {
            worker,
            root,
            wrap,
            usdc,
            boost,
            oracle,
            dex,
            lending,
            risk,
            signer,
            factory,
            enclave,
            pool_id: 0,
            run_id: std::cell::Cell::new(now_secs() * 1000),
            published: std::cell::Cell::new(0),
        };
        ok(s.factory
            .call("new")
            .args_json(json!({
                "owner": s.root.id(), "network": "testnet", "protocol": s.protocol(),
                "account_code": code_hash(&account_code),
            }))
            .transact()
            .await?)?;
        s.setup_markets().await?;
        Ok(s)
    }

    /// The protocol config a protected account is born with.
    pub fn protocol(&self) -> Value {
        json!({
            "lending": self.lending.id(),
            "oracle": self.oracle.id(),
            "dex": self.dex.id(),
            "risk": self.risk.id(),
            "signer": self.signer.id(),
            "factory": format!("accounts.{}", self.root.id()),
            "tokens": [
                { "token_id": self.wrap.id(), "symbol": "wNEAR", "decimals": 24, "extra_decimals": 0,
                  "price_id": NEAR_USD, "rate_call": null, "mark": "NEAR" },
                { "token_id": self.usdc.id(), "symbol": "USDC", "decimals": 6, "extra_decimals": 12,
                  "price_id": USDC_USD, "rate_call": null, "mark": null },
            ],
        })
    }

    /// Prices, lending assets, liquidity and the wNEAR/USDC pool.
    async fn setup_markets(&mut self) -> Result<()> {
        self.feed(300_000_000).await?;
        let root = self.root.clone();
        let asset = |ratio: u32, extra: u8, rate: &str| {
            json!({
                "reserve_ratio": 2500, "beneficiaries": {}, "target_utilization": 8000,
                "target_utilization_rate": rate, "max_utilization_rate": "1000000000039724853136740579",
                "holding_position_fee_rate": "1000000000000000000000000000",
                "volatility_ratio": ratio, "extra_decimals": extra, "can_deposit": true, "can_withdraw": true,
                "can_use_as_collateral": true, "can_borrow": true, "net_tvl_multiplier": 0,
                "max_change_rate": null, "supplied_limit": "1000000000000000000000000000000000", "borrowed_limit": "1000000000000000000000000000000000", "min_borrowed_amount": "1000000000",
            })
        };
        let l = self.lending.id().clone();
        call(&root, &l, "add_asset", json!({ "token_id": self.wrap.id(), "asset_config": asset(7500, 0, "1000000000003593629036885046") }), 1, 50).await?;
        call(&root, &l, "add_asset", json!({ "token_id": self.usdc.id(), "asset_config": asset(9500, 12, "1000000000001847694955734069") }), 1, 50).await?;
        let pyth = |decimals: u8, id: &str| json!({ "decimals": decimals, "fraction_digits": 4, "price_identifier": id, "extra_call": null, "default_price": null });
        call(
            &root,
            &l,
            "add_token_pyth_info",
            json!({ "token_id": self.wrap.id(), "token_pyth_info": pyth(24, NEAR_USD) }),
            1,
            50,
        )
        .await?;
        call(
            &root,
            &l,
            "add_token_pyth_info",
            json!({ "token_id": self.usdc.id(), "token_pyth_info": pyth(6, USDC_USD) }),
            1,
            50,
        )
        .await?;

        // Root's test balances: USDC from the owner mint, wNEAR by wrapping.
        for t in [self.usdc.id().clone(), self.wrap.id().clone()] {
            for who in [root.id().clone(), l.clone(), self.dex.id().clone()] {
                call(
                    &root,
                    &t,
                    "storage_deposit",
                    json!({ "account_id": who, "registration_only": true }),
                    NEAR / 50,
                    30,
                )
                .await?;
            }
        }
        call(
            &root,
            self.usdc.id(),
            "mint",
            json!({ "account_id": root.id(), "amount": (1_000_000 * USDC).to_string() }),
            1,
            30,
        )
        .await?;
        call(&root, self.wrap.id(), "near_deposit", json!({}), 2_000 * NEAR, 30).await?;

        // Lending liquidity: root supplies USDC that borrowers draw on.
        call(&root, &l, "storage_deposit", json!({ "account_id": root.id() }), NEAR / 4, 30).await?;
        call(
            &root,
            self.usdc.id(),
            "ft_transfer_call",
            json!({ "receiver_id": l, "amount": (200_000 * USDC).to_string(), "msg": "" }),
            1,
            150,
        )
        .await?;

        // The wNEAR/USDC pool at $3.00 with deep liquidity.
        let d = self.dex.id().clone();
        call(
            &root,
            &d,
            "extend_whitelisted_tokens",
            json!({ "tokens": [self.wrap.id(), self.usdc.id()] }),
            1,
            30,
        )
        .await?;
        call(
            &root,
            &d,
            "storage_deposit",
            json!({ "account_id": root.id(), "registration_only": false }),
            NEAR,
            30,
        )
        .await?;
        let pool: u64 = call(
            &root,
            &d,
            "add_simple_pool",
            json!({ "tokens": [self.wrap.id(), self.usdc.id()], "fee": 25 }),
            NEAR / 10,
            50,
        )
        .await?
        .json()?;
        self.pool_id = pool;
        call(&root, &d, "register_tokens", json!({ "token_ids": [self.wrap.id(), self.usdc.id()] }), 1, 30)
            .await?;
        call(
            &root,
            self.wrap.id(),
            "ft_transfer_call",
            json!({ "receiver_id": d, "amount": (1_000 * NEAR).to_string(), "msg": "" }),
            1,
            100,
        )
        .await?;
        call(
            &root,
            self.usdc.id(),
            "ft_transfer_call",
            json!({ "receiver_id": d, "amount": (3_000 * USDC).to_string(), "msg": "" }),
            1,
            100,
        )
        .await?;
        call(
            &root,
            &d,
            "add_liquidity",
            json!({ "pool_id": pool, "amounts": [(1_000 * NEAR).to_string(), (3_000 * USDC).to_string()] }),
            NEAR / 100,
            100,
        )
        .await?;
        Ok(())
    }

    /// Feeds NEAR at `near_e8` (and USDC at $1) with the current time.
    pub async fn feed(&self, near_e8: i64) -> Result<()> {
        // Publish times must strictly increase; stay within the oracle's 60 s future bound.
        let t = (now_secs() as i64).max(self.published.get() + 1);
        self.published.set(t);
        call(&self.root, self.oracle.id(), "update_prices", json!({ "updates": [
            { "price_id": NEAR_USD, "price": near_e8.to_string(), "conf": "100000", "expo": -8, "publish_time": t },
            { "price_id": USDC_USD, "price": "100000000", "conf": "10000", "expo": -8, "publish_time": t },
        ]}), 0, 50).await?;
        Ok(())
    }

    /// Re-feeds the last NEAR price so the lending contract sees fresh prices.
    pub async fn refresh(&self) -> Result<()> {
        let p: Value =
            view(&self.worker, self.oracle.id(), "get_price_unsafe", json!({ "price_identifier": NEAR_USD }))
                .await?;
        let fed: i64 = p["price"].as_str().unwrap().parse()?;
        let shock: Value =
            view(&self.worker, self.oracle.id(), "shock_of", json!({ "price_id": NEAR_USD })).await?;
        let base = if shock.is_null() { fed } else { shock["fed_price"].as_str().unwrap().parse()? };
        self.feed(base).await
    }

    /// Signs and submits a risk-board report as the enclave would.
    pub async fn submit_report(&self, mut report: Value) -> Result<Done> {
        let id = self.run_id.get() + 1;
        self.run_id.set(id);
        report["run_id"] = json!(id);
        report["at"] = json!(now_secs());
        let text = report.to_string();
        let mut data = b"parry-risk:v1:".to_vec();
        data.extend_from_slice(text.as_bytes());
        let sig = self.enclave.sign(&Sha256::digest(&data));
        call(
            &self.root,
            self.risk.id(),
            "submit",
            json!({ "report_json": text, "signature": STANDARD.encode(sig.to_bytes()) }),
            0,
            100,
        )
        .await
    }

    /// Publishes a NEAR mark on the risk board (what the guards price with).
    pub async fn mark(&self, near_e8: u128) -> Result<()> {
        self.submit_report(json!({ "kind": "risk_update", "positions": [], "marks": [{ "asset": "NEAR", "asset_index": 54, "price_e8": near_e8.to_string() }] }))
            .await?;
        Ok(())
    }

    pub async fn user(&self, name: &str, near: u128) -> Result<Account> {
        sub(&self.root, name, near).await
    }

    /// Creates the protected account of a NEAR-account owner through the factory.
    pub async fn protected_account(&self, owner: &Account, deposit: u128) -> Result<AccountId> {
        let r = call(
            owner,
            self.factory.id(),
            "create_account",
            json!({ "near_account": owner.id() }),
            deposit,
            200,
        )
        .await?;
        for o in r.0.receipt_outcomes() {
            if o.is_failure() {
                eprintln!(
                    "creation receipt failed on {}: {:?}",
                    o.executor_id,
                    o.clone().into_result().err()
                );
            }
        }
        let id: Option<AccountId> = r.json()?;
        id.ok_or_else(|| anyhow::anyhow!("account creation failed: {:?}", r.logs()))
    }

    /// Runs owner actions on a protected account.
    pub async fn owner(
        &self,
        owner: &Account,
        account: &AccountId,
        actions: Value,
        tgas: u64,
    ) -> Result<Done> {
        call(owner, account, "owner_call", json!({ "actions": actions }), 1, tgas).await
    }

    /// An enclave-signed guardian envelope for `account`.
    pub fn envelope(
        &self,
        key: &SigningKey,
        account: &AccountId,
        nonce: u64,
        action: Value,
    ) -> (String, String) {
        let text = json!({
            "account": account, "network": "testnet", "nonce": nonce, "issued_at": now_secs(),
            "review_hash": "7c".repeat(32),
            "trigger": { "score": 82, "tier": "critical", "health_bps": 10_300 },
            "action": action,
        })
        .to_string();
        let mut data = b"parry-guardian:v1:".to_vec();
        data.extend_from_slice(text.as_bytes());
        let sig = key.sign(&Sha256::digest(&data));
        (text, STANDARD.encode(sig.to_bytes()))
    }

    pub async fn guardian(
        &self,
        relayer: &Account,
        key: &SigningKey,
        account: &AccountId,
        nonce: u64,
        action: Value,
        tgas: u64,
    ) -> Result<ExecutionFinalResult> {
        let (text, sig) = self.envelope(key, account, nonce, action);
        try_call(relayer, account, "guardian_execute", json!({ "envelope": text, "signature": sig }), 0, tgas)
            .await
    }

    /// Rhea's view of an account: (collateral wNEAR, borrowed USDC in inner units).
    pub async fn position(&self, account: &AccountId) -> Result<(u128, u128)> {
        let v: Value =
            view(&self.worker, self.lending.id(), "get_account", json!({ "account_id": account })).await?;
        let sum = |key: &str, token: &str| -> u128 {
            v[key].as_array().map_or(0, |a| {
                a.iter()
                    .filter(|l| l["token_id"] == token)
                    .map(|l| l["balance"].as_str().unwrap().parse::<u128>().unwrap())
                    .sum()
            })
        };
        Ok((sum("collateral", self.wrap.id().as_str()), sum("borrowed", self.usdc.id().as_str())))
    }

    /// Health factor in bps, computed like the account contract does (volatility ratios 0.75
    /// for wNEAR and 0.95 for USDC).
    pub async fn health_bps(&self, account: &AccountId, near_e8: u128) -> Result<u128> {
        let (c, b) = self.position(account).await?;
        if b == 0 {
            return Ok(u128::MAX);
        }
        let collateral = c * near_e8 / 100_000_000 * 7500 / 10_000 / 1_000_000; // 1e24 → 1e18
        let debt = b * 10_000 / 9500;
        Ok(collateral * 10_000 / debt)
    }
}
