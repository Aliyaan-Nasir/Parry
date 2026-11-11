/**
 * The liquidation heatmap: where every lending account on a market would be liquidated as the
 * driver price falls, and which liquidations would push the price into the next ones (chained
 * cascades). The services read the accounts (Rhea lending, paged read-only); this is the math.
 */

import { clamp } from "./math.js";

export interface HeatmapAccount {
  account: string;
  /** The driver price at which health reaches 1, or null when a fall cannot liquidate it. */
  liqPrice: number | null;
  /** Collateral that moves with the driver, in USD at today's price (what liquidators would sell). */
  driverCollateralUsd: number;
  collateralUsd: number;
  debtUsd: number;
  /**
   * Risk-weighted driver exposure: Σ driver collateral × its volatility ratio − Σ driver debt / its
   * ratio, in driver units. Weighted collateral minus weighted debt changes by this much per dollar
   * of driver price. Absent for rows read before it was kept: then estimated from the collateral.
   */
  exposure?: number | null;
  /** Value-weighted volatility ratios of the collateral and the debt (0..1). */
  collateralRatio?: number | null;
  debtRatio?: number | null;
}

export interface HeatBucket {
  /** The bucket's upper price: accounts liquidate when the price falls to it or below, down to the next bucket. */
  price: number;
  collateralUsd: number;
  debtUsd: number;
  accounts: number;
}

/**
 * Buckets accounts by liquidation price, from today's price down to `floor` × price, each
 * `width` × price wide. Accounts already under water (liquidation price at or above today's) are
 * left out: a fall does not set them off, and `underwater` counts them.
 */
export function heatBuckets(accounts: readonly HeatmapAccount[], price: number, opts: { width?: number; floor?: number } = {}): HeatBucket[] {
  const width = (opts.width ?? 0.02) * price;
  const floor = (opts.floor ?? 0.3) * price;
  const n = Math.max(1, Math.ceil((price - floor) / width));
  const buckets: HeatBucket[] = Array.from({ length: n }, (_, i) => ({ price: price - i * width, collateralUsd: 0, debtUsd: 0, accounts: 0 }));
  for (const a of accounts) {
    // Already under health 1 at today's price: not something a fall sets off (see `underwater`).
    if (a.liqPrice === null || a.liqPrice < floor || a.liqPrice >= price) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor((price - a.liqPrice) / width)));
    const b = buckets[i]!;
    b.collateralUsd += a.collateralUsd;
    b.debtUsd += a.debtUsd;
    b.accounts += 1;
  }
  return buckets;
}

/** Accounts already under health 1 at today's price (bad debt, or collateral liquidators do not want). */
export function underwater(accounts: readonly HeatmapAccount[], price: number): { accounts: number; collateralUsd: number; debtUsd: number } {
  const xs = accounts.filter((a) => a.liqPrice !== null && a.liqPrice >= price);
  return { accounts: xs.length, collateralUsd: xs.reduce((s, a) => s + a.collateralUsd, 0), debtUsd: xs.reduce((s, a) => s + a.debtUsd, 0) };
}

export interface CascadeParams {
  /** USD of driver sold that moves the price down 2 % (market depth). */
  depth2pctUsd: number;
}

export const DEFAULT_CASCADE_PARAMS: CascadeParams = { depth2pctUsd: 1_500_000 };

/**
 * The driver (USD at `p`) liquidators sell when the price is `p`, under Rhea lending's own rule
 * (`internal_liquidate`): a liquidation is allowed only while health is under 1 and must leave it
 * under 1, and the liquidator's discount is d = (weighted debt − weighted collateral) / weighted
 * debt / 2. So the most liquidators can take is what brings health back to 1: repaying X of
 * debt removes X / v_d of weighted debt and X / (1 − d) × v_c of weighted collateral, so
 *
 *     X = (D_w − C_w) / (1 / v_d − v_c / (1 − d)),   seized = X / (1 − d)
 *
 * with D_w − C_w = exposure × (P_liq − p). The seized collateral is driver in proportion to the
 * account's driver collateral. Zero above the liquidation price.
 */
export function liquidationSaleUsd(a: HeatmapAccount, price: number, p: number): number {
  if (a.liqPrice === null || p >= a.liqPrice || a.debtUsd <= 0) return 0;
  const vc = a.collateralRatio ?? 0.75;
  const vd = a.debtRatio ?? 0.95;
  const exposure = a.exposure ?? (vc * a.driverCollateralUsd) / price;
  if (!(exposure > 0)) return 0;
  const gap = exposure * (a.liqPrice - p);
  const debtWeighted = a.debtUsd / vd;
  const d = Math.min(0.5, Math.max(0, gap / debtWeighted / 2));
  const denom = 1 / vd - vc / (1 - d);
  const seizedMax = a.collateralUsd * Math.min(1, p / price);
  const seized = denom > 0 ? Math.min(seizedMax, gap / denom / (1 - d)) : seizedMax;
  const driverShare = a.collateralUsd > 0 ? Math.min(1, a.driverCollateralUsd / a.collateralUsd) : 0;
  return seized * driverShare;
}

