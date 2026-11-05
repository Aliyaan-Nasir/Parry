//! What one run does. The caller's input chooses the mode and, for position modes, which
//! accounts to look at; everything else the enclave reads itself from the compiled-in sources.

use crate::ai::{self, Review};
use crate::chain::{self, Lending};
use crate::config;
use crate::io::{Io, Result};
use crate::plan::{self, Budgets, Position, Step};
use crate::risk::{self, Assessment};
use crate::seal::{self, Policy};
use crate::{hl, reserves, sha256};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

pub const RISK_DOMAIN: &[u8] = b"parry-risk:v1:";
pub const ENVELOPE_DOMAIN: &[u8] = b"parry-guardian:v1:";
const PATH_HL: &str = "parry-hyperliquid";
const PATH_VAULT: &str = "parry-vault-hedge";
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
}

/// The lending rescue's first step, within the mandate and the account's balances.
fn lending_step(
    io: &dyn Io,
    account: &str,
    m: &Value,
    policy: &Policy,
    l: &Lending,
    a: &Assessment,
    price: f64,
) -> Result<Option<Decided>> {
    if a.score < policy.trigger_score && a.health > policy.trigger_health {
        return Ok(None);
    }
    let usdc_bal = chain::ft_balance(io, config::USDC, account).unwrap_or(0);
    let wnear_bal = chain::ft_balance(io, config::WNEAR, account).unwrap_or(0);
    let slippage = m["mandate"]["max_slippage_bps"]
        .as_u64()
        .unwrap_or(200)
        .min(300) as f64
        / 10_000.0;
    let budgets = Budgets {
        repay_usd: if has_power(m, "repay") {
            allowance(m, config::USDC, true).min(usdc_bal) as f64 / 1e6
        } else {
            0.0
        },
        collateral_near: if has_power(m, "add_collateral") {
            allowance(m, config::WNEAR, true).min(wnear_bal) as f64 / 1e24
        } else {
            0.0
        },
        deleverage_near: if has_power(m, "deleverage") {
            allowance(m, config::WNEAR, false) as f64 / 1e24
        } else {
            0.0
        },
        slippage,
        withdraw_floor: 1.01,
    };
    let p = Position {
        collateral: l.collateral_near,
        debt: l.debt_usd,
        price,
        c_ratio: l.near_ratio,
        d_ratio: l.usdc_ratio,
    };
    let Some(step) = plan::first_step(&policy.strategy, &p, policy.target_health, &budgets) else {
        return Ok(None);
    };
    let health = |p: &Position| format!("{:.3}", p.health());
    Ok(Some(match step {
        Step::Repay { usd } => {
            let after = Position {
                debt: p.debt - usd,
                ..p
            };
            Decided {
                venue: "rhea",
                action: json!({ "repay": { "token": config::USDC, "amount": format!("{}", (usd * 1e6).round() as u128) } }),
                action_name: "repay",
                plan: format!(
                    "Repay {usd:.2} USDC from the reserve: health {} to {} (target {:.2}).",
                    health(&p),
                    health(&after),
                    policy.target_health
                ),
            }
        }
        Step::AddCollateral { near } => {
            let after = Position {
                collateral: p.collateral + near,
                ..p
            };
            Decided {
                venue: "rhea",
                action: json!({ "add_collateral": { "token": config::WNEAR, "amount": format!("{}", (near * 1e4).round() as u128 * 10u128.pow(20)) } }),
                action_name: "add_collateral",
                plan: format!(
                    "Add {near:.4} wNEAR collateral from the reserve: health {} to {}.",
                    health(&p),
                    health(&after)
                ),
            }
        }
        Step::Deleverage { near, min_out_usd } => {
            let after = Position {
                collateral: p.collateral - near,
                debt: p.debt - min_out_usd,
                ..p
            };
            let pool: u64 = config::DEX_POOL
                .parse()
                .map_err(|_| "no exchange pool configured")?;
            Decided {
                venue: "rhea",
                action: json!({ "deleverage": {
                    "collateral": config::WNEAR, "amount": format!("{}", (near * 1e4).round() as u128 * 10u128.pow(20)),
                    "pool_id": pool, "debt": config::USDC, "min_out": format!("{}", (min_out_usd * 1e6).floor() as u128),
                }}),
                action_name: "deleverage",
                plan: format!(
                    "Sell {near:.4} NEAR of collateral for at least {min_out_usd:.2} USDC and repay: health {} to at least {}.",
                    health(&p),
                    health(&after)
                ),
            }
        }
    }))
}

