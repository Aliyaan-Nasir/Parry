//! What one run does. The caller's input chooses the mode and, for position modes, which
//! accounts to look at; everything else the enclave reads itself from the compiled-in sources.

use crate::ai::{self, Review};
use crate::chain::{self, Lending};
use crate::config;
use crate::io::{Io, Result};
use crate::plan::{self, Budgets, Position, Step};
use crate::risk::{self, Assessment};
use crate::seal::{self, Policy};
use crate::{evm, hl, reserves, sha256};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

pub const RISK_DOMAIN: &[u8] = b"parry-risk:v1:";
pub const ENVELOPE_DOMAIN: &[u8] = b"parry-guardian:v1:";
const PATH_HL: &str = "parry-hyperliquid";
const PATH_VAULT: &str = "parry-vault-hedge";
const PATH_EVM: &str = "parry-evm";
/// How old the oracle price the guardian acts on may be.
const PRICE_MAX_AGE: u64 = 300;
const MAX_ACCOUNTS: usize = 25;

fn signed(io: &dyn Io, domain: &[u8], json_text: &str) -> Result<String> {
    let digest = sha256(&[domain, json_text.as_bytes()].concat());
    Ok(STANDARD.encode(io.sign(&digest)?))
}

pub fn public_key(io: &dyn Io) -> Result<String> {
    Ok(format!(
        "ed25519:{}",
        bs58::encode(io.public_key()?).into_string()
    ))
}

fn run_id(io: &dyn Io) -> u64 {
    io.now() * 1000
}

fn bps(x: f64) -> u32 {
    if !x.is_finite() {
        return 999_999;
    }
    (x * 10_000.0).round().clamp(0.0, 999_999.0) as u32
}

fn ttl_secs(a: &Assessment) -> u64 {
    // Beyond the model's 30-day horizon: one second past it.
    a.ttl_hours
        .map_or(30 * 86_400 + 1, |h| (h * 3600.0).round() as u64)
}

fn e8(x: f64) -> String {
    format!("{}", (x * 1e8).round() as u128)
}

fn i_e6(x: f64) -> String {
    format!("{}", (x * 1e6).round() as i128)
}

/// NEAR price history for the Tremor index: Hyperliquid's 5-minute closes, rescaled onto the
/// oracle price so the volatility is the market's while the level is the one lending uses.
fn history(io: &dyn Io, price: f64) -> Vec<risk::Sample> {
    let candles = hl::candles(io, "NEAR", io.now()).unwrap_or_default();
    let last = candles.last().map(|c| c.price).filter(|p| *p > 0.0);
    match last {
        Some(last) => candles
            .into_iter()
            .map(|c| risk::Sample {
                t: c.t,
                price: c.price * price / last,
            })
            .collect(),
        None => vec![],
    }
}

/// The protected accounts named in the input, deduplicated and bounded.
fn accounts(input: &Value) -> Vec<String> {
    let mut out: Vec<String> = input["accounts"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out.truncate(MAX_ACCOUNTS);
    out
}

pub fn run(io: &dyn Io, input: &Value) -> Result<Value> {
    match input["mode"].as_str().unwrap_or("") {
        "keys" => keys(io),
        "risk_update" => risk_update(io, input),
        "guardian" => guardian(io, input),
        "vault_report" => vault_report(io),
        "certificate" => certificate(io, input),
        other => Err(format!("unknown mode {other:?}")),
    }
}

/// The enclave's signing key and sealing key, with a signed `sealing_key` report.
fn keys(io: &dyn Io) -> Result<Value> {
    let sealing = hex::encode(seal::public_key(io)?);
    let report = json!({ "kind": "sealing_key", "run_id": run_id(io), "at": io.now(), "public_key": sealing }).to_string();
    Ok(json!({
        "public_key": public_key(io)?,
        "sealing_public_key": sealing,
        "report_json": report,
        "signature": signed(io, RISK_DOMAIN, &report)?,
    }))
}

struct Seen {
    lending: Option<Lending>,
    assessment: Option<Assessment>,
}

fn look(io: &dyn Io, account: &str, price: f64, hist: &[risk::Sample]) -> Result<Seen> {
    let lending = chain::lending(io, account)?;
    let assessment = lending.as_ref().filter(|l| l.debt_usd > 0.0).map(|l| {
        risk::assess_lending(
            l.collateral_near,
            l.debt_usd,
            price,
            l.near_ratio,
            l.usdc_ratio,
            hist,
            io.now() as f64,
        )
    });
    Ok(Seen {
        lending,
        assessment,
    })
}

/// Scores every named account's positions and publishes the marks the guards price with.
fn risk_update(io: &dyn Io, input: &Value) -> Result<Value> {
    let price = chain::oracle_price(io, config::NEAR_USD, PRICE_MAX_AGE)?
        .ok_or("no fresh NEAR price on the oracle")?;
    let hist = history(io, price);
    let mut positions = vec![];
    let mut details = vec![];
    let mut warnings = vec![];
    for account in accounts(input) {
        match look(io, &account, price, &hist) {
            Ok(Seen {
                assessment: Some(a),
                lending: Some(l),
            }) => {
                positions.push(json!({
                    "account": account, "venue": "rhea", "position": "main", "score": a.score, "tier": risk::tier(a.score),
                    "health_bps": bps(a.health), "ttl_secs": ttl_secs(&a), "p24_bps": bps(a.p24),
                }));
                details.push(json!({
                    "account": account, "venue": "rhea", "collateral_near": l.collateral_near, "debt_usd": l.debt_usd,
                    "health": if a.health.is_finite() { json!(a.health) } else { Value::Null },
                    "liq_price": a.liq_price, "p24": a.p24, "ttl_hours": a.ttl_hours, "score": a.score,
                    "sigma_hourly": a.sigma, "annual_vol": a.annual, "trend_hourly": a.trend,
                }));
            }
            Ok(_) => {}
            Err(e) => warnings.push(format!("{account}: {e}")),
        }
    }
    let mut marks = vec![
        json!({ "asset": "NEAR", "asset_index": config::hl_near_index(), "price_e8": e8(price) }),
    ];
    if let Ok(Some(mid)) = hl::mid(io, "NEAR") {
        marks.push(json!({ "asset": "NEAR-HL", "asset_index": config::hl_near_index(), "price_e8": e8(mid) }));
    }
    let report = json!({ "kind": "risk_update", "run_id": run_id(io), "at": io.now(), "positions": positions, "marks": marks }).to_string();
    let (sigma, fallback) = risk::tremor(&hist, io.now() as f64);
    Ok(json!({
        "report_json": report,
        "signature": signed(io, RISK_DOMAIN, &report)?,
        "details": details,
        "tremor": { "sigma_hourly": sigma, "annual": sigma * risk::HOURS_PER_YEAR.sqrt(), "fallback": fallback, "samples": hist.len() },
        "warnings": warnings,
    }))
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// What the mandate still allows of `token` today: min(reserve left, daily left).
fn allowance(m: &Value, token: &str, from_reserve: bool) -> u128 {
    let limit = m["mandate"]["limits"]
        .as_array()
        .and_then(|a| a.iter().find(|l| l["token"] == token));
    let Some(limit) = limit else { return 0 };
    let used = |key: &str| -> u128 {
        m[key]
            .as_array()
            .and_then(|a| a.iter().find(|p| p[0] == token))
            .map_or(0, |p| u128_of(&p[1]))
    };
    let daily_left = u128_of(&limit["daily"]).saturating_sub(used("moved_today"));
    if from_reserve {
        daily_left.min(u128_of(&limit["reserve"]).saturating_sub(used("spent")))
    } else {
        daily_left
    }
}

fn has_power(m: &Value, p: &str) -> bool {
    m["mandate"]["powers"]
        .as_array()
        .is_some_and(|a| a.iter().any(|x| x == p))
}

struct Decided {
    venue: &'static str,
    action: Value,
    action_name: &'static str,
    plan: String,
    /// The position the plan acts on, for the review (the lending position when absent).
    position: Option<Value>,
    /// `{ step, why, skipped: [{ step, reason }] }`, set by `choose`.
    explanation: Value,
}

/// What one step of the owner's order came to.
enum Outcome {
    Act(Box<Decided>, Assessment),
    /// Skipped for `reason`; `at_risk` when its venue's position needed help (at or past the
    /// owner's trigger and under the target), so the skip is worth reporting.
    Skip {
        reason: String,
        at_risk: bool,
    },
}

fn skip(reason: &str, at_risk: bool) -> Result<Outcome> {
    Ok(Outcome::Skip {
        reason: reason.to_string(),
        at_risk,
    })
}

/// The account's token balances, read once and only when a lending step needs them.
struct Balances<'a> {
    io: &'a dyn Io,
    account: &'a str,
    usdc: std::cell::OnceCell<u128>,
    wnear: std::cell::OnceCell<u128>,
}

impl Balances<'_> {
    fn usdc(&self) -> u128 {
        *self
            .usdc
            .get_or_init(|| chain::ft_balance(self.io, config::USDC, self.account).unwrap_or(0))
    }
    fn wnear(&self) -> u128 {
        *self
            .wnear
            .get_or_init(|| chain::ft_balance(self.io, config::WNEAR, self.account).unwrap_or(0))
    }
}

