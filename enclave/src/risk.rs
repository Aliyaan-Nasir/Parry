//! The risk model, as in packages/core/src/risk.ts (docs/risk-model.md). Both implementations
//! are tested against packages/core/fixtures/risk-cases.json.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub t: f64,
    pub price: f64,
}

pub const HOURS_PER_YEAR: f64 = 8760.0;
pub const DEFAULT_ANNUAL_VOL: f64 = 0.7;

fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let r = t
        * (-z * z - 1.26551223
            + t * (1.00002368
                + t * (0.37409196
                    + t * (0.09678418
                        + t * (-0.18628806
                            + t * (0.27886807
                                + t * (-1.13520398
                                    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
            .exp();
    if x >= 0.0 {
        r
    } else {
        2.0 - r
    }
}

pub fn norm_cdf(x: f64) -> f64 {
    0.5 * erfc(-x / std::f64::consts::SQRT_2)
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// Health of one driver collateral against one stablecoin debt.
pub fn health(collateral: f64, debt: f64, price: f64, c_ratio: f64, d_ratio: f64) -> f64 {
    if debt <= 0.0 {
        f64::INFINITY
    } else {
        collateral * price * c_ratio * d_ratio / debt
    }
}

/// Driver price at which health reaches 1.
pub fn liquidation_price(collateral: f64, debt: f64, c_ratio: f64, d_ratio: f64) -> Option<f64> {
    if debt <= 0.0 || collateral <= 0.0 {
        return None;
    }
    Some(debt / d_ratio / (collateral * c_ratio))
}

/// The Tremor index: per square-root hour, from 1h, 4h and 12h windows weighted 0.5, 0.3, 0.2.
pub fn tremor(samples: &[Sample], now: f64) -> (f64, bool) {
    let mut sorted: Vec<Sample> = samples.iter().copied().filter(|s| s.price > 0.0).collect();
    sorted.sort_by(|a, b| a.t.total_cmp(&b.t));
    let mut num = 0.0;
    let mut wsum = 0.0;
    for (hours, weight) in [(1.0, 0.5), (4.0, 0.3), (12.0, 0.2)] {
        let w: Vec<&Sample> = sorted
            .iter()
            .filter(|s| s.t >= now - hours * 3600.0 && s.t <= now)
            .collect();
        if w.len() < 2 {
            continue;
        }
        let sum_sq: f64 = w
            .windows(2)
            .map(|p| (p[1].price / p[0].price).ln().powi(2))
            .sum();
        let span = (w[w.len() - 1].t - w[0].t) / 3600.0;
        if span > 0.0 {
            num += weight * sum_sq / span;
            wsum += weight;
        }
    }
    if wsum == 0.0 {
        return (DEFAULT_ANNUAL_VOL / HOURS_PER_YEAR.sqrt(), true);
    }
    ((num / wsum).sqrt(), false)
}

/// Half the least-squares slope of log price over 4h, capped at ±σ per hour.
pub fn trend(samples: &[Sample], now: f64, sigma: f64) -> f64 {
    let w: Vec<&Sample> = samples
        .iter()
        .filter(|s| s.t >= now - 4.0 * 3600.0 && s.t <= now && s.price > 0.0)
        .collect();
    if w.len() < 3 {
        return 0.0;
    }
    let n = w.len() as f64;
    let xs: Vec<f64> = w.iter().map(|s| s.t / 3600.0).collect();
    let ys: Vec<f64> = w.iter().map(|s| s.price.ln()).collect();
    let mx = xs.iter().sum::<f64>() / n;
    let my = ys.iter().sum::<f64>() / n;
    let (mut a, mut b) = (0.0, 0.0);
    for i in 0..w.len() {
        a += (xs[i] - mx) * (ys[i] - my);
        b += (xs[i] - mx).powi(2);
    }
    let slope = if b == 0.0 { 0.0 } else { a / b };
    (0.5 * slope).clamp(-sigma, sigma)
}

/// First-passage probability of reaching `liq` within `hours`.
pub fn probability(price: f64, liq: Option<f64>, sigma: f64, m: f64, hours: f64) -> f64 {
    let Some(liq) = liq else { return 0.0 };
    if hours <= 0.0 {
        return 0.0;
    }
    if price <= liq {
        return 1.0;
    }
    let d = (price / liq).ln();
    let s = sigma * hours.sqrt();
    if s <= 0.0 {
        return if m < 0.0 && -m * hours >= d { 1.0 } else { 0.0 };
    }
    let a = norm_cdf((-d - m * hours) / s);
    let log_b = -2.0 * m * d / (sigma * sigma) + norm_cdf((-d + m * hours) / s).max(1e-300).ln();
    clamp01(a + log_b.min(0.0).exp())
}

/// Median first-passage time in hours, None beyond 30 days.
pub fn median_hours(price: f64, liq: Option<f64>, sigma: f64, m: f64) -> Option<f64> {
    liq?;
    if probability(price, liq, sigma, m, 720.0) < 0.5 {
        return None;
    }
    let (mut a, mut b) = (0.0, 720.0);
    for _ in 0..60 {
        let c = (a + b) / 2.0;
        if probability(price, liq, sigma, m, c) < 0.5 {
            a = c;
        } else {
            b = c;
        }
    }
    Some((a + b) / 2.0)
}

pub fn tier(score: u8) -> &'static str {
    match score {
        75.. => "critical",
        50.. => "danger",
        25.. => "caution",
        _ => "safe",
    }
}

/// S = round(100 × clamp(0.70 √H + 0.15 V + 0.15 C)) with the health floors.
pub fn score(health: f64, p24: f64, annual: f64, cascade: f64) -> u8 {
    let v =
        0.7 * clamp01(p24).sqrt() + 0.15 * clamp01((annual - 0.3) / 1.2) + 0.15 * clamp01(cascade);
    let mut s = (100.0 * clamp01(v)).round() as u8;
    if health < 1.03 {
        s = s.max(75);
    } else if health < 1.10 {
        s = s.max(50);
    }
    s
}

/// A whole assessment of a stablecoin-debt, driver-collateral position.
#[derive(Clone, Debug)]
pub struct Assessment {
    pub health: f64,
    pub liq_price: Option<f64>,
    pub sigma: f64,
    pub annual: f64,
    pub trend: f64,
    pub p24: f64,
    pub ttl_hours: Option<f64>,
    pub score: u8,
}

pub fn assess_lending(
    collateral: f64,
    debt: f64,
    price: f64,
    c_ratio: f64,
    d_ratio: f64,
    history: &[Sample],
    now: f64,
) -> Assessment {
    let h = health(collateral, debt, price, c_ratio, d_ratio);
    let liq = liquidation_price(collateral, debt, c_ratio, d_ratio);
    let (sigma, _) = tremor(history, now);
    let m = trend(history, now, sigma);
    let p24 = probability(price, liq, sigma, m, 24.0);
    let annual = sigma * HOURS_PER_YEAR.sqrt();
    Assessment {
        health: h,
        liq_price: liq,
        sigma,
        annual,
        trend: m,
        p24,
        ttl_hours: median_hours(price, liq, sigma, m),
        score: score(h, p24, annual, 0.0),
    }
}

/// An Aave position from its own health factor. With the collateral moving as one asset,
/// liquidation is a fall to 1/health of today's price; Parry keeps no history for that asset, so
/// the default volatility stands in (as `assessAave` in services/src/risk.ts).
pub fn assess_aave(health: f64) -> Assessment {
    let sigma = DEFAULT_ANNUAL_VOL / HOURS_PER_YEAR.sqrt();
    let liq = (health.is_finite() && health > 0.0).then(|| 1.0 / health);
    let p24 = probability(1.0, liq, sigma, 0.0, 24.0);
    Assessment {
        health,
        liq_price: liq,
        sigma,
        annual: DEFAULT_ANNUAL_VOL,
        trend: 0.0,
        p24,
        ttl_hours: median_hours(1.0, liq, sigma, 0.0),
        score: score(health, p24, DEFAULT_ANNUAL_VOL, 0.0),
    }
}

/// What the vault's risk score is computed from, as the vault report reads it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VaultRiskInput {
    /// Signed perp size (negative is short), NEAR.
    pub size: f64,
    pub mark: f64,
    /// Hyperliquid's liquidation price for the position.
    pub liquidation: Option<f64>,
    /// The hedge account's value, USD.
    pub account_value: f64,
    /// Hyperliquid's current funding rate, per hour (negative: shorts pay).
    pub funding_rate: f64,
    /// Mark against the oracle, as a fraction.
    pub oracle_dev: f64,
    /// NEAR per LiNEAR the vault last booked, and now.
    pub book_rate: f64,
    pub rate: f64,
    /// Reserves over liabilities, bps.
    pub reserves_ratio_bps: u32,
}

/// The vault's risk components, each 0..10000 (bps of "fully risky"), and its 0..100 score.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultRisk {
    pub liquidation: u32,
    pub margin: u32,
    pub funding: u32,
    pub oracle: u32,
    pub rate: u32,
    pub reserves: u32,
    pub score: u8,
}

fn unit_bps(x: f64) -> u32 {
    if !x.is_finite() {
        return 999_999;
    }
    (x * 10_000.0).round().clamp(0.0, 999_999.0) as u32
}

/// A short whose liquidation price is less than this far above the mark scores at least
/// `VAULT_MARGIN_FLOOR`, the vault contract's margin score: with Hyperliquid's 5% maintenance
/// margin for NEAR, 15% is a margin ratio of about 0.21, just above the keeper's early mark of 0.2.
pub const VAULT_MARGIN_DISTANCE: f64 = 0.15;
pub const VAULT_MARGIN_FLOOR: u8 = 85;
/// ...and less than this far, at least `VAULT_PAUSE_FLOOR`, the contract's deposit pause (a
/// margin ratio of about 0.26, under the 1/3 the leverage cap of 3 keeps after a rebalance).
pub const VAULT_PAUSE_DISTANCE: f64 = 0.20;
pub const VAULT_PAUSE_FLOOR: u8 = 70;

/// The vault's risk score (packages/core `vaultRisk` mirrors it; both pass
/// packages/core/fixtures/vault-cases.json): 35% how close the short's liquidation price is (full
/// at the mark, none 50% above it), 25% leverage (full at leverage 5), 10% funding paid by shorts
/// (full at 1 bp an hour), 10% oracle deviation (full at 2%), 5% a fall of the LiNEAR rate (full
/// at 1%) and 15% a reserves shortfall (full at 5%); then floors on the liquidation distance, so
/// a short near its liquidation price alone pauses deposits and asks for margin.
pub fn vault_risk(i: &VaultRiskInput) -> VaultRisk {
    let distance = match i.liquidation {
        Some(l) if i.size < 0.0 && i.mark > 0.0 => Some(l / i.mark - 1.0),
        _ => None,
    };
    let liquidation = distance.map_or(0, |d| unit_bps(clamp01(1.0 - d / 0.5)));
    let floor = match distance {
        Some(d) if d < VAULT_MARGIN_DISTANCE => VAULT_MARGIN_FLOOR,
        Some(d) if d < VAULT_PAUSE_DISTANCE => VAULT_PAUSE_FLOOR,
        _ => 0,
    };
    let leverage = if i.account_value > 0.0 {
        i.size.abs() * i.mark / i.account_value
    } else {
        0.0
    };
    let margin = unit_bps(clamp01(leverage / 5.0));
    let funding = unit_bps(clamp01(-i.funding_rate / 0.0001));
    let oracle = unit_bps(clamp01(i.oracle_dev / 0.02));
    let rate = if i.book_rate > 0.0 {
        unit_bps(clamp01((i.book_rate - i.rate) / i.book_rate / 0.01))
    } else {
        0
    };
    let reserves = unit_bps(clamp01((10_000.0 - i.reserves_ratio_bps as f64) / 500.0));
    let score = ((0.35 * liquidation as f64
        + 0.25 * margin as f64
        + 0.1 * funding as f64
        + 0.1 * oracle as f64
        + 0.05 * rate as f64
        + 0.15 * reserves as f64)
        / 100.0)
        .round() as u8;
    VaultRisk {
        liquidation,
        margin,
        funding,
        oracle,
        rate,
        reserves,
        score: score.max(floor).min(100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn matches_the_hand_checked_fixtures() {
        let raw = include_str!("../../packages/core/fixtures/risk-cases.json");
        let v: Value = serde_json::from_str(raw).unwrap();
        for c in v["cases"].as_array().unwrap() {
            let f = |k: &str| c[k].as_f64().unwrap();
            let e = &c["expected"];
            let h = health(
                f("collateralNear"),
                f("debtUsd"),
                f("price"),
                f("collateralRatio"),
                f("debtRatio"),
            );
            assert!(
                (h - e["health"].as_f64().unwrap()).abs() < 1e-9,
                "{}",
                c["name"]
            );
            let liq = liquidation_price(
                f("collateralNear"),
                f("debtUsd"),
                f("collateralRatio"),
                f("debtRatio"),
            );
            assert!((liq.unwrap() - e["liqPrice"].as_f64().unwrap()).abs() < 1e-9);
            let p = probability(f("price"), liq, f("sigmaHourly"), f("trendHourly"), 24.0);
            assert!(
                (p - e["probability24h"].as_f64().unwrap()).abs() < 1e-5,
                "{} p24 {p}",
                c["name"]
            );
            match e["medianHours"].as_f64() {
                None => assert!(
                    median_hours(f("price"), liq, f("sigmaHourly"), f("trendHourly")).is_none()
                ),
                Some(m) => assert!(
                    (median_hours(f("price"), liq, f("sigmaHourly"), f("trendHourly")).unwrap()
                        - m)
                        .abs()
                        < 0.01
                ),
            }
            let s = score(h, p, f("annualVol"), f("cascadePressure"));
            assert_eq!(s as u64, e["score"].as_u64().unwrap(), "{}", c["name"]);
            assert_eq!(tier(s), e["tier"].as_str().unwrap());
        }
    }

    #[test]
    fn tremor_falls_back_without_history() {
        let (s, fallback) = tremor(&[], 0.0);
        assert!(fallback && (s * HOURS_PER_YEAR.sqrt() - DEFAULT_ANNUAL_VOL).abs() < 1e-12);
    }

    #[test]
    fn vault_risk_and_hedge_ratio_match_the_shared_fixtures() {
        let raw = include_str!("../../packages/core/fixtures/vault-cases.json");
        let v: Value = serde_json::from_str(raw).unwrap();
        for c in v["vaultRisk"].as_array().unwrap() {
            let f = |k: &str| c["input"][k].as_f64().unwrap();
            let r = vault_risk(&VaultRiskInput {
                size: f("size"),
                mark: f("mark"),
                liquidation: c["input"]["liquidationPx"].as_f64(),
                account_value: f("accountValue"),
                funding_rate: f("fundingRateHourly"),
                oracle_dev: f("oracleDeviation"),
                book_rate: f("bookRate"),
                rate: f("rate"),
                reserves_ratio_bps: f("reservesRatioBps") as u32,
            });
            let e = &c["expected"];
            let got = [
                r.liquidation,
                r.margin,
                r.funding,
                r.oracle,
                r.rate,
                r.reserves,
            ];
            let keys = [
                "liquidation",
                "margin",
                "funding",
                "oracle",
                "rate",
                "reserves",
            ];
            for (k, g) in keys.iter().zip(got) {
                assert_eq!(
                    g as u64,
                    e["components"][k].as_u64().unwrap(),
                    "{} {k}",
                    c["name"]
                );
            }
            assert_eq!(
                r.score as u64,
                e["score"].as_u64().unwrap(),
                "{}",
                c["name"]
            );
        }
        for c in v["hedgeRatio"].as_array().unwrap() {
            let (bps, _) = crate::modes::hedge_ratio(
                c["maxBps"].as_u64().unwrap() as u32,
                c["minBps"].as_u64().unwrap() as u32,
                c["fundingSum7d"].as_f64(),
            );
            assert_eq!(bps as u64, c["expected"].as_u64().unwrap(), "{}", c["name"]);
        }
    }
}
