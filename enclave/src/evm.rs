//! Aave v3 on an EVM chain (Base Sepolia on testnet), read with JSON-RPC: the position at the
//! person's Chain Signatures address, and what a repay from that address needs (its balance of
//! the debt asset, the pool's allowance, the nonce, the fees and the gas).

use crate::config;
use crate::io::{Io, Result};
use serde_json::{json, Value};

/// `getUserAccountData(address)`.
const SEL_ACCOUNT_DATA: &str = "bf92857c";
/// `balanceOf(address)`.
const SEL_BALANCE_OF: &str = "70a08231";
/// `allowance(address,address)`.
const SEL_ALLOWANCE: &str = "dd62ed3e";
/// `decimals()`.
const SEL_DECIMALS: &str = "313ce567";
/// The pool's `ADDRESSES_PROVIDER()`.
const SEL_ADDRESSES_PROVIDER: &str = "0542975c";
/// The provider's `getPriceOracle()`.
const SEL_PRICE_ORACLE: &str = "fca513a8";
/// The oracle's `getAssetPrice(address)` (USD, 8 decimals).
const SEL_ASSET_PRICE: &str = "b3596f07";
/// `approve(address,uint256)`.
pub const SEL_APPROVE: &str = "095ea7b3";
/// `repay(address,uint256,uint256,address)`.
pub const SEL_REPAY: &str = "573ade81";

/// Mirrors the account contract's caps (`parry_common::evm`), which refuse anything above them.
pub const MAX_GAS_LIMIT: u64 = 600_000;
pub const MAX_PRIORITY_FEE_WEI: u128 = 20_000_000_000;

#[derive(Clone, Debug)]
pub struct Aave {
    pub collateral_usd: f64,
    pub debt_usd: f64,
    /// The weighted liquidation threshold (0.83 for 83 %).
    pub liquidation_threshold: f64,
    /// Health factor (Aave's 1e18 fixed point as a float).
    pub health: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fees {
    pub priority: u128,
    pub max: u128,
}

fn rpc(io: &dyn Io, method: &str, params: Value) -> Result<Value> {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let raw = io.post(
        config::EVM_RPC,
        &[("content-type", "application/json")],
        body.to_string().as_bytes(),
    )?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("{method}: {e}"))?;
    if !v["error"].is_null() {
        return Err(format!(
            "{method}: {}",
            v["error"]["message"].as_str().unwrap_or("failed")
        ));
    }
    Ok(v["result"].clone())
}

/// A 0x address as a 32-byte ABI word (hex).
pub fn word_address(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_lowercase())
}

pub fn word_u128(v: u128) -> String {
    format!("{v:064x}")
}

fn call(io: &dyn Io, to: &str, data: &str) -> Result<Vec<u8>> {
    let out = rpc(
        io,
        "eth_call",
        json!([{ "to": to, "data": format!("0x{data}") }, "latest"]),
    )?;
    hex::decode(out.as_str().unwrap_or("").trim_start_matches("0x"))
        .map_err(|_| "eth_call: bad hex".into())
}

/// The low 128 bits of a word (amounts fit; a full-width word, like the health of a debt-free
/// account, reads as `u128::MAX`).
fn word(out: &[u8], i: usize) -> Result<u128> {
    let w = out
        .get(i * 32..(i + 1) * 32)
        .ok_or("short eth_call result")?;
    if w[..16].iter().any(|b| *b != 0) {
        return Ok(u128::MAX);
    }
    Ok(u128::from_be_bytes(w[16..].try_into().unwrap()))
}

fn address_at(out: &[u8]) -> Result<String> {
    let w = out.get(..32).ok_or("short eth_call result")?;
    Ok(format!("0x{}", hex::encode(&w[12..])))
}

fn quantity(v: &Value) -> Result<u128> {
    let s = v.as_str().ok_or("missing quantity")?;
    u128::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|_| format!("bad quantity {s}"))
}

