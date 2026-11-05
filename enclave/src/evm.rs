//! An Aave v3 position on an EVM chain, read with `eth_call` (`getUserAccountData`).

use crate::config;
use crate::io::{Io, Result};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Aave {
    pub collateral_usd: f64,
    pub debt_usd: f64,
    /// Health factor (Aave's 1e18 fixed point as a float).
    pub health: f64,
}

/// `getUserAccountData(address)` on `pool`; Aave's base currency is USD with 8 decimals.
pub fn account_data(io: &dyn Io, pool: &str, user: &str) -> Result<Aave> {
    let data = format!(
        "0xbf92857c{:0>64}",
        user.trim_start_matches("0x").to_lowercase()
    );
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{ "to": pool, "data": data }, "latest"] });
    let raw = io.post(
        config::EVM_RPC,
        &[("content-type", "application/json")],
        body.to_string().as_bytes(),
    )?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("eth_call: {e}"))?;
    let hex_out = v["result"]
        .as_str()
        .ok_or_else(|| format!("eth_call failed: {}", v["error"]))?;
    let words: Vec<u128> = (0..6)
        .map(|i| {
            let w = &hex_out.trim_start_matches("0x")[i * 64..(i + 1) * 64];
            // Values fit in u128 (the high half is zero for anything real; max health is u256::MAX).
            u128::from_str_radix(&w[32..], 16).unwrap_or(u128::MAX)
        })
        .collect();
    if words.len() < 6 {
        return Err("short getUserAccountData".into());
    }
    let health = if words[5] == u128::MAX {
        f64::INFINITY
    } else {
        words[5] as f64 / 1e18
    };
    Ok(Aave {
        collateral_usd: words[0] as f64 / 1e8,
        debt_usd: words[1] as f64 / 1e8,
        health,
    })
}