export interface CascadeRun {
  /** The price the cascade starts at. */
  from: number;
  /** The price once the liquidations' sales stop reaching further: the fixed point. */
  to: number;
  /** Collateral of every account the cascade puts under health 1. */
  collateralUsd: number;
  /** Driver liquidators sell along the way (USD). */
  soldUsd: number;
  accounts: number;
  /** Waves of newly reached accounts: 1 means no chain. */
  rounds: number;
}

/**
 * What a fall to `start` sets off: every account whose liquidation price is reached is liquidated
 * as far as Rhea allows (back to health 1, `liquidationSaleUsd`), the sales move the price down 2 %
 * per `depth2pctUsd`, the lower price deepens those liquidations and may reach more accounts, and so
 * on to the fixed point. Accounts already under water at today's price are left out.
 */
export function runCascade(accounts: readonly HeatmapAccount[], price: number, start: number, p: CascadeParams = DEFAULT_CASCADE_PARAMS): CascadeRun {
  const live = accounts.filter((a) => a.liqPrice !== null && a.liqPrice > 0 && a.liqPrice < price);
  let at = start;
  let reached = new Set<string>();
  let rounds = 0;
  let soldUsd = 0;
  for (let i = 0; i < 100; i++) {
    const hit = live.filter((a) => a.liqPrice! > at);
    if (hit.length > reached.size) rounds++;
    reached = new Set(hit.map((a) => a.account));
    soldUsd = hit.reduce((s, a) => s + liquidationSaleUsd(a, price, at), 0);
    const next = start * (1 - Math.min(0.5, (0.02 * soldUsd) / p.depth2pctUsd));
    if (Math.abs(next - at) <= 1e-9 * price) {
      at = next;
      break;
    }
    at = next;
  }
  const hit = live.filter((a) => reached.has(a.account));
  return { from: start, to: at, collateralUsd: hit.reduce((s, a) => s + a.collateralUsd, 0), soldUsd, accounts: hit.length, rounds };
}

/**
 * The chained cascades on a market: a cascade started at each bucket's price, kept when it
 * reaches past the next bucket (two waves or more), the largest first.
 */
export function chainedCascades(accounts: readonly HeatmapAccount[], price: number, buckets: readonly HeatBucket[], p: CascadeParams = DEFAULT_CASCADE_PARAMS, limit = 20): CascadeRun[] {
  const out: CascadeRun[] = [];
  for (const b of buckets) {
    if (b.accounts === 0) continue;
    // Just under the bucket's top, so its first account is reached.
    const r = runCascade(accounts, price, b.price * (1 - 1e-9), p);
    if (r.rounds >= 2) out.push(r);
  }
  return out.sort((a, b) => b.collateralUsd - a.collateralUsd).slice(0, limit);
}

export interface HeatmapPressure {
  /** Collateral of the accounts a 2σ daily fall puts under health 1, chain included. */
  atRiskUsd: number;
  /** Driver liquidators would sell (USD). */
  soldUsd: number;
  /** The extra fall the liquidations add, relative to the 2σ fall itself, capped at 1. */
  pressure: number;
  /** Where the chain ends. */
  to: number;
  accounts: number;
}

/**
 * Cascade pressure from the heatmap, the one definition both `/v1/market` and `/v1/heatmap` use:
 * start a cascade at the 2σ daily fall (2 σ √24 in log terms); pressure is the extra log fall the
 * liquidations add, over the 2σ fall, capped at 1. One means the liquidations alone would double
 * the move.
 */
export function heatmapPressure(accounts: readonly HeatmapAccount[], price: number, sigmaHourly: number, p: CascadeParams = DEFAULT_CASCADE_PARAMS): HeatmapPressure {
  const band = 2 * sigmaHourly * Math.sqrt(24);
  const start = price * Math.exp(-band);
  const r = runCascade(accounts, price, start, p);
  const extra = r.to > 0 ? Math.log(start / r.to) : 0;
  return { atRiskUsd: r.collateralUsd, soldUsd: r.soldUsd, pressure: band > 0 ? clamp(extra / band) : 0, to: r.to, accounts: r.accounts };
}