/// `getUserAccountData(user)` on `pool`; Aave's base currency is USD with 8 decimals.
pub fn account_data(io: &dyn Io, pool: &str, user: &str) -> Result<Aave> {
    let out = call(
        io,
        pool,
        &format!("{SEL_ACCOUNT_DATA}{}", word_address(user)),
    )?;
    let health = word(&out, 5)?;
    Ok(Aave {
        collateral_usd: word(&out, 0)? as f64 / 1e8,
        debt_usd: word(&out, 1)? as f64 / 1e8,
        liquidation_threshold: word(&out, 3)? as f64 / 1e4,
        health: if health == u128::MAX {
            f64::INFINITY
        } else {
            health as f64 / 1e18
        },
    })
}

pub fn balance_of(io: &dyn Io, token: &str, owner: &str) -> Result<u128> {
    word(
        &call(
            io,
            token,
            &format!("{SEL_BALANCE_OF}{}", word_address(owner)),
        )?,
        0,
    )
}

pub fn allowance(io: &dyn Io, token: &str, owner: &str, spender: &str) -> Result<u128> {
    word(
        &call(
            io,
            token,
            &format!(
                "{SEL_ALLOWANCE}{}{}",
                word_address(owner),
                word_address(spender)
            ),
        )?,
        0,
    )
}

pub fn decimals(io: &dyn Io, token: &str) -> Result<u32> {
    let d = word(&call(io, token, SEL_DECIMALS)?, 0)?;
    if d > 36 {
        return Err("token decimals out of range".into());
    }
    Ok(d as u32)
}

/// The asset's USD price from the pool's own oracle (the one Aave liquidates with).
pub fn asset_price(io: &dyn Io, pool: &str, asset: &str) -> Result<f64> {
    let provider = address_at(&call(io, pool, SEL_ADDRESSES_PROVIDER)?)?;
    let oracle = address_at(&call(io, &provider, SEL_PRICE_ORACLE)?)?;
    let p = word(
        &call(
            io,
            &oracle,
            &format!("{SEL_ASSET_PRICE}{}", word_address(asset)),
        )?,
        0,
    )?;
    if p == 0 || p == u128::MAX {
        return Err("the pool's oracle has no price for the asset".into());
    }
    Ok(p as f64 / 1e8)
}

/// The next nonce, counting transactions still in the mempool.
pub fn nonce(io: &dyn Io, address: &str) -> Result<u64> {
    Ok(quantity(&rpc(
        io,
        "eth_getTransactionCount",
        json!([address, "pending"]),
    )?)? as u64)
}

pub fn native_balance(io: &dyn Io, address: &str) -> Result<u128> {
    quantity(&rpc(io, "eth_getBalance", json!([address, "latest"]))?)
}

/// The node's suggested tip (capped at the contract's limit) and a max fee of twice the latest
/// base fee plus the tip, which survives several full blocks.
pub fn fees(io: &dyn Io) -> Result<Fees> {
    let block = rpc(io, "eth_getBlockByNumber", json!(["latest", false]))?;
    let base = quantity(&block["baseFeePerGas"])?;
    let tip =
        quantity(&rpc(io, "eth_maxPriorityFeePerGas", json!([]))?)?.clamp(1, MAX_PRIORITY_FEE_WEI);
    Ok(Fees {
        priority: tip,
        max: base * 2 + tip,
    })
}

/// `eth_estimateGas` from `from` with 30 % headroom; an estimate that fails means the call would
/// revert, and the reason comes back as the error.
pub fn estimate_gas(io: &dyn Io, from: &str, to: &str, data: &str) -> Result<u64> {
    let g = quantity(&rpc(
        io,
        "eth_estimateGas",
        json!([{ "from": from, "to": to, "data": format!("0x{data}") }]),
    )?)?;
    let padded = (g as f64 * 1.3).ceil() as u64;
    if padded > MAX_GAS_LIMIT {
        return Err(format!(
            "the transaction needs {g} gas, above the guardian's {MAX_GAS_LIMIT}"
        ));
    }
    Ok(padded)
}

pub fn approve_data(spender: &str, amount: u128) -> String {
    format!(
        "{SEL_APPROVE}{}{}",
        word_address(spender),
        word_u128(amount)
    )
}

/// Aave v3 `repay(asset, amount, 2 = variable rate, on_behalf_of)`.
pub fn repay_data(asset: &str, amount: u128, on_behalf_of: &str) -> String {
    format!(
        "{SEL_REPAY}{}{}{}{}",
        word_address(asset),
        word_u128(amount),
        word_u128(2),
        word_address(on_behalf_of)
    )
}