/// One Rhea step (`repay`, `add_collateral` or `deleverage`) sized to land on the target.
fn lending_step(
    kind: &str,
    m: &Value,
    policy: &Policy,
    seen: &Seen,
    balances: &Balances,
    price: f64,
) -> Result<Outcome> {
    let (Some(l), Some(a)) = (&seen.lending, &seen.assessment) else {
        return skip("no Rhea loan", false);
    };
    if a.score < policy.trigger_score && a.health > policy.trigger_health {
        return skip("the Rhea loan is not at the owner's trigger", false);
    }
    if a.health >= policy.target_health {
        return skip("the Rhea loan is already at the target health", false);
    }
    if !has_power(m, kind) {
        return skip("not granted by the mandate", true);
    }
    let p = Position {
        collateral: l.collateral_near,
        debt: l.debt_usd,
        price,
        c_ratio: l.near_ratio,
        d_ratio: l.usdc_ratio,
    };
    let target = policy.target_health;
    let health = |p: &Position| format!("{:.3}", p.health());
    let decided = |action: Value, action_name: &'static str, plan: String| {
        Ok(Outcome::Act(
            Box::new(Decided {
                venue: "rhea",
                action,
                action_name,
                plan,
                position: None,
                explanation: Value::Null,
            }),
            a.clone(),
        ))
    };
    match kind {
        "repay" => {
            let allowed = allowance(m, config::USDC, true);
            if allowed == 0 {
                return skip("no USDC reserve left today", true);
            }
            let held = balances.usdc();
            if held == 0 {
                return skip("the account holds no USDC", true);
            }
            let usd = plan::repay_usd(&p, target, allowed.min(held) as f64 / 1e6);
            if usd <= 0.0 {
                return skip("the repay rounds to nothing", true);
            }
            let after = Position {
                debt: p.debt - usd,
                ..p
            };
            decided(
                json!({ "repay": { "token": config::USDC, "amount": format!("{}", (usd * 1e6).round() as u128) } }),
                "repay",
                format!(
                    "Repay {usd:.2} USDC from the reserve: health {} to {} (target {target:.2}).",
                    health(&p),
                    health(&after)
                ),
            )
        }
        "add_collateral" => {
            let allowed = allowance(m, config::WNEAR, true);
            if allowed == 0 {
                return skip("no wNEAR reserve left today", true);
            }
            let held = balances.wnear();
            if held == 0 {
                return skip("the account holds no wNEAR", true);
            }
            let near = plan::add_collateral_near(&p, target, allowed.min(held) as f64 / 1e24);
            if near <= 0.0 {
                return skip("the top-up rounds to nothing", true);
            }
            let after = Position {
                collateral: p.collateral + near,
                ..p
            };
            decided(
                json!({ "add_collateral": { "token": config::WNEAR, "amount": format!("{}", (near * 1e4).round() as u128 * 10u128.pow(20)) } }),
                "add_collateral",
                format!(
                    "Add {near:.4} wNEAR collateral from the reserve: health {} to {} (target {target:.2}).",
                    health(&p),
                    health(&after)
                ),
            )
        }
        _ => {
            let slippage = m["mandate"]["max_slippage_bps"]
                .as_u64()
                .unwrap_or(200)
                .min(300) as f64
                / 10_000.0;
            let budgets = Budgets {
                repay_usd: 0.0,
                collateral_near: 0.0,
                deleverage_near: allowance(m, config::WNEAR, false) as f64 / 1e24,
                slippage,
                withdraw_floor: 1.01,
            };
            let (near, min_out_usd) =
                match plan::deleverage(&p, target, &budgets) {
                    Ok(Step::Deleverage { near, min_out_usd }) => (near, min_out_usd),
                    Ok(_) => return skip("nothing to sell", true),
                    Err(plan::DeleverageLimit::Budget) => {
                        return skip("the daily cap leaves no wNEAR to sell", true)
                    }
                    Err(plan::DeleverageLimit::Floor) => return skip(
                        "health is too close to 1 for the lending contract to release collateral",
                        true,
                    ),
                };
            let pool: u64 = config::DEX_POOL
                .parse()
                .map_err(|_| "no exchange pool configured")?;
            let after = Position {
                collateral: p.collateral - near,
                debt: p.debt - min_out_usd,
                ..p
            };
            decided(
                json!({ "deleverage": {
                    "collateral": config::WNEAR, "amount": format!("{}", (near * 1e4).round() as u128 * 10u128.pow(20)),
                    "pool_id": pool, "debt": config::USDC, "min_out": format!("{}", (min_out_usd * 1e6).floor() as u128),
                }}),
                "deleverage",
                format!(
                    "Sell {near:.4} NEAR of collateral for at least {min_out_usd:.2} USDC and repay: health {} to at least {} (target {target:.2}).",
                    health(&p),
                    health(&after)
                ),
            )
        }
    }
}

/// A reduce-only Hyperliquid order sized so the perp's liquidation distance gives the target
/// health, inside the guard.
fn hyperliquid_step(io: &dyn Io, account: &str, m: &Value, policy: &Policy) -> Result<Outcome> {
    if !has_power(m, "hl_reduce") {
        return skip("not granted by the mandate", false);
    }
    if m["mandate"]["hl"].is_null() {
        return skip("the mandate has no Hyperliquid guard", false);
    }
    let address = chain::derived_evm_address(io, account, PATH_HL)?;
    let state = hl::clearinghouse(io, &address, "NEAR")?;
    let Some(perp) = state.perp.filter(|p| p.size != 0.0) else {
        return skip("no Hyperliquid position", false);
    };
    let Some(mid) = hl::mid(io, "NEAR")? else {
        return skip("no Hyperliquid mark", false);
    };
    let candles = hl::candles(io, "NEAR", io.now()).unwrap_or_default();
    let (sigma, _) = risk::tremor(&candles, io.now() as f64);
    let long = perp.size > 0.0;
    let (px, liq) = if long {
        (mid, perp.liquidation)
    } else {
        (1.0 / mid, perp.liquidation.map(|l| 1.0 / l))
    };
    let view = plan::Perp {
        size: perp.size.abs(),
        long,
        mark: mid,
        account_value: state.account_value,
        liquidation: perp.liquidation,
    };
    let p24 = risk::probability(px, liq, sigma, 0.0, 24.0);
    let health = plan::perp_health(&view);
    let annual = sigma * risk::HOURS_PER_YEAR.sqrt();
    let score = risk::score(health, p24, annual, 0.0);
    let a = Assessment {
        health,
        liq_price: perp.liquidation,
        sigma,
        annual,
        trend: 0.0,
        p24,
        ttl_hours: risk::median_hours(px, liq, sigma, 0.0),
        score,
    };
    if score < policy.trigger_score {
        return skip(
            "the Hyperliquid position is not at the owner's trigger",
            false,
        );
    }
    if health >= policy.target_health {
        return skip(
            "the Hyperliquid position is already at the target health",
            false,
        );
    }
    let lot = config::HL_SZ_DECIMALS as i32;
    let max_size = plan::floor_to(
        u128_of(&m["mandate"]["hl"]["max_size_e8"]) as f64 / 1e8,
        lot,
    );
    let (wanted, how) = match plan::perp_reduce(&view, policy.target_health, lot) {
        Some(s) => (s, "sized to the target health"),
        None => (
            plan::floor_to(view.size * policy.hl_reduce_fraction, lot),
            "the owner's fraction, as the venue gives no liquidation price to size from",
        ),
    };
    let size = wanted.min(max_size).min(view.size);
    if size <= 0.0 {
        return skip("the guard's size cap leaves nothing to reduce", true);
    }
    let band = m["mandate"]["hl"]["band_bps"].as_u64().unwrap_or(100) as f64 / 10_000.0;
    // Closing a long sells, closing a short buys; the limit sits half the band away from the mid.
    let limit = if long {
        mid * (1.0 - band / 2.0)
    } else {
        mid * (1.0 + band / 2.0)
    };
    let order = json!({
        "asset_index": config::hl_near_index(), "is_buy": !long,
        "price": hl_price(limit, !long), "size": trim(&format!("{size:.*}", lot as usize)),
        "reduce_only": true, "tif": "Ioc",
    });
    let capped = if size < wanted {
        ", capped by the guard"
    } else {
        ""
    };
    Ok(Outcome::Act(
        Box::new(Decided {
            venue: "hyperliquid",
            action: json!({ "hl_reduce": { "order": order, "nonce": io.now() * 1000 } }),
            action_name: "hl_reduce",
            position: Some(json!({ "venue": "hyperliquid", "size": perp.size, "entry": perp.entry, "liquidation": perp.liquidation, "mark": mid, "account_value": state.account_value })),
            explanation: Value::Null,
            plan: format!(
                "Reduce the Hyperliquid NEAR {} by {} (of {:.1}), reduce-only, near the mark {mid:.4} ({how}{capped}): health {health:.3}, target {:.2}.",
                if long { "long" } else { "short" },
                trim(&format!("{size:.*}", lot as usize)),
                view.size,
                policy.target_health
            ),
        }),
        a,
    ))
}

/// An Aave repay on the EVM chain from the person's own Chain Signatures address, when the
/// position is at risk: an approval of the pool first if the allowance is short, then the repay,
/// one per run. The repay is sized to the target health, within the guard's cap and the
/// address's balance.
fn evm_step(io: &dyn Io, account: &str, m: &Value, policy: &Policy) -> Result<Outcome> {
    let g = &m["mandate"]["evm"];
    if !has_power(m, "evm_repay") {
        return skip("not granted by the mandate", false);
    }
    if g.is_null() {
        return skip("the mandate has no EVM guard", false);
    }
    if g["chain_id"].as_u64() != Some(config::evm_chain_id()) {
        return Err(format!(
            "the EVM guard names chain {}, the guardian serves {}",
            g["chain_id"],
            config::EVM_CHAIN
        ));
    }
    let (pool, asset, address) = (
        g["pool"].as_str().unwrap_or(""),
        g["asset"].as_str().unwrap_or(""),
        g["address"].as_str().unwrap_or(""),
    );
    // Only the person's own position: the repay pays from, and on behalf of, their derived address.
    let own = chain::derived_evm_address(io, account, PATH_EVM)?;
    if !own.eq_ignore_ascii_case(address) {
        return Err(
            "the EVM guard's address is not this account's Chain Signatures address".into(),
        );
    }
    let aave = evm::account_data(io, pool, address)?;
    if aave.debt_usd <= 0.0 {
        return skip("no Aave loan", false);
    }
    let a = risk::assess_aave(aave.health);
    if a.score < policy.trigger_score && a.health > policy.evm_trigger_health {
        return skip("the Aave loan is not at the owner's trigger", false);
    }
    if a.health >= policy.target_health {
        return skip("the Aave loan is already at the target health", false);
    }
    let decimals = evm::decimals(io, asset)?;
    let price = evm::asset_price(io, pool, asset)?;
    // Health = collateral × threshold / debt, so the target needs debt down to collateral ×
    // threshold / target.
    let repay_usd = (aave.debt_usd
        - aave.collateral_usd * aave.liquidation_threshold / policy.target_health)
        .max(0.0);
    let needed = (repay_usd / price * 10f64.powi(decimals as i32)).ceil() as u128;
    let cap = u128_of(&g["max_amount"]);
    let balance = evm::balance_of(io, asset, address)?;
    let amount = needed.min(cap).min(balance);
    if amount == 0 {
        return skip(
            if balance == 0 {
                "the EVM address holds none of the debt asset to repay with"
            } else {
                "the repay rounds to zero"
            },
            true,
        );
    }
    let approved = evm::allowance(io, asset, address, pool)?;
    // Approve the repay plus 1 % for interest that accrues before it lands, never past the cap.
    let allowance = (amount + amount / 100).min(cap);
    let (kind, to, data, value) = if approved < amount {
        (
            "evm_approve",
            asset,
            evm::approve_data(pool, allowance),
            allowance,
        )
    } else {
        (
            "evm_repay",
            pool,
            evm::repay_data(asset, amount, address),
            amount,
        )
    };
    let gas_limit = evm::estimate_gas(io, address, to, &data)?;
    let fees = evm::fees(io)?;
    let gas_balance = evm::native_balance(io, address)?;
    if gas_balance < fees.max * gas_limit as u128 {
        return Err("the EVM address has too little ETH for gas".into());
    }
    let params = json!({
        "nonce": evm::nonce(io, address)?, "max_priority_fee_per_gas": fees.priority.to_string(),
        "max_fee_per_gas": fees.max.to_string(), "gas_limit": gas_limit,
    });
    let units = |x: u128| x as f64 / 10f64.powi(decimals as i32);
    let after = |repaid_usd: f64| {
        let debt = aave.debt_usd - repaid_usd;
        if debt <= 0.0 {
            f64::INFINITY
        } else {
            aave.collateral_usd * aave.liquidation_threshold / debt
        }
    };
    let plan = if kind == "evm_approve" {
        format!(
            "Approve the Aave pool to take up to {:.2} of the debt asset (${:.2}) from the person's own address (the repay plus 1% for interest), so the next run can repay {:.2} (${:.2}): health {:.3}, target {:.2}.",
            units(allowance), units(allowance) * price, units(amount), units(amount) * price, aave.health, policy.target_health
        )
    } else {
        format!(
            "Repay {:.2} of the Aave debt asset (${:.2}) from the person's own address: health {:.3} to {:.3} (target {:.2}).",
            units(amount), units(amount) * price, aave.health, after(units(amount) * price), policy.target_health
        )
    };
    Ok(Outcome::Act(
        Box::new(Decided {
            venue: "evm",
            action: json!({ kind: { "params": params, "amount": value.to_string() } }),
            action_name: kind,
            plan,
            position: Some(json!({
                "venue": "aave", "chain_id": config::evm_chain_id(), "collateral_usd": aave.collateral_usd, "debt_usd": aave.debt_usd,
                "liquidation_threshold": aave.liquidation_threshold, "health": aave.health,
                // The debt asset (the one repaid): amounts in the plan and the action are in it, not NEAR.
                "debt_asset": { "address": asset, "decimals": decimals, "price_usd": price, "balance": units(balance) },
            })),
            explanation: Value::Null,
        }),
        a,
    ))
}

