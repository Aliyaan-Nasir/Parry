/**
 * Parry's risk model. Every formula is documented in docs/risk-model.md and mirrored in the
 * enclave (enclave/src/risk.rs); both are tested against fixtures/risk-cases.json.
 *
 * Units: prices in USD, time in hours, volatility per square-root hour unless named `annual`.
 */

import { bisect, clamp, normCdf, slope } from "./math.js";

export type Tier = "safe" | "caution" | "danger" | "critical";
export type TremorLevel = "calm" | "elevated" | "high" | "extreme";

/** One collateral or debt line of a lending position. */
export interface Line {
  symbol: string;
  amount: number;
  priceUsd: number;
  /** Rhea's volatility ratio, 0..1 (collateral counts at value × ratio, debt at value / ratio). */
  volatilityRatio: number;
  /** True when the line moves with the driver asset (NEAR, wNEAR, LiNEAR for NEAR). */
  driver: boolean;
}

export interface LendingPosition {
  collateral: Line[];
  debt: Line[];
}

/** Rhea health factor: Σ collateral × ratio / Σ debt / ratio; Infinity without debt. */
export function healthFactor(p: LendingPosition): number {
  const c = p.collateral.reduce((s, l) => s + l.amount * l.priceUsd * l.volatilityRatio, 0);
  const d = p.debt.reduce((s, l) => s + (l.amount * l.priceUsd) / l.volatilityRatio, 0);
  return d === 0 ? Infinity : c / d;
}

/**
 * The driver price at which health reaches 1, holding everything else fixed. Health is
 * (A_s + P a_n) / (D_s + P d_n), so P_liq = (D_s − A_s) / (a_n − d_n). Null when the position is
 * not long the driver (a_n ≤ d_n) or can never be liquidated by a price fall.
 */
export function liquidationPrice(p: LendingPosition, driverPrice: number): number | null {
  let as = 0;
  let an = 0;
  let ds = 0;
  let dn = 0;
  for (const l of p.collateral) {
    const v = l.amount * l.volatilityRatio;
    if (l.driver) an += (v * l.priceUsd) / driverPrice;
    else as += v * l.priceUsd;
  }
  for (const l of p.debt) {
    const v = l.amount / l.volatilityRatio;
    if (l.driver) dn += (v * l.priceUsd) / driverPrice;
    else ds += v * l.priceUsd;
  }
  if (an <= dn) return null;
  const pl = (ds - as) / (an - dn);
  return pl > 0 ? pl : null;
}

/** Fractional distance of the price above the liquidation price: 1 − P_liq / P. */
export function distanceToLiquidation(price: number, liqPrice: number | null): number {
  if (liqPrice === null) return 1;
  return Math.max(0, 1 - liqPrice / price);
}

/** A price sample. */
export interface Sample {
  /** Unix seconds. */
  t: number;
  price: number;
}

export interface TremorWindow {
  hours: number;
  weight: number;
  /** Realized volatility per square-root hour, or null without enough samples. */
  sigma: number | null;
  samples: number;
}

export interface Tremor {
  /** Per square-root hour. */
  sigmaHourly: number;
  /** Annualized: sigmaHourly × sqrt(8760). */
  annual: number;
  level: TremorLevel;
  windows: TremorWindow[];
  /** True when no window had data and the default was used. */
  fallback: boolean;
}

export const TREMOR_WINDOWS: ReadonlyArray<{ hours: number; weight: number }> = [
  { hours: 1, weight: 0.5 },
  { hours: 4, weight: 0.3 },
  { hours: 12, weight: 0.2 },
];
/** Used when there is no price history yet: a typical annual volatility for NEAR. */
export const DEFAULT_ANNUAL_VOL = 0.7;
const HOURS_PER_YEAR = 8760;

export function tremorLevel(annual: number): TremorLevel {
  if (annual < 0.4) return "calm";
  if (annual < 0.8) return "elevated";
  if (annual < 1.3) return "high";
  return "extreme";
}

/**
 * The Tremor index: realized volatility of log returns over the last 1, 4 and 12 hours, each
 * σ_W = sqrt(Σ r² / hours(W)), combined as sqrt(Σ w σ_W² / Σ w) with time-decay weights 0.5, 0.3
 * and 0.2, so the most recent hour weighs most. Windows without two samples drop out and the
 * weights renormalize.
 */
