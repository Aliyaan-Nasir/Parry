//! Hyperliquid's public info API: candles (for the Tremor index), mids, and an address's
//! clearinghouse state (perp positions and account value).

use crate::config;
use crate::io::{Io, Result};
use crate::risk::Sample;
use serde_json::{json, Value};

fn info(io: &dyn Io, body: &Value) -> Result<Value> {
    let raw = io.post(
        &format!("{}/info", config::HYPERLIQUID),
        &[("content-type", "application/json")],
        body.to_string().as_bytes(),
    )?;
    serde_json::from_slice(&raw).map_err(|e| format!("hyperliquid info: {e}"))
}

/// 5-minute closes of `coin` over the last 12 hours.
pub fn candles(io: &dyn Io, coin: &str, now: u64) -> Result<Vec<Sample>> {
    let v = info(
        io,
        &json!({ "type": "candleSnapshot", "req": { "coin": coin, "interval": "5m", "startTime": (now - 12 * 3600) * 1000, "endTime": now * 1000 } }),
    )?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    Some(Sample {
                        t: c["T"].as_f64()? / 1000.0,
                        price: c["c"].as_str()?.parse().ok()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

pub fn mid(io: &dyn Io, coin: &str) -> Result<Option<f64>> {
    let v = info(io, &json!({ "type": "allMids" }))?;
    Ok(v[coin].as_str().and_then(|s| s.parse().ok()))
}

#[derive(Clone, Debug, Default)]
pub struct Perp {
    /// Signed size in coins (negative = short).
    pub size: f64,
    pub entry: f64,
    pub liquidation: Option<f64>,
    pub unrealized: f64,
    /// Funding the position has received over the account's life on this coin (negative:
    /// paid). Hyperliquid's `cumFunding.allTime`, which does not restart when the position is
    /// closed and opened again.
    pub funding_all_time: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Clearinghouse {
    pub account_value: f64,
    /// Maintenance margin the cross account uses (`crossMaintenanceMarginUsed`).
    pub maintenance_margin: f64,
    pub perp: Option<Perp>,
}

impl Clearinghouse {
    /// Maintenance margin over account value in basis points (10000 is liquidation), 0 for an
    /// empty account.
    pub fn margin_ratio_bps(&self) -> u32 {
        if self.account_value <= 0.0 {
            return 0;
        }
        (self.maintenance_margin / self.account_value * 10_000.0)
            .round()
            .clamp(0.0, u32::MAX as f64) as u32
    }
}

pub fn clearinghouse(io: &dyn Io, address: &str, coin: &str) -> Result<Clearinghouse> {
    let v = info(
        io,
        &json!({ "type": "clearinghouseState", "user": address }),
    )?;
    let f = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
    let account_value = f(&v["marginSummary"]["accountValue"]).unwrap_or(0.0);
    let perp = v["assetPositions"].as_array().and_then(|a| {
        a.iter()
            .map(|p| &p["position"])
            .find(|p| p["coin"] == coin)
            .map(|p| Perp {
                size: f(&p["szi"]).unwrap_or(0.0),
                entry: f(&p["entryPx"]).unwrap_or(0.0),
                liquidation: f(&p["liquidationPx"]),
                unrealized: f(&p["unrealizedPnl"]).unwrap_or(0.0),
                // Hyperliquid reports funding paid as positive: received funding is its negative.
                funding_all_time: -f(&p["cumFunding"]["allTime"]).unwrap_or(0.0),
            })
    });
    Ok(Clearinghouse {
        account_value,
        maintenance_margin: f(&v["crossMaintenanceMarginUsed"]).unwrap_or(0.0),
        perp,
    })
}

/// USDC moved into `address`'s perp account minus USDC moved out: the margin the operator put
/// in, so that account value minus this is the hedge's own PnL and funding.
pub fn net_deposits(io: &dyn Io, address: &str) -> Result<f64> {
    let v = info(
        io,
        &json!({ "type": "userNonFundingLedgerUpdates", "user": address, "startTime": 0 }),
    )?;
    let f = |x: &Value| {
        x.as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let mut net = 0.0;
    for u in v.as_array().ok_or("ledger updates are not a list")? {
        let d = &u["delta"];
        match d["type"].as_str().unwrap_or("") {
            "deposit" => net += f(&d["usdc"]),
            "withdraw" => net -= f(&d["usdc"]) + f(&d["fee"]),
            "accountClassTransfer" => {
                net += if d["toPerp"] == true {
                    f(&d["usdc"])
                } else {
                    -f(&d["usdc"])
                }
            }
            "internalTransfer" | "send" => {
                let incoming = d["destination"]
                    .as_str()
                    .is_some_and(|x| x.eq_ignore_ascii_case(address));
                net += if incoming {
                    f(&d["usdc"])
                } else {
                    -f(&d["usdc"])
                };
            }
            _ => {}
        }
    }
    Ok(net)
}

/// The coin's current hourly funding rate and the distance of its mark from Hyperliquid's own
/// oracle price (a fraction).
pub fn funding_and_oracle(io: &dyn Io, coin: &str) -> Result<(f64, f64)> {
    let v = info(io, &json!({ "type": "metaAndAssetCtxs" }))?;
    let index = v[0]["universe"]
        .as_array()
        .and_then(|u| u.iter().position(|a| a["name"] == coin))
        .ok_or("coin not listed")?;
    let ctx = &v[1][index];
    let f = |x: &Value| {
        x.as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let (mark, oracle) = (f(&ctx["markPx"]), f(&ctx["oraclePx"]));
    Ok((
        f(&ctx["funding"]),
        if oracle > 0.0 {
            (mark - oracle).abs() / oracle
        } else {
            0.0
        },
    ))
}

/// The sum of `coin`'s hourly funding rates since `start_secs`, and how many there were. A
/// positive sum means longs paid shorts.
pub fn funding_sum(io: &dyn Io, coin: &str, start_secs: u64) -> Result<(f64, usize)> {
    let v = info(
        io,
        &json!({ "type": "fundingHistory", "coin": coin, "startTime": start_secs * 1000 }),
    )?;
    let rows = v.as_array().ok_or("funding history is not a list")?;
    let rates: Vec<f64> = rows
        .iter()
        .filter_map(|r| r["fundingRate"].as_str()?.parse::<f64>().ok())
        .filter(|r| r.is_finite())
        .collect();
    Ok((rates.iter().sum(), rates.len()))
}