/// The skipped steps in plain words, consecutive steps with the same reason joined:
/// "repay and add_collateral skipped: not granted by the mandate; deleverage skipped: ...".
fn skip_text(skips: &[(&str, String)]) -> String {
    let mut parts: Vec<String> = vec![];
    let mut i = 0;
    while i < skips.len() {
        let mut names = vec![skips[i].0];
        let mut j = i + 1;
        while j < skips.len() && skips[j].1 == skips[i].1 {
            names.push(skips[j].0);
            j += 1;
        }
        let who = match names.len() {
            1 => names[0].to_string(),
            n => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
        };
        parts.push(format!("{who} skipped: {}", skips[i].1));
        i = j;
    }
    parts.join("; ")
}

/// Cuts `s` to at most `max` characters, ending in "..." when cut.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

/// The longest plan a decision carries (the risk board takes 600 characters).
const MAX_PLAN_CHARS: usize = 560;

/// Walks the owner's step order and returns the first step that can act, its plan extended
/// with why it was chosen and why the earlier steps were not; None when no venue needs help,
/// an error naming every skip when one does but no allowed step can act.
fn choose(
    io: &dyn Io,
    account: &str,
    m: &Value,
    policy: &Policy,
    seen: &Seen,
    price: f64,
) -> Result<Option<(Decided, Assessment)>> {
    let order = policy.step_order();
    let balances = Balances {
        io,
        account,
        usdc: Default::default(),
        wnear: Default::default(),
    };
    let mut skips: Vec<(&str, String)> = vec![];
    let mut at_risk = false;
    for step in &order {
        let outcome = match *step {
            "repay" | "add_collateral" | "deleverage" => {
                lending_step(step, m, policy, seen, &balances, price)
            }
            "hl_reduce" => hyperliquid_step(io, account, m, policy),
            _ => evm_step(io, account, m, policy),
        };
        match outcome {
            Ok(Outcome::Act(mut d, a)) => {
                let chose = format!(
                    "Chose {step}: the first step in the order {} that the mandate allows and that moves health toward {:.2}.",
                    order.join(", "),
                    policy.target_health
                );
                let mut why = format!(" {chose}");
                if !skips.is_empty() {
                    why.push_str(&format!(" {}.", skip_text(&skips)));
                }
                d.plan = clip(&format!("{}{why}", d.plan), MAX_PLAN_CHARS);
                d.explanation = json!({
                    "step": step,
                    "why": chose,
                    "skipped": skips.iter().map(|(s, r)| json!({ "step": s, "reason": r })).collect::<Vec<_>>(),
                });
                return Ok(Some((*d, a)));
            }
            Ok(Outcome::Skip { reason, at_risk: r }) => {
                at_risk |= r;
                skips.push((step, reason));
            }
            Err(e) => {
                at_risk = true;
                skips.push((step, e));
            }
        }
    }
    if at_risk {
        Err(clip(
            &format!("no allowed step can act: {}", skip_text(&skips)),
            MAX_PLAN_CHARS,
        ))
    } else {
        Ok(None)
    }
}

fn trim(s: &str) -> String {
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s.to_string()
    }
}

/// Hyperliquid's perp price rules: 5 significant figures, at most 6 − szDecimals decimals.
fn hl_price(p: f64, round_up: bool) -> String {
    let max_dp = 6 - config::HL_SZ_DECIMALS as i32;
    let sig_dp = (4 - p.log10().floor() as i32).max(0);
    let dp = max_dp.min(sig_dp);
    let f = 10f64.powi(dp);
    let v = if round_up {
        (p * f - 1e-9).ceil() / f
    } else {
        (p * f + 1e-9).floor() / f
    };
    trim(&format!("{v:.*}", dp as usize))
}

/// Plans, reviews and signs at most one protective action per account.
fn guardian(io: &dyn Io, input: &Value) -> Result<Value> {
    let price = chain::oracle_price(io, config::NEAR_USD, PRICE_MAX_AGE)?
        .ok_or("no fresh NEAR price on the oracle")?;
    let hist = history(io, price);
    let me = public_key(io)?;
    let mut decisions = vec![];
    let mut skipped = vec![];
    for account in accounts(input) {
        let outcome = (|| -> Result<Option<Value>> {
            let Some(m) = chain::mandate(io, &account)? else {
                return Err("no mandate".into());
            };
            if m["mandate"]["guardian_key"] != me.as_str() {
                return Err("the mandate names another guardian key".into());
            }
            if m["expired"] == true || m["paused_until"].as_u64().unwrap_or(0) > io.now() {
                return Err("mandate expired or guardian paused".into());
            }
            let policy = match m["mandate"]["sealed"].as_str() {
                Some(b64) => seal::open(
                    io,
                    &STANDARD.decode(b64).map_err(|_| "bad sealed policy")?,
                    &account,
                )?,
                None => Policy::default(),
            };
            let seen = look(io, &account, price, &hist)?;
            let Some((decided, a)) = choose(io, &account, &m, &policy, &seen, price)? else {
                return Ok(None);
            };
            let (_, guardian_nonce) = chain::nonces(io, &account)?;
            let facts = json!({
                "account": account, "venue": decided.venue, "network": config::NETWORK,
                "position": decided.position.clone().or_else(|| seen.lending.as_ref().map(|l| json!({ "collateral_near": l.collateral_near, "debt_usd": l.debt_usd }))),
                "near_price_usd": price,
                "risk": { "score": a.score, "tier": risk::tier(a.score), "health": if a.health.is_finite() { json!(a.health) } else { Value::Null },
                          "liquidation_price": a.liq_price, "p_liquidation_24h": a.p24, "median_hours_to_liquidation": a.ttl_hours, "annual_volatility": a.annual },
                "target_health": policy.target_health,
                // The owner's own trigger, from the sealed policy: the guardian acts at or past it.
                "owner_trigger": { "score": policy.trigger_score, "health": if decided.venue == "evm" { policy.evm_trigger_health } else { policy.trigger_health } },
                "mandate_limits": m["mandate"]["limits"], "max_slippage_bps": m["mandate"]["max_slippage_bps"],
                "proposed_action": decided.action, "plan": decided.plan,
            });
            let review: Review = ai::review(io, &facts)?;
            let review_hash = review.hash();
            let mut out = json!({ "account": account, "venue": decided.venue, "plan": decided.plan, "action": decided.action, "explanation": decided.explanation, "review": review, "review_hash": review_hash, "facts": facts });
            if review.verdict != "approve" {
                out["outcome"] = json!("rejected by the review");
                return Ok(Some(out));
            }
            let trigger = json!({ "score": a.score, "tier": risk::tier(a.score), "health_bps": bps(a.health) });
            let envelope = json!({
                "account": account, "network": config::NETWORK, "nonce": guardian_nonce + 1, "issued_at": io.now(),
                "review_hash": review_hash, "trigger": trigger, "action": decided.action,
            })
            .to_string();
            let envelope_signature = signed(io, ENVELOPE_DOMAIN, &envelope)?;
            let envelope_hash = hex::encode(sha256(envelope.as_bytes()));
            let decision = json!({
                "kind": "decision", "run_id": run_id(io), "at": io.now(), "id": envelope_hash, "account": account,
                "venue": decided.venue, "trigger": trigger, "action": decided.action_name,
                "plan": decided.plan.chars().take(600).collect::<String>(), "envelope_hash": envelope_hash,
                "review": {
                    "model": review.model, "chat_id": review.chat_id, "review_hash": review_hash, "verdict": review.verdict,
                    "signing_address": review.signing_address, "reasoning_hash": hex::encode(sha256(review.reasoning.as_bytes())),
                },
            })
            .to_string();
            out["outcome"] = json!("approved");
            out["envelope"] = json!(envelope);
            out["envelope_signature"] = json!(envelope_signature);
            out["decision_json"] = json!(decision);
            out["decision_signature"] = json!(signed(io, RISK_DOMAIN, &decision)?);
            Ok(Some(out))
        })();
        match outcome {
            Ok(Some(d)) => decisions.push(d),
            Ok(None) => skipped.push(json!({ "account": account, "reason": "no action needed" })),
            Err(e) => skipped.push(json!({ "account": account, "reason": e })),
        }
    }
    Ok(json!({ "decisions": decisions, "skipped": skipped, "public_key": me }))
}