/// A reduce-only Hyperliquid order when the account's perp is near its liquidation price.
fn hyperliquid_step(
    io: &dyn Io,
    account: &str,
    m: &Value,
    policy: &Policy,
) -> Result<Option<(Decided, Assessment)>> {
    if !has_power(m, "hl_reduce") || m["mandate"]["hl"].is_null() {
        return Ok(None);
    }
    let address = chain::derived_evm_address(io, account, PATH_HL)?;
    let state = hl::clearinghouse(io, &address, "NEAR")?;
    let Some(perp) = state.perp.filter(|p| p.size != 0.0) else {
        return Ok(None);
    };
    let Some(mid) = hl::mid(io, "NEAR")? else {
        return Ok(None);
    };
    let candles = hl::candles(io, "NEAR", io.now()).unwrap_or_default();
    let (sigma, _) = risk::tremor(&candles, io.now() as f64);
    let long = perp.size > 0.0;
    let (px, liq) = if long {
        (mid, perp.liquidation)
    } else {
        (1.0 / mid, perp.liquidation.map(|l| 1.0 / l))
    };
    let p24 = risk::probability(px, liq, sigma, 0.0, 24.0);
    let health = liq.map_or(f64::INFINITY, |l| 1.0 + (1.0 - l / px).max(0.0));
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
        return Ok(None);
    }
    let max_size = u128_of(&m["mandate"]["hl"]["max_size_e8"]) as f64 / 1e8;
    let band = m["mandate"]["hl"]["band_bps"].as_u64().unwrap_or(100) as f64 / 10_000.0;
    let f = 10f64.powi(config::HL_SZ_DECIMALS as i32);
    let size = ((perp.size.abs() * policy.hl_reduce_fraction).min(max_size) * f).floor() / f;
    if size <= 0.0 {
        return Ok(None);
    }
    // Closing a long sells, closing a short buys; the limit sits half the band away from the mid.
    let limit = if long {
        mid * (1.0 - band / 2.0)
    } else {
        mid * (1.0 + band / 2.0)
    };
    let order = json!({
        "asset_index": config::hl_near_index(), "is_buy": !long,
        "price": hl_price(limit, !long), "size": trim(&format!("{size:.1}")),
        "reduce_only": true, "tif": "Ioc",
    });
    Ok(Some((
        Decided {
            venue: "hyperliquid",
            action: json!({ "hl_reduce": { "order": order, "nonce": io.now() * 1000 } }),
            action_name: "hl_reduce",
            plan: format!("Reduce the Hyperliquid NEAR {} by {size} (of {:.1}), reduce-only, near the mark {mid:.4}.", if long { "long" } else { "short" }, perp.size.abs()),
        },
        a,
    )))
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
            let lending = match (&seen.lending, &seen.assessment) {
                (Some(l), Some(a)) => {
                    lending_step(io, &account, &m, &policy, l, a, price)?.map(|d| (d, a.clone()))
                }
                _ => None,
            };
            let Some((decided, a)) = lending
                .map(Ok)
                .or_else(|| hyperliquid_step(io, &account, &m, &policy).transpose())
                .transpose()?
            else {
                return Ok(None);
            };
            let (_, guardian_nonce) = chain::nonces(io, &account)?;
            let facts = json!({
                "account": account, "venue": decided.venue, "network": config::NETWORK,
                "position": seen.lending.as_ref().map(|l| json!({ "collateral_near": l.collateral_near, "debt_usd": l.debt_usd })),
                "near_price_usd": price,
                "risk": { "score": a.score, "tier": risk::tier(a.score), "health": if a.health.is_finite() { json!(a.health) } else { Value::Null },
                          "liquidation_price": a.liq_price, "p_liquidation_24h": a.p24, "median_hours_to_liquidation": a.ttl_hours, "annual_volatility": a.annual },
                "target_health": policy.target_health,
                "mandate_limits": m["mandate"]["limits"], "max_slippage_bps": m["mandate"]["max_slippage_bps"],
                "proposed_action": decided.action, "plan": decided.plan,
            });
            let review: Review = ai::review(io, &facts)?;
            let review_hash = review.hash();
            let mut out = json!({ "account": account, "venue": decided.venue, "plan": decided.plan, "action": decided.action, "review": review, "review_hash": review_hash, "facts": facts });
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