export function tremor(samples: Sample[], now: number): Tremor {
  const sorted = [...samples].filter((s) => s.price > 0).sort((a, b) => a.t - b.t);
  const windows: TremorWindow[] = TREMOR_WINDOWS.map(({ hours, weight }) => {
    const from = now - hours * 3600;
    const inWindow = sorted.filter((s) => s.t >= from && s.t <= now);
    if (inWindow.length < 2) return { hours, weight, sigma: null, samples: inWindow.length };
    let sumSq = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const r = Math.log(inWindow[i]!.price / inWindow[i - 1]!.price);
      sumSq += r * r;
    }
    const spanHours = (inWindow[inWindow.length - 1]!.t - inWindow[0]!.t) / 3600;
    const sigma = spanHours > 0 ? Math.sqrt(sumSq / spanHours) : null;
    return { hours, weight, sigma, samples: inWindow.length };
  });
  const used = windows.filter((w) => w.sigma !== null);
  if (used.length === 0) {
    const sigmaHourly = DEFAULT_ANNUAL_VOL / Math.sqrt(HOURS_PER_YEAR);
    return { sigmaHourly, annual: DEFAULT_ANNUAL_VOL, level: tremorLevel(DEFAULT_ANNUAL_VOL), windows, fallback: true };
  }
  const wsum = used.reduce((s, w) => s + w.weight, 0);
  const variance = used.reduce((s, w) => s + w.weight * w.sigma! * w.sigma!, 0) / wsum;
  const sigmaHourly = Math.sqrt(variance);
  const annual = sigmaHourly * Math.sqrt(HOURS_PER_YEAR);
  return { sigmaHourly, annual, level: tremorLevel(annual), windows, fallback: false };
}

/**
 * The trend of log price per hour used in the hitting probabilities: the least-squares slope over
 * the last 4 hours, halved (momentum decays) and capped at one σ per hour either way, so a short
 * burst cannot dominate the forecast.
 */
export function trend(samples: Sample[], now: number, sigmaHourly: number): number {
  const inWindow = samples.filter((s) => s.t >= now - 4 * 3600 && s.t <= now && s.price > 0);
  if (inWindow.length < 3) return 0;
  const raw = slope(
    inWindow.map((s) => s.t / 3600),
    inWindow.map((s) => Math.log(s.price)),
  );
  return clamp(0.5 * raw, -sigmaHourly, sigmaHourly);
}

/**
 * Probability that the price touches the liquidation price within `hours`: first passage of
 * log price (a Brownian motion with trend m and volatility σ) below a barrier d = ln(P / P_liq)
 * away: Φ((−d − mT)/(σ√T)) + exp(−2md/σ²) Φ((−d + mT)/(σ√T)).
 */
export function liquidationProbability(price: number, liqPrice: number | null, sigmaHourly: number, trendHourly: number, hours: number): number {
  if (liqPrice === null || hours <= 0) return 0;
  if (price <= liqPrice) return 1;
  const d = Math.log(price / liqPrice);
  const s = sigmaHourly * Math.sqrt(hours);
  if (s <= 0) return trendHourly < 0 && -trendHourly * hours >= d ? 1 : 0;
  const m = trendHourly;
  const a = normCdf((-d - m * hours) / s);
  // exp(−2md/σ²) can overflow when the trend is strongly down; combine in log space.
  const logB = (-2 * m * d) / (sigmaHourly * sigmaHourly) + Math.log(Math.max(normCdf((-d + m * hours) / s), 1e-300));
  return clamp(a + Math.exp(Math.min(logB, 0)));
}

export interface TimeToLiquidation {
  /** Median first-passage time in hours (P_hit = 0.5), or null beyond 30 days. */
  medianHours: number | null;
  /** Hours until the trend alone reaches the barrier, or null when the trend is not down. */
  trendHours: number | null;
}

const MAX_HOURS = 30 * 24;

