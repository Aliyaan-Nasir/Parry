//! NEAR RPC views and the contract data the enclave reads.

use crate::config;
use crate::io::{Io, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub fn view<T: DeserializeOwned>(
    io: &dyn Io,
    account: &str,
    method: &str,
    args: &Value,
) -> Result<T> {
    let body = json!({
        "jsonrpc": "2.0", "id": "parry", "method": "query",
        "params": { "request_type": "call_function", "finality": "final", "account_id": account,
                    "method_name": method, "args_base64": STANDARD.encode(args.to_string()) },
    });
    let raw = io.post(
        config::RPC,
        &[("content-type", "application/json")],
        body.to_string().as_bytes(),
    )?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("rpc {method}: {e}"))?;
    if let Some(err) = v.get("error").or_else(|| v["result"].get("error")) {
        return Err(format!(
            "rpc {account}.{method}: {}",
            err.to_string().chars().take(200).collect::<String>()
        ));
    }
    let bytes: Vec<u8> = serde_json::from_value(v["result"]["result"].clone())
        .map_err(|e| format!("rpc {method} result: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("rpc {account}.{method} json: {e}"))
}

/// A Pyth price as a float, None when missing or older than `max_age` seconds.
pub fn oracle_price(io: &dyn Io, price_id: &str, max_age: u64) -> Result<Option<f64>> {
    let p: Option<Value> = view(
        io,
        config::ORACLE,
        "get_price_no_older_than",
        &json!({ "price_id": price_id, "age": max_age }),
    )?;
    Ok(p.and_then(|p| {
        let price: f64 = p["price"].as_str()?.parse().ok()?;
        let expo = p["expo"].as_i64()?;
        Some(price * 10f64.powi(expo as i32))
    }))
}

/// Rhea's view of an account, in whole tokens: (wNEAR collateral, USDC debt).
pub struct Lending {
    pub collateral_near: f64,
    pub debt_usd: f64,
    pub near_ratio: f64,
    pub usdc_ratio: f64,
}

pub fn lending(io: &dyn Io, account: &str) -> Result<Option<Lending>> {
    let v: Option<Value> = view(
        io,
        config::LENDING,
        "get_account",
        &json!({ "account_id": account }),
    )?;
    let Some(v) = v else { return Ok(None) };
    let sum = |key: &str, token: &str, decimals: i32| -> f64 {
        v[key].as_array().map_or(0.0, |a| {
            a.iter()
                .filter(|l| l["token_id"] == token)
                .filter_map(|l| l["balance"].as_str()?.parse::<f64>().ok())
                .sum::<f64>()
                / 10f64.powi(decimals)
        })
    };
    let ratio = |token: &str| -> Result<f64> {
        let a: Value = view(
            io,
            config::LENDING,
            "get_asset",
            &json!({ "token_id": token }),
        )?;
        Ok(a["config"]["volatility_ratio"].as_f64().unwrap_or(0.0) / 10_000.0)
    };
    Ok(Some(Lending {
        collateral_near: sum("collateral", config::WNEAR, 24),
        // USDC inner units: 6 decimals plus 12 extra.
        debt_usd: sum("borrowed", config::USDC, 18),
        near_ratio: ratio(config::WNEAR)?,
        usdc_ratio: ratio(config::USDC)?,
    }))
}

pub fn ft_balance(io: &dyn Io, token: &str, account: &str) -> Result<u128> {
    let b: String = view(
        io,
        token,
        "ft_balance_of",
        &json!({ "account_id": account }),
    )?;
    b.parse().map_err(|_| "bad balance".into())
}

/// The account's mandate view (`mandate()` on the protected account), or None.
pub fn mandate(io: &dyn Io, account: &str) -> Result<Option<Value>> {
    view(io, account, "mandate", &json!({}))
}

/// (owner nonce, guardian nonce).
pub fn nonces(io: &dyn Io, account: &str) -> Result<(u64, u64)> {
    view(io, account, "nonces", &json!({}))
}

/// The EVM address Chain Signatures derives for `predecessor` at `path` (domain 0).
pub fn derived_evm_address(io: &dyn Io, predecessor: &str, path: &str) -> Result<String> {
    let pk: String = view(
        io,
        config::SIGNER,
        "derived_public_key",
        &json!({ "path": path, "predecessor": predecessor, "domain_id": 0 }),
    )?;
    let raw = bs58::decode(pk.trim_start_matches("secp256k1:"))
        .into_vec()
        .map_err(|_| "bad derived key")?;
    let point = if raw.len() == 65 { &raw[1..] } else { &raw[..] };
    if point.len() != 64 {
        return Err("derived key is not an uncompressed secp256k1 point".into());
    }
    Ok(format!("0x{}", hex::encode(&crate::keccak256(point)[12..])))
}