/// The vault's hedge, reserves and risk score, signed for the risk board (which forwards it to
/// the vault).
fn vault_report(io: &dyn Io) -> Result<Value> {
    let price = chain::oracle_price(io, config::NEAR_USD, PRICE_MAX_AGE)?
        .ok_or("no fresh NEAR price on the oracle")?;
    let state: Value = chain::view(io, config::VAULT, "vault_state", &json!({}))?;
    let linear = chain::ft_balance(io, config::LINEAR, config::VAULT)?;
    let rate: String = chain::view(io, config::LINEAR, "ft_price", &json!({}))?;
    let rate = rate.parse::<f64>().unwrap_or(0.0) / 1e24;
    let buffer = chain::ft_balance(io, config::USDC, config::VAULT).unwrap_or(0);
    let address = chain::derived_evm_address(io, config::VAULT, PATH_VAULT)?;
    let ch = hl::clearinghouse(io, &address, "NEAR").unwrap_or_default();
    let perp = ch.perp.clone().unwrap_or_default();
    let mark = hl::mid(io, "NEAR")?.unwrap_or(0.0);
    let operator_margin = hl::net_deposits(io, &address)
        .unwrap_or(ch.account_value - perp.unrealized - perp.funding_since_open);

    // Reserves on both venues against what the vault's own book says it owes.
    let linear_usd = linear as f64 / 1e24 * rate * price;
    let leaves = vec![
        reserves::Leaf {
            asset: "LiNEAR".into(),
            venue: "near".into(),
            amount: linear.to_string(),
            usd_e6: format!("{}", (linear_usd * 1e6) as u128),
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
            usd_e6: format!("{}", ((ch.account_value - operator_margin) * 1e6).max(0.0) as u128),
        },
        reserves::Leaf {
            asset: "NEAR-PERP".into(),
            venue: "hyperliquid".into(),
            amount: e8_signed(perp.size),
            usd_e6: "0".into(),
        },
    ];
    let root = reserves::root(&leaves);
    let total_usd = linear_usd + (ch.account_value - operator_margin);
    let book_linear = u128_of(&state["staked_linear"]) as f64 / 1e24;
    let settled = state["settled_pnl_e6"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        / 1e6;
    let liabilities = (book_linear * rate * price + ch.account_value - operator_margin - settled).max(0.0);
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
            "funding_e6": i_e6(perp.funding_since_open), "margin_baseline_e6": format!("{}", (operator_margin * 1e6).max(0.0) as u128),
            "mark_e8": e8(mark), "liquidation_e8": e8(perp.liquidation.unwrap_or(0.0)),
        },
        "reserves": { "root": root, "leaves": leaves.len(), "total_usd_e6": format!("{}", (total_usd * 1e6).max(0.0) as u128), "liabilities_usd_e6": format!("{}", (liabilities * 1e6) as u128), "ratio_bps": ratio },
    })
    .to_string();
    let leaves_json: Vec<Value> = leaves.iter().map(|l| json!({ "asset": l.asset, "venue": l.venue, "amount": l.amount, "usdE6": l.usd_e6 })).collect();
    Ok(
        json!({ "report_json": report, "signature": signed(io, RISK_DOMAIN, &report)?, "reserve_leaves": leaves_json, "hedge_address": address }),
    )
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

    fn base_world(seed: u8) -> Scripted {
        let mut w = Scripted {
            now: 1_800_000_000,
            seed: [5u8; 32],
            ..Default::default()
        };
        w.secrets.insert("NEARAI_API_KEY".into(), "test".into());
        let me = format!(
            "ed25519:{}",
            bs58::encode(
                ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
                    .verifying_key()
                    .to_bytes()
            )
            .into_string()
        );
        let mandate = json!({
            "mandate": {
                "guardian_key": me, "powers": ["repay", "add_collateral", "deleverage"],
                "limits": [{ "token": config::USDC, "reserve": "200000000", "daily": "120000000" }],
                "max_actions_per_day": 10, "min_health_after_bps": 10500, "max_slippage_bps": 200, "hl": null, "evm": null,
                "sealed": null, "expires_at": 1_900_000_000u64,
            },
            "set_at": 1, "paused_until": 0, "expired": false, "spent": [], "moved_today": [], "actions_today": 0,
        });
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

    #[test]
    fn hyperliquid_prices_follow_the_tick_rules() {
        assert_eq!(hl_price(3.634567, false), "3.6345");
        assert_eq!(hl_price(3.634567, true), "3.6346");
        assert_eq!(hl_price(65432.1, false), "65432");
    }
}