/// The vault's hedge ratio for its next rebalance and why: the full ratio while shorts are paid
/// (or the funding is unknown), leaning toward the minimum as 7-day funding turns against the
/// short, all the way at 20% a year paid.
pub fn hedge_ratio(max_bps: u32, min_bps: u32, funding_sum_7d: Option<f64>) -> (u32, String) {
    let min_bps = min_bps.min(max_bps);
    let pct = |bps: u32| format!("{}%", bps as f64 / 100.0);
    let Some(sum) = funding_sum_7d.filter(|s| s.is_finite()) else {
        return (
            max_bps,
            format!("funding history unavailable: full hedge {}", pct(max_bps)),
        );
    };
    let apr = sum * 365.0 / 7.0;
    if apr >= 0.0 {
        return (
            max_bps,
            format!(
                "7-day funding is {:+.1}% a year: shorts are paid, full hedge {}",
                apr * 100.0,
                pct(max_bps)
            ),
        );
    }
    let lean = (-apr / 0.20).clamp(0.0, 1.0);
    let raw = max_bps as f64 - (max_bps - min_bps) as f64 * lean;
    let ratio = (((raw / 100.0).floor() * 100.0) as u32).clamp(min_bps, max_bps);
    (
        ratio,
        format!(
            "7-day funding is {:+.1}% a year: shorts pay, hedge leans to {} (min {})",
            apr * 100.0,
            pct(ratio),
            pct(min_bps)
        ),
    )
}

/// The vault's insurance fund as `insurance()` reports it; all zero on a vault without the view.
fn insurance_view(io: &dyn Io) -> Result<Value> {
    match chain::view::<Value>(io, config::VAULT, "insurance", &json!({})) {
        Ok(v) => Ok(v),
        Err(e) if e.contains("MethodNotFound") || e.contains("MethodResolveError") => {
            Ok(Value::Null)
        }
        Err(e) => Err(e),
    }
}