export function timeToLiquidation(price: number, liqPrice: number | null, sigmaHourly: number, trendHourly: number): TimeToLiquidation {
  if (liqPrice === null) return { medianHours: null, trendHours: null };
  if (price <= liqPrice) return { medianHours: 0, trendHours: 0 };
  const d = Math.log(price / liqPrice);
  const trendHours = trendHourly < 0 ? d / -trendHourly : null;
  const p = (h: number) => liquidationProbability(price, liqPrice, sigmaHourly, trendHourly, h);
  const medianHours = p(MAX_HOURS) < 0.5 ? null : bisect(p, 0.5, 0, MAX_HOURS);
  return { medianHours, trendHours: trendHours !== null && trendHours <= MAX_HOURS ? trendHours : null };
}

/** A position seen by the cascade detector. */
export interface CascadeInput {
  owner: string;
  venue: string;
  liqPrice: number | null;
  collateralUsd: number;
}

export interface Cascade {
  /** Collateral (USD) that a 2σ (24h) fall would bring to liquidation. */
  atRiskUsd: number;
  /** atRiskUsd / reference liquidity, capped at 1. */
  pressure: number;
  /** Owners with positions on two or more venues that would liquidate in the same 2σ move. */
  correlatedOwners: string[];
}

/**
 * Cascade pressure across every monitored position on one driver: liquidations feed back into
 * the price, so the collateral a 2σ daily move would liquidate, relative to the market's
 * liquidity, measures how much worse the next move could get.
 */
export function cascade(positions: CascadeInput[], price: number, sigmaHourly: number, liquidityUsd: number): Cascade {
  const band = 2 * sigmaHourly * Math.sqrt(24);
  const inBand = positions.filter((p) => p.liqPrice !== null && p.liqPrice > 0 && Math.log(price / p.liqPrice) <= band);
  const atRiskUsd = inBand.reduce((s, p) => s + p.collateralUsd, 0);
  const venuesByOwner = new Map<string, Set<string>>();
  for (const p of inBand) {
    const set = venuesByOwner.get(p.owner) ?? new Set<string>();
    set.add(p.venue);
    venuesByOwner.set(p.owner, set);
  }
  const correlatedOwners = [...venuesByOwner.entries()].filter(([, v]) => v.size >= 2).map(([o]) => o);
  return { atRiskUsd, pressure: liquidityUsd > 0 ? clamp(atRiskUsd / liquidityUsd) : atRiskUsd > 0 ? 1 : 0, correlatedOwners };
}

/**
 * Equity lost at the 99th percentile over 24 hours: the driver exposure times a 2.326 σ fall,
 * plus a liquidation penalty on the debt when that fall crosses the liquidation price.
 */
export function valueAtRisk99(exposureUsd: number, debtUsd: number, price: number, liqPrice: number | null, sigmaHourly: number, penalty = 0.05): number {
  const move = 2.326 * sigmaHourly * Math.sqrt(24);
  const loss = Math.max(0, exposureUsd) * (1 - Math.exp(-move));
  const crosses = liqPrice !== null && price * Math.exp(-move) <= liqPrice;
  return loss + (crosses ? penalty * debtUsd : 0);
}

export interface ScoreInput {
  health: number;
  /** P_hit within 24 hours. */
  probability24h: number;
  annualVol: number;
  cascadePressure: number;
}

export interface Score {
  score: number;
  tier: Tier;
  components: { liquidation: number; volatility: number; cascade: number };
}

/**
 * The highest trigger health an owner may seal into a policy. The risk engine cannot read sealed
 * triggers, so it hands the guardian every protected position under this health (and any scored
 * caution or worse, the lowest trigger score allowed): the guardian then decides with the policy.
 */
export const MAX_TRIGGER_HEALTH = 1.5;

export function tierOf(score: number): Tier {
  if (score >= 75) return "critical";
  if (score >= 50) return "danger";
  if (score >= 25) return "caution";
  return "safe";
}

/**
 * S = round(100 × clamp(0.70 √H + 0.15 V + 0.15 C)) with H = P_hit(24h), V = clamp((σ_annual −
 * 0.3) / 1.2), C = cascade pressure. The square root makes small daily probabilities count (1%
 * adds 7 points, 25% adds 35). Health floors: below 1.10 is at least danger, below 1.03 is
 * critical, whatever the forecast says.
 */