/// The vault's hedge, reserves and risk score, signed for the risk board (which forwards it to
/// the vault).
fn vault_report(io: &dyn Io) -> Result<Value> {
    let price = chain::oracle_price(io, config::NEAR_USD, PRICE_MAX_AGE)?
        .ok_or("no fresh NEAR price on the oracle")?;
    let state: Value = chain::view(io, config::VAULT, "vault_state", &json!({}))?;
    let cfg: Value = chain::view(io, config::VAULT, "config", &json!({}))?;
    let insurance = insurance_view(io)?;
    let linear = chain::ft_balance(io, config::LINEAR, config::VAULT)?;
    let rate: String = chain::view(io, config::LINEAR, "ft_price", &json!({}))?;
    let rate = rate.parse::<f64>().unwrap_or(0.0) / 1e24;
    let buffer = chain::ft_balance(io, config::USDC, config::VAULT).unwrap_or(0);
    let address = chain::derived_evm_address(io, config::VAULT, PATH_VAULT)?;
    let ch = hl::clearinghouse(io, &address, "NEAR").unwrap_or_default();
    let perp = ch.perp.clone().unwrap_or_default();
    let mark = hl::mid(io, "NEAR")?.unwrap_or(0.0);
    let operator_margin = hl::net_deposits(io, &address)
        .unwrap_or(ch.account_value - perp.unrealized - perp.funding_all_time);

    // Funding-aware hedge ratio inside the vault's bounds.
    let max_ratio = cfg["hedge"]["hedge_ratio_bps"].as_u64().unwrap_or(9_000) as u32;
    let min_ratio = cfg["hedge_ratio_min_bps"]
        .as_u64()
        .map_or(DEFAULT_HEDGE_RATIO_MIN_BPS, |v| v as u32);
    let funding_7d = hl::funding_sum(io, "NEAR", io.now().saturating_sub(7 * 86_400))
        .ok()
        .filter(|(_, n)| *n > 0)
        .map(|(s, _)| s);
    let (hedge_ratio_bps, hedge_ratio_reason) = hedge_ratio(max_ratio, min_ratio, funding_7d);

    // What the vault holds that is not the depositors': the insurance fund and the margin it
    // earmarked, each in LiNEAR on NEAR and as USDC inside the hedge account.
    let fund_linear = u128_of(&insurance["linear"]);
    let fund_usdc = u128_of(&insurance["usdc_e6"]) as f64 / 1e6;
    let reserved_linear = u128_of(&insurance["margin_reserved_linear"]);
    let reserved_usdc = u128_of(&insurance["margin_reserved_usdc_e6"]) as f64 / 1e6;
    let linear_usd = |yocto: u128| yocto as f64 / 1e24 * rate * price;

    // Reserves on both venues against what the vault's own book says it owes.
    let own_linear = linear
        .saturating_sub(fund_linear)
        .saturating_sub(reserved_linear);
    let hedge_usd = (ch.account_value - operator_margin - fund_usdc - reserved_usdc).max(0.0);
    let fund_usd = linear_usd(fund_linear) + fund_usdc;
    let leaves = vec![
        reserves::Leaf {
            asset: "LiNEAR".into(),
            venue: "near".into(),
            amount: own_linear.to_string(),
            usd_e6: usd_e6(linear_usd(own_linear)),
        },
        reserves::Leaf {
            asset: "USDC".into(),
            venue: "near".into(),
            amount: buffer.to_string(),
            usd_e6: "0".into(),
        },
        reserves::Leaf {
            asset: "USDC".into(),
            venue: "hyperliquid".into(),
            amount: format!("{}", (ch.account_value * 1e6).max(0.0) as u128),
            usd_e6: usd_e6(hedge_usd),
        },
        reserves::Leaf {
            asset: "NEAR-PERP".into(),
            venue: "hyperliquid".into(),
            amount: e8_signed(perp.size),
            usd_e6: "0".into(),
        },
        reserves::Leaf {
            asset: "INSURANCE".into(),
            venue: "near".into(),
            amount: fund_linear.to_string(),
            usd_e6: usd_e6(fund_usd),
        },
    ];
    let root = reserves::root(&leaves);
    let total_usd = linear_usd(own_linear) + hedge_usd + fund_usd;
    // Liabilities leave the fund out: the depositors' LiNEAR and hedge equity, what waits as
    // claims, and the LiNEAR kept to back settled hedge losses.
    let book_linear = u128_of(&state["staked_linear"]);
    let settled = state["settled_pnl_e6"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        / 1e6;
    let liabilities = (linear_usd(book_linear)
        + (ch.account_value - operator_margin - settled - fund_usdc - reserved_usdc)
        + linear_usd(u128_of(&state["claims_linear"]))
        + u128_of(&state["claims_usdc_e6"]) as f64 / 1e6
        + linear_usd(u128_of(&state["loss_backing_linear"])))
    .max(0.0);
    let ratio = if liabilities > 0.0 {
        (total_usd / liabilities * 10_000.0).floor() as u32
    } else {
        10_000
    };

    // Vault risk components, each 0..10000 (bps of "fully risky").
    let liquidation = match perp.liquidation {
        Some(l) if perp.size < 0.0 && mark > 0.0 => {
            bps((1.0 - ((l / mark - 1.0) / 0.5)).clamp(0.0, 1.0))
        }
        _ => 0,
    };
    let leverage = if ch.account_value > 0.0 {
        perp.size.abs() * mark / ch.account_value
    } else {
        0.0
    };
    let margin = bps((leverage / 5.0).clamp(0.0, 1.0));
    let (funding_rate, oracle_dev) = hl::funding_and_oracle(io, "NEAR").unwrap_or((0.0, 0.0));
    // Shorts pay when funding is negative; one bp per hour paid counts fully.
    let funding = bps((-funding_rate / 0.0001).clamp(0.0, 1.0));
    let oracle = bps((oracle_dev / 0.02).clamp(0.0, 1.0));
    let book_rate = state["linear_rate_e24"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        / 1e24;
    let rate_drop = if book_rate > 0.0 {
        bps(((book_rate - rate) / book_rate / 0.01).clamp(0.0, 1.0))
    } else {
        0
    };
    let reserves_risk = bps(((10_000.0 - ratio as f64) / 500.0).clamp(0.0, 1.0));
    let score = ((0.35 * liquidation as f64
        + 0.25 * margin as f64
        + 0.1 * funding as f64
        + 0.1 * oracle as f64
        + 0.05 * rate_drop as f64
        + 0.15 * reserves_risk as f64)
        / 100.0)
        .round() as u8;

    let report = json!({
        "kind": "vault_report", "run_id": run_id(io), "at": io.now(), "vault": config::VAULT, "score": score.min(100),
        "components": { "liquidation_bps": liquidation, "margin_bps": margin, "funding_bps": funding, "oracle_bps": oracle, "rate_bps": rate_drop, "reserves_bps": reserves_risk },
        "hedge": {
            "asset_index": config::hl_near_index(), "size_e8": e8_signed(perp.size), "entry_e8": e8(perp.entry),
            "account_value_e6": format!("{}", (ch.account_value * 1e6).max(0.0) as u128), "unrealized_e6": i_e6(perp.unrealized),
            "funding_e6": i_e6(perp.funding_all_time), "margin_baseline_e6": format!("{}", (operator_margin * 1e6).max(0.0) as u128),
            "mark_e8": e8(mark), "liquidation_e8": e8(perp.liquidation.unwrap_or(0.0)),
        },
        "reserves": { "root": root, "leaves": leaves.len(), "total_usd_e6": usd_e6(total_usd), "liabilities_usd_e6": format!("{}", (liabilities * 1e6) as u128), "ratio_bps": ratio },
        "hedge_ratio_bps": hedge_ratio_bps,
        "hedge_ratio_reason": clip(&hedge_ratio_reason, MAX_REASON_CHARS),
        "margin_ratio": ch.margin_ratio_bps(),
    })
    .to_string();
    let leaves_json: Vec<Value> = leaves.iter().map(|l| json!({ "asset": l.asset, "venue": l.venue, "amount": l.amount, "usdE6": l.usd_e6 })).collect();
    Ok(
        json!({ "report_json": report, "signature": signed(io, RISK_DOMAIN, &report)?, "reserve_leaves": leaves_json, "hedge_address": address }),
    )
}

/// The deployed vault has no `hedge_ratio_min_bps` yet; this is the floor it starts with.
const DEFAULT_HEDGE_RATIO_MIN_BPS: u32 = 7_000;
const MAX_REASON_CHARS: usize = 280;

fn usd_e6(x: f64) -> String {
    format!("{}", (x * 1e6).max(0.0) as u128)
}

// ---------------------------------------------------------------------------------------------
// Health certificates
// ---------------------------------------------------------------------------------------------

pub const CERTIFICATE_DOMAIN: &[u8] = b"parry-certificate:v1:";

/// `sha256("parry-certificate:v1:" + certificate_json)`: what the enclave signs, and the
/// certificate's hash.
pub fn certificate_digest(certificate_json: &str) -> [u8; 32] {
    sha256(&[CERTIFICATE_DOMAIN, certificate_json.as_bytes()].concat())
}
const CERTIFICATE_VENUES: [&str; 3] = ["rhea", "hyperliquid", "evm"];
const MAX_READER_BYTES: usize = 128;
const MIN_TTL_SECS: u64 = 60;
const MAX_TTL_SECS: u64 = 30 * 86_400;

/// A signed statement that an account's health is at least a threshold, at one block. It says
/// nothing else about the position: no amounts, and not the health itself. Field order is the
/// order of the signed JSON.
#[derive(serde::Serialize)]
struct Certificate<'a> {
    kind: &'static str,
    version: u32,
    account: &'a str,
    reader: &'a str,
    venue: &'a str,
    /// A JSON number as JavaScript prints it: 2, not 2.0.
    threshold: Value,
    block_height: u64,
    block_hash: &'a str,
    issued_at: u64,
    expires_at: u64,
    statement: String,
}

/// The health of `account` on `venue` with the guardian's model, its NEAR reads at `block`.
/// Infinite without debt or without a position.
fn certified_health(io: &dyn Io, account: &str, venue: &str, block: &str) -> Result<f64> {
    match venue {
        "rhea" => {
            let price = chain::oracle_price_in(io, Some(block), config::NEAR_USD, PRICE_MAX_AGE)?
                .ok_or("no fresh NEAR price on the oracle")?;
            Ok(match chain::lending_in(io, Some(block), account)? {
                Some(l) if l.debt_usd > 0.0 => risk::health(
                    l.collateral_near,
                    l.debt_usd,
                    price,
                    l.near_ratio,
                    l.usdc_ratio,
                ),
                _ => f64::INFINITY,
            })
        }
        "hyperliquid" => {
            let address = chain::derived_evm_address(io, account, PATH_HL)?;
            let state = hl::clearinghouse(io, &address, "NEAR")?;
            let Some(perp) = state.perp.filter(|p| p.size != 0.0) else {
                return Ok(f64::INFINITY);
            };
            let mid = hl::mid(io, "NEAR")?.ok_or("no Hyperliquid mark")?;
            Ok(plan::perp_health(&plan::Perp {
                size: perp.size.abs(),
                long: perp.size > 0.0,
                mark: mid,
                account_value: state.account_value,
                liquidation: perp.liquidation,
            }))
        }
        _ => {
            let m = chain::mandate_in(io, Some(block), account)?.ok_or("no mandate")?;
            let g = &m["mandate"]["evm"];
            let (pool, address) = (
                g["pool"].as_str().ok_or("no EVM guard")?,
                g["address"].as_str().ok_or("no EVM guard")?,
            );
            // Only the account's own loan: a guard naming another address proves nothing.
            let own = chain::derived_evm_address(io, account, PATH_EVM)?;
            if !own.eq_ignore_ascii_case(address) {
                return Err("the EVM guard's address is not this account's".into());
            }
            let aave = evm::account_data(io, pool, address)?;
            Ok(if aave.debt_usd <= 0.0 {
                f64::INFINITY
            } else {
                aave.health
            })
        }
    }
}

/// Signs a health certificate for a reader, or refuses when health is under the threshold.
fn certificate(io: &dyn Io, input: &Value) -> Result<Value> {
    let account = input["account"]
        .as_str()
        .filter(|a| !a.is_empty() && a.len() <= 64)
        .ok_or("account must be a NEAR account id")?;
    let reader = input["reader"]
        .as_str()
        .filter(|r| !r.is_empty() && r.len() <= MAX_READER_BYTES)
        .ok_or("reader must be 1 to 128 bytes")?;
    let threshold = input["threshold"]
        .as_f64()
        .filter(|t| (1.0..=10.0).contains(t))
        .ok_or("threshold must be a number from 1 to 10")?;
    let threshold = (threshold * 1e4).round() / 1e4;
    let ttl = input["ttl_secs"]
        .as_u64()
        .filter(|t| (MIN_TTL_SECS..=MAX_TTL_SECS).contains(t))
        .ok_or("ttl_secs must be from 60 to 2592000")?;
    let venue = input["venue"]
        .as_str()
        .filter(|v| CERTIFICATE_VENUES.contains(v))
        .ok_or("venue must be rhea, hyperliquid or evm")?;

    let (block_height, block_hash) = chain::final_block(io)?;
    // Read errors say which venue failed, never what the position holds.
    let health = certified_health(io, account, venue, &block_hash)
        .map_err(|_| format!("could not read the {venue} position at block {block_height}"))?;
    if health.is_nan() || health < threshold {
        return Ok(json!({ "refused": "health is below the threshold" }));
    }
    let issued_at = io.now();
    let expires_at = issued_at + ttl;
    let threshold_text = trim(&format!("{threshold:.4}"));
    let cert = Certificate {
        kind: "parry-health-certificate",
        version: 1,
        account,
        reader,
        venue,
        threshold: if threshold.fract() == 0.0 {
            json!(threshold as u64)
        } else {
            json!(threshold)
        },
        block_height,
        block_hash: &block_hash,
        issued_at,
        expires_at,
        statement: format!("health is at least {threshold_text}"),
    };
    let certificate_json = serde_json::to_string(&cert).map_err(|e| e.to_string())?;
    // The certificate's hash everywhere (the board's key, the API, the SDK) is the digest the
    // enclave signs.
    let hash = hex::encode(certificate_digest(&certificate_json));
    let report_json = json!({
        "kind": "certificate", "run_id": run_id(io), "at": issued_at, "hash": hash, "reader": reader, "expires_at": expires_at,
    })
    .to_string();
    Ok(json!({
        "certificate_json": certificate_json,
        "signature": signed(io, CERTIFICATE_DOMAIN, &certificate_json)?,
        "public_key": public_key(io)?,
        "report_json": report_json,
        "report_signature": signed(io, RISK_DOMAIN, &report_json)?,
        "hash": hash,
    }))
}

fn e8_signed(x: f64) -> String {
    format!("{}", (x * 1e8).round() as i128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::Scripted;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use k256::ecdsa::SigningKey as EcKey;

    const ACCOUNT: &str = "0uaccount.testnet";

    fn rpc(value: &Value) -> String {
        json!({ "jsonrpc": "2.0", "id": "parry", "result": { "result": value.to_string().into_bytes() } }).to_string()
    }

    const ANSWER: &str = r#"{"id":"chatcmpl-1","choices":[{"message":{"content":"{\"verdict\":\"approve\",\"reasoning\":\"Health is near 1 and the repay is proportionate.\"}"}}]}"#;

    /// The mandate the base world's account holds, naming the key of `seed`.
    fn base_mandate(seed: u8) -> Value {
        let me = format!(
            "ed25519:{}",
            bs58::encode(
                ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
                    .verifying_key()
                    .to_bytes()
            )
            .into_string()
        );
        json!({
            "mandate": {
                "guardian_key": me, "powers": ["repay", "add_collateral", "deleverage"],
                "limits": [{ "token": config::USDC, "reserve": "200000000", "daily": "120000000" }],
                "max_actions_per_day": 10, "min_health_after_bps": 10500, "max_slippage_bps": 200, "hl": null, "evm": null,
                "sealed": null, "expires_at": 1_900_000_000u64,
            },
            "set_at": 1, "paused_until": 0, "expired": false, "spent": [], "moved_today": [], "actions_today": 0,
        })
    }

    fn base_world(seed: u8) -> Scripted {
        let mut w = Scripted {
            now: 1_800_000_000,
            seed: [5u8; 32],
            ..Default::default()
        };
        w.secrets.insert("NEARAI_API_KEY".into(), "test".into());
        let mandate = base_mandate(seed);
        w.respond(config::RPC, Some("\"method_name\":\"get_price_no_older_than\""), &rpc(&json!({ "price": "220000000", "conf": "1", "expo": -8, "publish_time": 1_800_000_000 })))
            .respond(config::RPC, Some("\"method_name\":\"mandate\""), &rpc(&mandate))
            .respond(config::RPC, Some("\"method_name\":\"get_account\""), &rpc(&json!({
                "collateral": [{ "token_id": config::WNEAR, "balance": "100000000000000000000000000" }],
                "borrowed": [{ "token_id": config::USDC, "balance": "150000000000000000000" }],
            })))
            .respond(config::RPC, Some("\"method_name\":\"get_asset\""), &rpc(&json!({ "config": { "volatility_ratio": 7500 } })))
            .respond(config::RPC, Some("\"method_name\":\"ft_balance_of\""), &rpc(&json!("60000000")))
            .respond(config::RPC, Some("\"method_name\":\"nonces\""), &rpc(&json!([0, 4])))
            .respond(&format!("{}/info", config::HYPERLIQUID), None, "[]")
            .respond(&format!("{}/chat/completions", config::NEARAI), None, ANSWER)
    }

    /// Signs `[model:]request_hash:response_hash` as a model TEE would (EIP-191, secp256k1).
    fn tee_signature(request_body: &[u8]) -> Value {
        let text = format!(
            "{}:{}:{}",
            config::MODEL,
            hex::encode(sha256(request_body)),
            hex::encode(sha256(ANSWER.as_bytes()))
        );
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", text.len(), text);
        let ec = EcKey::from_slice(&[9u8; 32]).unwrap();
        let (sig, recid) = ec
            .sign_prehash_recoverable(&crate::keccak256(prefixed.as_bytes()))
            .unwrap();
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(recid.to_byte() + 27);
        let address = format!(
            "0x{}",
            hex::encode(
                &crate::keccak256(&ec.verifying_key().to_encoded_point(false).as_bytes()[1..])
                    [12..]
            )
        );
        json!({ "text": text, "signature": format!("0x{}", hex::encode(bytes)), "signing_address": address, "signature_kind": "provider_tee" })
    }

    #[test]
    fn keys_mode_publishes_both_keys_with_a_signed_report() {
        let w = Scripted {
            now: 1_800_000_000,
            seed: [5u8; 32],
            ..Default::default()
        };
        let out = run(&w, &json!({ "mode": "keys" })).unwrap();
        let pk = VerifyingKey::from_bytes(
            &ed25519_dalek::SigningKey::from_bytes(&[5u8; 32])
                .verifying_key()
                .to_bytes(),
        )
        .unwrap();
        let report = out["report_json"].as_str().unwrap();
        let sig =
            Signature::from_slice(&STANDARD.decode(out["signature"].as_str().unwrap()).unwrap())
                .unwrap();
        pk.verify(&sha256(&[RISK_DOMAIN, report.as_bytes()].concat()), &sig)
            .unwrap();
        assert_eq!(out["sealing_public_key"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn a_sealed_policy_opens_only_for_its_account() {
        let w = Scripted {
            now: 1,
            seed: [5u8; 32],
            ..Default::default()
        };
        let pk = seal::public_key(&w).unwrap();
        let policy = Policy {
            trigger_score: 40,
            trigger_health: 1.2,
            target_health: 1.6,
            strategy: "keep-exposure".into(),
            hl_reduce_fraction: 0.5,
            evm_trigger_health: 1.3,
            steps: vec!["deleverage".into(), "repay".into()],
        };
        let sealed = seal::seal(&policy, ACCOUNT, &pk, [8u8; 32], [1u8; 12]);
        assert_eq!(seal::open(&w, &sealed, ACCOUNT).unwrap(), policy);
        assert!(seal::open(&w, &sealed, "0uother.testnet").is_err());
        let other = Scripted {
            seed: [6u8; 32],
            ..Default::default()
        };
        assert!(seal::open(&other, &sealed, ACCOUNT).is_err());
    }

    #[test]
    fn guardian_plans_reviews_and_signs_an_envelope_the_account_accepts() {
        let input = json!({ "mode": "guardian", "accounts": [ACCOUNT] });
        // Dry run without a signature endpoint: it fails closed, and shows the exact request.
        let dry = base_world(5);
        let out = run(&dry, &input).unwrap();
        assert!(
            out["decisions"].as_array().unwrap().is_empty(),
            "no envelope without a verified review"
        );
        assert!(out["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("signature"));
        let body = dry
            .log
            .borrow()
            .iter()
            .find(|(u, _)| u.ends_with("/chat/completions"))
            .unwrap()
            .1
            .clone();

        let w = base_world(5).respond(
            &format!("{}/signature/", config::NEARAI),
            None,
            &tee_signature(&body).to_string(),
        );
        let out = run(&w, &input).unwrap();
        let d = &out["decisions"][0];
        assert_eq!(d["outcome"], "approved", "{out}");
        // The explanation the services store with the decision.
        assert_eq!(d["explanation"]["step"], "repay");
        assert!(d["explanation"]["why"]
            .as_str()
            .unwrap()
            .starts_with("Chose repay: the first step"));
        assert_eq!(d["explanation"]["skipped"], json!([]));
        // The account contract's check: ed25519 over SHA-256("parry-guardian:v1:" || envelope).
        let envelope = d["envelope"].as_str().unwrap();
        let pk = VerifyingKey::from_bytes(
            &ed25519_dalek::SigningKey::from_bytes(&[5u8; 32])
                .verifying_key()
                .to_bytes(),
        )
        .unwrap();
        let sig = Signature::from_slice(
            &STANDARD
                .decode(d["envelope_signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        pk.verify(
            &sha256(&[ENVELOPE_DOMAIN, envelope.as_bytes()].concat()),
            &sig,
        )
        .unwrap();
        let e: Value = serde_json::from_str(envelope).unwrap();
        assert_eq!(e["nonce"], 5);
        assert_eq!(e["account"], ACCOUNT);
        assert_eq!(e["review_hash"], d["review_hash"]);
        let review: Review = serde_json::from_value(d["review"].clone()).unwrap();
        assert_eq!(review.hash(), d["review_hash"].as_str().unwrap());
        // Health 100 × 2.20 × 0.75 × 0.75 / 150 = 0.825 under the default trigger: repay toward 1.45,
        // capped by the 60 USDC balance.
        assert_eq!(e["action"]["repay"]["amount"], "60000000");
        // The decision record for the risk board is signed too.
        let dsig = Signature::from_slice(
            &STANDARD
                .decode(d["decision_signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        pk.verify(
            &sha256(&[RISK_DOMAIN, d["decision_json"].as_str().unwrap().as_bytes()].concat()),
            &dsig,
        )
        .unwrap();
    }

    #[test]
    fn guardian_skips_a_mandate_for_another_key() {
        let w = base_world(7);
        let out = run(&w, &json!({ "mode": "guardian", "accounts": [ACCOUNT] })).unwrap();
        assert!(out["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("another guardian key"));
    }

    /// A world with no lending position and an Aave loan on the EVM chain at the account's own
    /// derived address: 1000 USD of collateral at an 83 % threshold against 800 USD of debt.
    fn evm_world(allowance: u128, guard_address: Option<&str>) -> Scripted {
        let ec = EcKey::from_slice(&[3u8; 32]).unwrap();
        let point = ec.verifying_key().to_encoded_point(false);
        let derived = format!("secp256k1:{}", bs58::encode(point.as_bytes()).into_string());
        let address = format!(
            "0x{}",
            hex::encode(&crate::keccak256(&point.as_bytes()[1..])[12..])
        );
        let (pool, asset) = (
            format!("0x{}", "11".repeat(20)),
            format!("0x{}", "22".repeat(20)),
        );
        let me = public_key(&Scripted {
            seed: [5u8; 32],
            ..Default::default()
        })
        .unwrap();
        let mandate = json!({
            "mandate": {
                "guardian_key": me, "powers": ["evm_repay"], "limits": [], "max_actions_per_day": 10, "min_health_after_bps": 10500,
                "max_slippage_bps": 200, "hl": null, "sealed": null, "expires_at": 1_900_000_000u64,
                "evm": { "chain_id": 84532, "pool": pool, "asset": asset, "address": guard_address.unwrap_or(&address), "max_amount": "500000000" },
            },
            "set_at": 1, "paused_until": 0, "expired": false, "spent": [], "moved_today": [], "actions_today": 0,
        });
        let eth = |result: &str| json!({ "jsonrpc": "2.0", "id": 1, "result": result }).to_string();
        let words = |w: &[u128]| {
            eth(&format!(
                "0x{}",
                w.iter().map(|x| evm::word_u128(*x)).collect::<String>()
            ))
        };
        let addr = |a: &str| eth(&format!("0x{}", evm::word_address(a)));
        let w = base_world(5)
            .respond(
                config::RPC,
                Some("\"method_name\":\"mandate\""),
                &rpc(&mandate),
            )
            .respond(
                config::RPC,
                Some("\"method_name\":\"get_account\""),
                &rpc(&Value::Null),
            )
            .respond(
                config::RPC,
                Some("\"method_name\":\"derived_public_key\""),
                &rpc(&json!(derived)),
            )
            .respond(
                config::EVM_RPC,
                Some("bf92857c"),
                &words(&[
                    100_000_000_000,
                    80_000_000_000,
                    0,
                    8300,
                    8000,
                    1_037_500_000_000_000_000,
                ]),
            )
            .respond(config::EVM_RPC, Some("313ce567"), &words(&[6]))
            .respond(
                config::EVM_RPC,
                Some("0542975c"),
                &addr(&format!("0x{}", "33".repeat(20))),
            )
            .respond(
                config::EVM_RPC,
                Some("fca513a8"),
                &addr(&format!("0x{}", "44".repeat(20))),
            )
            .respond(config::EVM_RPC, Some("b3596f07"), &words(&[100_000_000]))
            .respond(config::EVM_RPC, Some("70a08231"), &words(&[300_000_000]))
            .respond(config::EVM_RPC, Some("dd62ed3e"), &words(&[allowance]))
            .respond(config::EVM_RPC, Some("eth_estimateGas"), &eth("0x30d40"))
            .respond(
                config::EVM_RPC,
                Some("eth_getBlockByNumber"),
                &json!({ "jsonrpc": "2.0", "id": 1, "result": { "baseFeePerGas": "0x3b9aca00" } })
                    .to_string(),
            )
            .respond(
                config::EVM_RPC,
                Some("eth_maxPriorityFeePerGas"),
                &eth("0x5f5e100"),
            )
            .respond(
                config::EVM_RPC,
                Some("eth_getBalance"),
                &eth("0x2386f26fc10000"),
            )
            .respond(
                config::EVM_RPC,
                Some("eth_getTransactionCount"),
                &eth("0x7"),
            );
        w
    }

    fn approved_envelope(w: Scripted) -> Value {
        let input = json!({ "mode": "guardian", "accounts": [ACCOUNT] });
        let dry = run(&w, &input).unwrap();
        assert!(dry["decisions"].as_array().unwrap().is_empty(), "{dry}");
        let body = w
            .log
            .borrow()
            .iter()
            .find(|(u, _)| u.ends_with("/chat/completions"))
            .unwrap()
            .1
            .clone();
        let w = w.respond(
            &format!("{}/signature/", config::NEARAI),
            None,
            &tee_signature(&body).to_string(),
        );
        let out = run(&w, &input).unwrap();
        assert_eq!(out["decisions"][0]["outcome"], "approved", "{out}");
        serde_json::from_str(out["decisions"][0]["envelope"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn guardian_approves_the_pool_before_an_aave_repay() {
        let w = evm_world(0, None);
        let e = approved_envelope(w);
        let a = &e["action"]["evm_approve"];
        // The repay (227.586207 USDC, see the test below) plus 1 % for interest, under the guard's
        // 500 cap, at the next nonce, with fees inside the contract's caps.
        assert_eq!(a["amount"], "229862069");
        assert_eq!(a["params"]["nonce"], 7);
        assert_eq!(a["params"]["max_priority_fee_per_gas"], "100000000");
        assert_eq!(a["params"]["max_fee_per_gas"], "2100000000");
        assert_eq!(a["params"]["gas_limit"], 260_000);
        assert!(e["trigger"]["score"].as_u64().unwrap() >= 50);
    }

    #[test]
    fn guardian_repays_aave_toward_the_target_health() {
        let w = evm_world(500_000_000, None);
        let e = approved_envelope(w);
        // Health 1000 × 0.83 / 800 = 1.0375; reaching 1.45 needs debt down to 572.41, so it repays
        // 227.586207 USDC (rounded up), under the 300 balance and the 500 cap.
        assert_eq!(e["action"]["evm_repay"]["amount"], "227586207");
    }

    #[test]
    fn guardian_refuses_an_evm_guard_for_someone_elses_address() {
        // Someone else's loan: the repay would spend the person's funds on another debt.
        let w = evm_world(500_000_000, Some(&format!("0x{}", "55".repeat(20))));
        let out = run(&w, &json!({ "mode": "guardian", "accounts": [ACCOUNT] })).unwrap();
        assert!(
            out["skipped"][0]["reason"]
                .as_str()
                .unwrap()
                .contains("not this account's"),
            "{out}"
        );
    }

    #[test]
    fn hyperliquid_prices_follow_the_tick_rules() {
        assert_eq!(hl_price(3.634567, false), "3.6345");
        assert_eq!(hl_price(3.634567, true), "3.6346");
        assert_eq!(hl_price(65432.1, false), "65432");
    }

    // -----------------------------------------------------------------------------------------
    // The owner's step order
    // -----------------------------------------------------------------------------------------

    /// The base world's mandate with other powers and limits.
    fn mandate_with(powers: &[&str], limits: Value) -> Value {
        let mut m = base_mandate(5);
        m["mandate"]["powers"] = json!(powers);
        m["mandate"]["limits"] = limits;
        m
    }

    fn wnear_limit() -> Value {
        json!([
            { "token": config::USDC, "reserve": "200000000", "daily": "120000000" },
            { "token": config::WNEAR, "reserve": "50000000000000000000000000", "daily": "50000000000000000000000000" },
        ])
    }

    /// The step `choose` picks for the base world's position (health 0.825 at $2.20).
    fn chosen(w: &Scripted, m: &Value, policy: &Policy) -> Result<Option<(Decided, Assessment)>> {
        let seen = look(w, ACCOUNT, 2.2, &[]).unwrap();
        choose(w, ACCOUNT, m, policy, &seen, 2.2)
    }

    #[test]
    fn the_first_allowed_useful_step_acts_and_the_plan_says_why() {
        let w = base_world(5).respond(
            config::RPC,
            Some(&format!("\"account_id\":\"{}\"", config::WNEAR)),
            &rpc(&json!("40000000000000000000000000")),
        );
        let m = mandate_with(&["add_collateral", "deleverage"], wnear_limit());
        let (d, _) = chosen(&w, &m, &Policy::default()).unwrap().unwrap();
        assert_eq!(d.action_name, "add_collateral");
        // Reaching 1.45 needs 75.76 wNEAR; the account holds 40.
        assert_eq!(
            d.action["add_collateral"]["amount"],
            "40000000000000000000000000"
        );
        assert!(
            d.plan.contains("Chose add_collateral: the first step in the order repay, add_collateral, deleverage, hl_reduce, evm_repay"),
            "{}",
            d.plan
        );
        assert!(
            d.plan
                .contains("repay skipped: not granted by the mandate."),
            "{}",
            d.plan
        );
        assert!(d.plan.chars().count() < 600);
    }

    #[test]
    fn the_owners_order_wins_and_each_skip_is_explained() {
        let w = base_world(5);
        let m = mandate_with(&["repay", "deleverage"], wnear_limit());
        let policy = Policy {
            steps: vec!["deleverage".into(), "repay".into()],
            ..Policy::default()
        };
        let (d, _) = chosen(&w, &m, &policy).unwrap().unwrap();
        // Health 0.825 is under the lending contract's withdraw floor: no collateral can leave,
        // so the repay acts, sized to the target and capped by the 60 USDC balance.
        assert_eq!(d.action_name, "repay");
        assert_eq!(d.action["repay"]["amount"], "60000000");
        assert!(
            d.plan.contains("order deleverage, repay ")
                && d.plan
                    .contains("deleverage skipped: health is too close to 1"),
            "{}",
            d.plan
        );
    }

    #[test]
    fn a_position_at_risk_that_no_step_can_help_names_every_skip() {
        let w = base_world(5);
        // Repay is not granted, and the mandate sets no wNEAR limit.
        let m = mandate_with(
            &["add_collateral", "deleverage"],
            json!([{ "token": config::USDC, "reserve": "1", "daily": "1" }]),
        );
        let e = chosen(&w, &m, &Policy::default()).err().unwrap();
        assert_eq!(
            e,
            "no allowed step can act: repay skipped: not granted by the mandate; add_collateral skipped: no wNEAR reserve left today; deleverage skipped: the daily cap leaves no wNEAR to sell; hl_reduce and evm_repay skipped: not granted by the mandate"
        );
    }

    #[test]
    fn a_healthy_position_needs_no_action() {
        let w = base_world(5).respond(
            config::RPC,
            Some("\"method_name\":\"get_account\""),
            &rpc(&json!({
                "collateral": [{ "token_id": config::WNEAR, "balance": "400000000000000000000000000" }],
                "borrowed": [{ "token_id": config::USDC, "balance": "150000000000000000000" }],
            })),
        );
        let m = mandate_with(&["repay"], wnear_limit());
        assert!(chosen(&w, &m, &Policy::default()).unwrap().is_none());
    }

    /// The account's derived secp256k1 key as the signer's view returns it.
    fn derived_key() -> String {
        let ec = EcKey::from_slice(&[3u8; 32]).unwrap();
        let point = ec.verifying_key().to_encoded_point(false);
        format!("secp256k1:{}", bs58::encode(point.as_bytes()).into_string())
    }

    #[test]
    fn a_perp_reduce_is_sized_to_the_target_health() {
        let hl_info = format!("{}/info", config::HYPERLIQUID);
        // A long of 100 NEAR at 4.00 with 100 USDC of account value, liquidating at 3.0769.
        let w = base_world(5)
            .respond(
                config::RPC,
                Some("\"method_name\":\"get_account\""),
                &rpc(&Value::Null),
            )
            .respond(
                config::RPC,
                Some("\"method_name\":\"derived_public_key\""),
                &rpc(&json!(derived_key())),
            )
            .respond(&hl_info, Some("clearinghouseState"), &json!({
                "marginSummary": { "accountValue": "100" }, "crossMaintenanceMarginUsed": "10",
                "assetPositions": [{ "position": { "coin": "NEAR", "szi": "100", "entryPx": "4.2", "liquidationPx": (3.0 / 0.975).to_string(), "unrealizedPnl": "-20", "cumFunding": { "allTime": "1", "sinceOpen": "1" } } }],
            }).to_string())
            .respond(&hl_info, Some("allMids"), r#"{"NEAR":"4.0"}"#);
        let mut m = mandate_with(&["hl_reduce"], json!([]));
        m["mandate"]["hl"] = json!({ "asset": "NEAR", "asset_index": 54, "max_size_e8": "10000000000", "band_bps": 200, "hedge_is_buy": false });
        let policy = Policy {
            trigger_score: 0,
            ..Policy::default()
        };
        let (d, a) = chosen(&w, &m, &policy).unwrap().unwrap();
        assert_eq!(d.action_name, "hl_reduce");
        assert!((a.health - (1.0 + (1.0 - 3.0 / 0.975 / 4.0))).abs() < 1e-9);
        let order = &d.action["hl_reduce"]["order"];
        let size: f64 = order["size"].as_str().unwrap().parse().unwrap();
        let want = plan::perp_reduce(
            &plan::Perp {
                size: 100.0,
                long: true,
                mark: 4.0,
                account_value: 100.0,
                liquidation: Some(3.0 / 0.975),
            },
            1.45,
            1,
        )
        .unwrap();
        assert!(
            (size - want).abs() < 1e-9 && size > 0.0 && size < 100.0,
            "{size}"
        );
        assert_eq!(
            (order["is_buy"].as_bool(), order["reduce_only"].as_bool()),
            (Some(false), Some(true))
        );
        assert!(d.plan.contains("sized to the target health"), "{}", d.plan);
        // The guard's cap binds.
        m["mandate"]["hl"]["max_size_e8"] = json!("500000000");
        let (d, _) = chosen(&w, &m, &policy).unwrap().unwrap();
        assert_eq!(d.action["hl_reduce"]["order"]["size"], "5");
        assert!(d.plan.contains("capped by the guard"), "{}", d.plan);
    }

    // -----------------------------------------------------------------------------------------
    // Health certificates
    // -----------------------------------------------------------------------------------------

    const BLOCK_HASH: &str = "8yfh2UHUzgKkoxFk8JXCKUPUsVHEhyjj1YgBxE2URkxr";

    /// The base world at block 123, with `collateral` NEAR against 150 USDC at $2.20.
    fn cert_world(collateral: &str) -> Scripted {
        base_world(5)
            .respond(
                config::RPC,
                Some("\"method\":\"block\""),
                &json!({ "jsonrpc": "2.0", "id": "parry", "result": { "header": { "height": 123, "hash": BLOCK_HASH } } }).to_string(),
            )
            .respond(
                config::RPC,
                Some("\"method_name\":\"get_account\""),
                &rpc(&json!({
                    "collateral": [{ "token_id": config::WNEAR, "balance": collateral }],
                    "borrowed": [{ "token_id": config::USDC, "balance": "150000000000000000000" }],
                })),
            )
    }

    fn cert_input(threshold: f64) -> Value {
        json!({ "mode": "certificate", "account": ACCOUNT, "reader": "lender.testnet", "threshold": threshold, "ttl_secs": 3600, "venue": "rhea" })
    }

    fn verify(domain: &[u8], text: &str, signature: &Value) {
        let pk = VerifyingKey::from_bytes(
            &ed25519_dalek::SigningKey::from_bytes(&[5u8; 32])
                .verifying_key()
                .to_bytes(),
        )
        .unwrap();
        let sig =
            Signature::from_slice(&STANDARD.decode(signature.as_str().unwrap()).unwrap()).unwrap();
        pk.verify(&sha256(&[domain, text.as_bytes()].concat()), &sig)
            .unwrap();
    }

    #[test]
    fn a_certificate_is_signed_when_health_clears_the_threshold() {
        // 300 NEAR × 2.20 × 0.5625 / 150: health 2.475.
        let w = cert_world("300000000000000000000000000");
        let out = run(&w, &cert_input(1.5)).unwrap();
        let mut keys: Vec<&str> = out
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "certificate_json",
                "hash",
                "public_key",
                "report_json",
                "report_signature",
                "signature"
            ]
        );
        let text = out["certificate_json"].as_str().unwrap();
        // The exact signed text, keys in the documented order.
        assert_eq!(
            text,
            format!(
                r#"{{"kind":"parry-health-certificate","version":1,"account":"{ACCOUNT}","reader":"lender.testnet","venue":"rhea","threshold":1.5,"block_height":123,"block_hash":"{BLOCK_HASH}","issued_at":1800000000,"expires_at":1800003600,"statement":"health is at least 1.5"}}"#
            )
        );
        verify(CERTIFICATE_DOMAIN, text, &out["signature"]);
        // The hash is the digest the enclave signed.
        assert_eq!(
            out["hash"],
            hex::encode(sha256(&[CERTIFICATE_DOMAIN, text.as_bytes()].concat()))
        );
        assert_eq!(out["public_key"], public_key(&w).unwrap());
        // The anchor for the risk board names the same hash, reader and expiry.
        let anchor = out["report_json"].as_str().unwrap();
        verify(RISK_DOMAIN, anchor, &out["report_signature"]);
        let a: Value = serde_json::from_str(anchor).unwrap();
        assert_eq!(
            (&a["kind"], &a["hash"], &a["reader"], &a["expires_at"]),
            (
                &json!("certificate"),
                &out["hash"],
                &json!("lender.testnet"),
                &json!(1_800_003_600u64)
            )
        );
        // Nothing about the position leaves the enclave: no amount and not the health.
        let all = out.to_string();
        for leak in ["300", "150", "2.475", "2.2", "collateral", "debt"] {
            assert!(!all.contains(leak), "{leak} in {all}");
        }
    }

    #[test]
    fn a_whole_threshold_is_written_as_javascript_writes_it() {
        let w = cert_world("300000000000000000000000000");
        let out = run(&w, &cert_input(2.0)).unwrap();
        let text = out["certificate_json"].as_str().unwrap();
        assert!(
            text.contains(r#""threshold":2,"#) && text.contains("health is at least 2\""),
            "{text}"
        );
    }

    #[test]
    fn every_position_read_is_pinned_to_the_certified_block() {
        let w = cert_world("300000000000000000000000000");
        run(&w, &cert_input(1.5)).unwrap();
        let log = w.log.borrow();
        let queries: Vec<String> = log
            .iter()
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .filter(|b| b.contains("\"method\":\"query\""))
            .collect();
        assert!(queries.len() >= 4, "{queries:?}");
        for q in queries {
            assert!(
                q.contains(&format!("\"block_id\":\"{BLOCK_HASH}\"")) && !q.contains("finality"),
                "{q}"
            );
        }
    }

    #[test]
    fn a_certificate_below_the_threshold_is_refused_and_unsigned() {
        // Health 0.825.
        let w = cert_world("100000000000000000000000000");
        let out = run(&w, &cert_input(1.2)).unwrap();
        assert_eq!(out, json!({ "refused": "health is below the threshold" }));
        // A position with no debt clears any threshold.
        let w = cert_world("1").respond(
            config::RPC,
            Some("\"method_name\":\"get_account\""),
            &rpc(&json!({ "collateral": [], "borrowed": [] })),
        );
        assert!(run(&w, &cert_input(10.0)).unwrap()["signature"].is_string());
    }

    #[test]
    fn certificate_input_is_checked() {
        let w = cert_world("300000000000000000000000000");
        let bad = |k: &str, v: Value| {
            let mut i = cert_input(1.5);
            i[k] = v;
            run(&w, &i).unwrap_err()
        };
        assert!(bad("threshold", json!(0.9)).contains("threshold"));
        assert!(bad("threshold", json!("1.5")).contains("threshold"));
        assert!(bad("ttl_secs", json!(10)).contains("ttl_secs"));
        assert!(bad("ttl_secs", json!(2_592_001)).contains("ttl_secs"));
        assert!(bad("venue", json!("aave")).contains("venue"));
        assert!(bad("reader", json!("")).contains("reader"));
        assert!(bad("reader", json!("r".repeat(129))).contains("reader"));
        assert!(bad("account", json!(null)).contains("account"));
        // A read that fails says which venue, not what the position holds.
        let broken = base_world(5).respond(
            config::RPC,
            Some("\"method\":\"block\""),
            &json!({ "result": { "header": { "height": 7, "hash": BLOCK_HASH } } }).to_string(),
        );
        let mut i = cert_input(1.5);
        i["venue"] = json!("evm");
        assert_eq!(
            run(&broken, &i).unwrap_err(),
            "could not read the evm position at block 7"
        );
    }

    // -----------------------------------------------------------------------------------------
    // Vault report
    // -----------------------------------------------------------------------------------------

    const E24: &str = "000000000000000000000000";

    fn vault_world(insurance: Option<Value>) -> Scripted {
        let hl_info = format!("{}/info", config::HYPERLIQUID);
        let view = |method: &str| format!("\"method_name\":\"{method}\"");
        let w = base_world(5)
            .respond(
                config::RPC,
                Some(&format!("\"account_id\":\"{}\"", config::LINEAR)),
                &rpc(&json!(format!("1000{E24}"))),
            )
            .respond(
                config::RPC,
                Some(&format!("\"account_id\":\"{}\"", config::USDC)),
                &rpc(&json!("500000000")),
            )
            .respond(config::RPC, Some(&view("ft_price")), &rpc(&json!(format!("12{}", &E24[1..]))))
            .respond(config::RPC, Some(&view("vault_state")), &rpc(&json!({
                "staked_linear": format!("920{E24}"), "settled_pnl_e6": "0", "linear_rate_e24": format!("12{}", &E24[1..]),
                "claims_linear": format!("20{E24}"), "claims_usdc_e6": "5000000", "loss_backing_linear": format!("10{E24}"),
            })))
            .respond(config::RPC, Some(&view("config")), &rpc(&json!({
                "hedge": { "hedge_ratio_bps": 9000 }, "hedge_ratio_min_bps": 7000,
            })))
            .respond(config::RPC, Some(&view("derived_public_key")), &rpc(&json!(derived_key())))
            .respond(&hl_info, Some("clearinghouseState"), &json!({
                "marginSummary": { "accountValue": "1100" }, "crossMaintenanceMarginUsed": "55",
                "assetPositions": [{ "position": { "coin": "NEAR", "szi": "-800", "entryPx": "2.3", "liquidationPx": "3.5", "unrealizedPnl": "80", "cumFunding": { "allTime": "-12.5", "sinceOpen": "-3" } } }],
            }).to_string())
            .respond(&hl_info, Some("allMids"), r#"{"NEAR":"2.2"}"#)
            .respond(&hl_info, Some("userNonFundingLedgerUpdates"), r#"[{"delta":{"type":"deposit","usdc":"1000"}}]"#)
            .respond(&hl_info, Some("metaAndAssetCtxs"), r#"[{"universe":[{"name":"NEAR"}]},[{"markPx":"2.2","oraclePx":"2.2","funding":"0.00001"}]]"#)
            .respond(&hl_info, Some("fundingHistory"), r#"[{"coin":"NEAR","fundingRate":"-0.0001","time":1},{"coin":"NEAR","fundingRate":"-0.00068","time":2}]"#);
        match insurance {
            Some(v) => w.respond(config::RPC, Some(&view("insurance")), &rpc(&v)),
            None => w.respond(
                config::RPC,
                Some(&view("insurance")),
                &json!({ "jsonrpc": "2.0", "id": "parry", "result": { "error": "wasm execution failed with error: MethodResolveError(MethodNotFound)" } }).to_string(),
            ),
        }
    }

    fn leaf<'a>(out: &'a Value, asset: &str, venue: &str) -> &'a Value {
        out["reserve_leaves"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["asset"] == asset && l["venue"] == venue)
            .unwrap()
    }

    fn usd(v: &Value) -> f64 {
        v.as_str().unwrap().parse::<f64>().unwrap() / 1e6
    }

    #[test]
    fn vault_report_counts_the_insurance_fund_outside_the_liabilities() {
        let w = vault_world(Some(json!({
            "share_bps": 1000, "linear": format!("50{E24}"), "usdc_e6": "10000000", "value_usd_e6": "142000000",
            "paid_total_e6": "0", "paid_today_e6": "0", "cap_per_day_bps": 2500, "margin_reserved_usd_e6": "0",
            "margin_reserved_linear": "0", "margin_reserved_usdc_e6": "0",
        })));
        let out = run(&w, &json!({ "mode": "vault_report" })).unwrap();
        let r: Value = serde_json::from_str(out["report_json"].as_str().unwrap()).unwrap();
        verify(
            RISK_DOMAIN,
            out["report_json"].as_str().unwrap(),
            &out["signature"],
        );
        // LiNEAR at 1.2 NEAR and NEAR at $2.20: $2.64 each.
        let lin = leaf(&out, "LiNEAR", "near");
        assert_eq!(lin["amount"], format!("950{E24}"));
        assert!((usd(&lin["usdE6"]) - 950.0 * 2.64).abs() < 1e-3);
        let ins = leaf(&out, "INSURANCE", "near");
        assert_eq!(ins["amount"], format!("50{E24}"));
        assert!((usd(&ins["usdE6"]) - (50.0 * 2.64 + 10.0)).abs() < 1e-3);
        // The hedge account: 1100 of value, 1000 of operator margin, 10 of it the fund's.
        assert!((usd(&leaf(&out, "USDC", "hyperliquid")["usdE6"]) - 90.0).abs() < 1e-3);
        assert_eq!(r["reserves"]["leaves"], 5);
        let total = usd(&r["reserves"]["total_usd_e6"]);
        assert!(
            (total - (950.0 * 2.64 + 90.0 + 142.0)).abs() < 1e-2,
            "{total}"
        );
        // Liabilities: the book's LiNEAR, the hedge equity without the fund, the claims (20
        // LiNEAR and 5 USDC) and the loss backing (10 LiNEAR); never the fund.
        let liabilities = usd(&r["reserves"]["liabilities_usd_e6"]);
        let want = 920.0 * 2.64 + 90.0 + 20.0 * 2.64 + 5.0 + 10.0 * 2.64;
        assert!((liabilities - want).abs() < 1e-2, "{liabilities}");
        assert_eq!(
            r["reserves"]["ratio_bps"],
            (total / liabilities * 1e4).floor() as u64
        );
        // Funding: shorts paid 0.078% over 7 days (-4.1% a year): the hedge leans to 85%.
        assert_eq!(r["hedge_ratio_bps"], 8500);
        assert_eq!(
            r["hedge_ratio_reason"],
            "7-day funding is -4.1% a year: shorts pay, hedge leans to 85% (min 70%)"
        );
        assert_eq!(r["margin_ratio"], 500);
        // Lifetime funding: Hyperliquid's paid 12.5 of all time is 12.5 received.
        assert_eq!(r["hedge"]["funding_e6"], "12500000");
    }

    #[test]
    fn vault_report_reads_a_vault_without_an_insurance_view() {
        let out = run(&vault_world(None), &json!({ "mode": "vault_report" })).unwrap();
        let ins = leaf(&out, "INSURANCE", "near");
        assert_eq!(
            (ins["amount"].as_str(), ins["usdE6"].as_str()),
            (Some("0"), Some("0"))
        );
        assert_eq!(leaf(&out, "LiNEAR", "near")["amount"], format!("1000{E24}"));
    }

    #[test]
    fn hedge_ratio_follows_seven_day_funding() {
        assert_eq!(
            hedge_ratio(9000, 7000, Some(0.0008)),
            (
                9000,
                "7-day funding is +4.2% a year: shorts are paid, full hedge 90%".to_string()
            )
        );
        // 20% a year paid or more: the minimum.
        assert_eq!(hedge_ratio(9000, 7000, Some(-0.01)).0, 7000);
        // Halfway: 10% a year paid leans halfway, 8000.
        assert_eq!(hedge_ratio(9000, 7000, Some(-0.1 * 7.0 / 365.0)).0, 8000);
        assert_eq!(
            hedge_ratio(9000, 7000, None),
            (
                9000,
                "funding history unavailable: full hedge 90%".to_string()
            )
        );
        // A minimum above the maximum is held to it.
        assert_eq!(hedge_ratio(8000, 9500, Some(-1.0)).0, 8000);
    }
}