export function riskScore(i: ScoreInput): Score {
  const liquidation = 0.7 * Math.sqrt(clamp(i.probability24h));
  const volatility = 0.15 * clamp((i.annualVol - 0.3) / 1.2);
  const cascadePart = 0.15 * clamp(i.cascadePressure);
  let score = Math.round(100 * clamp(liquidation + volatility + cascadePart));
  if (i.health < 1.03) score = Math.max(score, 75);
  else if (i.health < 1.1) score = Math.max(score, 50);
  return {
    score,
    tier: tierOf(score),
    components: { liquidation: Math.round(liquidation * 100), volatility: Math.round(volatility * 100), cascade: Math.round(cascadePart * 100) },
  };
}

export interface Assessment {
  health: number;
  driverPrice: number;
  liqPrice: number | null;
  distance: number;
  tremor: Tremor;
  trendHourly: number;
  probability24h: number;
  probability4h: number;
  ttl: TimeToLiquidation;
  valueAtRisk99: number;
  score: Score;
}

/** The whole model for one lending position. */
export function assess(p: LendingPosition, driverPrice: number, history: Sample[], now: number, cascadePressure = 0): Assessment {
  const health = healthFactor(p);
  const liqPrice = liquidationPrice(p, driverPrice);
  const tr = tremor(history, now);
  const m = trend(history, now, tr.sigmaHourly);
  const probability24h = liquidationProbability(driverPrice, liqPrice, tr.sigmaHourly, m, 24);
  const probability4h = liquidationProbability(driverPrice, liqPrice, tr.sigmaHourly, m, 4);
  const exposure =
    p.collateral.filter((l) => l.driver).reduce((s, l) => s + l.amount * l.priceUsd, 0) -
    p.debt.filter((l) => l.driver).reduce((s, l) => s + l.amount * l.priceUsd, 0);
  const debtUsd = p.debt.reduce((s, l) => s + l.amount * l.priceUsd, 0);
  return {
    health,
    driverPrice,
    liqPrice,
    distance: distanceToLiquidation(driverPrice, liqPrice),
    tremor: tr,
    trendHourly: m,
    probability24h,
    probability4h,
    ttl: timeToLiquidation(driverPrice, liqPrice, tr.sigmaHourly, m),
    valueAtRisk99: valueAtRisk99(exposure, debtUsd, driverPrice, liqPrice, tr.sigmaHourly),
    score: riskScore({ health, probability24h, annualVol: tr.annual, cascadePressure }),
  };
}

/**
 * A perp position (Hyperliquid): its barrier is the venue's own liquidation price, and a short is
 * liquidated by a rise, so its distance is measured upward.
 */
export function assessPerp(o: { size: number; markPrice: number; liquidationPx: number | null; history: Sample[]; now: number; cascadePressure?: number }): Assessment {
  const tr = tremor(o.history, o.now);
  const long = o.size > 0;
  // A short behaves like a long on 1/P: mirror the barrier so the same first-passage formula applies.
  const price = long ? o.markPrice : 1 / o.markPrice;
  const liq = o.liquidationPx === null ? null : long ? o.liquidationPx : 1 / o.liquidationPx;
  const m = (long ? 1 : -1) * trend(o.history, o.now, tr.sigmaHourly);
  const probability24h = liquidationProbability(price, liq, tr.sigmaHourly, m, 24);
  const distance = distanceToLiquidation(price, liq);
  // A perp's "health": 1 + distance to liquidation, so 1.0 means at the liquidation price.
  const health = liq === null ? Infinity : 1 + distance;
  return {
    health,
    driverPrice: o.markPrice,
    liqPrice: o.liquidationPx,
    distance,
    tremor: tr,
    trendHourly: m,
    probability24h,
    probability4h: liquidationProbability(price, liq, tr.sigmaHourly, m, 4),
    ttl: timeToLiquidation(price, liq, tr.sigmaHourly, m),
    valueAtRisk99: valueAtRisk99(Math.abs(o.size) * o.markPrice, 0, price, liq, tr.sigmaHourly),
    score: riskScore({ health, probability24h, annualVol: tr.annual, cascadePressure: o.cascadePressure ?? 0 }),
  };
}
