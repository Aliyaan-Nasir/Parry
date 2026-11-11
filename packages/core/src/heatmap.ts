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
 * `width` × price wide. Accounts already under water (liquidation price above today's) go into
 * the first bucket.
 */
export function heatBuckets(accounts: readonly HeatmapAccount[], price: number, opts: { width?: number; floor?: number } = {}): HeatBucket[] {
  const width = (opts.width ?? 0.02) * price;
  const floor = (opts.floor ?? 0.3) * price;
  const n = Math.max(1, Math.ceil((price - floor) / width));
  const buckets: HeatBucket[] = Array.from({ length: n }, (_, i) => ({ price: price - i * width, collateralUsd: 0, debtUsd: 0, accounts: 0 }));
  for (const a of accounts) {
    if (a.liqPrice === null || a.liqPrice < floor) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor((price - a.liqPrice) / width)));
    const b = buckets[i]!;
    b.collateralUsd += a.collateralUsd;
    b.debtUsd += a.debtUsd;
    b.accounts += 1;
  }
  return buckets;
}

export interface CascadeParams {
  /** USD of driver sold that moves the price down 2 % (market depth). */
  depth2pctUsd: number;
  /** Liquidation bonus the liquidator takes on the debt it repays. */
  bonus: number;
}

export const DEFAULT_CASCADE_PARAMS: CascadeParams = { depth2pctUsd: 1_500_000, bonus: 0.05 };

export interface CascadeRun {
  /** The price the first liquidation happens at. */
  from: number;
  /** The price once no further account is reached. */
  to: number;
  /** Collateral of every account liquidated along the way. */
  collateralUsd: number;
  accounts: number;
  /** Rounds of liquidations: 1 means no chain. */
  rounds: number;
}

/**
 * What a fall to `start` sets off: every account with a liquidation price at or above it is
 * liquidated, its liquidator sells the seized driver collateral (the debt plus the bonus, at most
 * the collateral), which moves the price down by 2 % per `depth2pctUsd`, which may reach more
 * accounts, and so on until no new account is reached.
 */
export function runCascade(accounts: readonly HeatmapAccount[], price: number, start: number, p: CascadeParams = DEFAULT_CASCADE_PARAMS): CascadeRun {
  const live = accounts.filter((a) => a.liqPrice !== null && a.liqPrice > 0).sort((a, b) => b.liqPrice! - a.liqPrice!);
  let at = start;
  let next = 0;
  let collateralUsd = 0;
  let count = 0;
  let rounds = 0;
  let soldUsd = 0;
  for (;;) {
    let reached = 0;
    while (next < live.length && live[next]!.liqPrice! >= at) {
      const a = live[next]!;
      // Collateral is worth less at the liquidation price than today.
      const scale = Math.min(1, a.liqPrice! / price);
      soldUsd += Math.min(a.driverCollateralUsd * scale, a.debtUsd * (1 + p.bonus));
      collateralUsd += a.collateralUsd;
      count++;
      reached++;
      next++;
    }
    if (reached === 0) break;
    rounds++;
    const impact = Math.min(0.5, (0.02 * soldUsd) / p.depth2pctUsd);
    at = start * (1 - impact);
  }
  return { from: start, to: at, collateralUsd, accounts: count, rounds };
}

/**
 * The chained cascades on a market: a cascade started at each bucket's price, kept when it
 * reaches past the next bucket (two rounds or more), the largest first.
 */
export function chainedCascades(accounts: readonly HeatmapAccount[], price: number, buckets: readonly HeatBucket[], p: CascadeParams = DEFAULT_CASCADE_PARAMS, limit = 20): CascadeRun[] {
  const out: CascadeRun[] = [];
  for (const b of buckets) {
    if (b.accounts === 0) continue;
    const r = runCascade(accounts, price, b.price, p);
    if (r.rounds >= 2) out.push(r);
  }
  return out.sort((a, b) => b.collateralUsd - a.collateralUsd).slice(0, limit);
}

export interface HeatmapPressure {
  /** Collateral a 2σ daily fall liquidates, chain included. */
  atRiskUsd: number;
  /** The extra fall the cascade adds, relative to the 2σ fall itself, capped at 1. */
  pressure: number;
  /** Where the chain ends. */
  to: number;
  accounts: number;
}

/**
 * Cascade pressure from the heatmap: start a cascade at the 2σ daily fall (2 σ √24 in log terms);
 * pressure is the extra log fall the liquidations add, over the 2σ fall, capped at 1. One means
 * the liquidations alone would double the move.
 */
export function heatmapPressure(accounts: readonly HeatmapAccount[], price: number, sigmaHourly: number, p: CascadeParams = DEFAULT_CASCADE_PARAMS): HeatmapPressure {
  const band = 2 * sigmaHourly * Math.sqrt(24);
  const start = price * Math.exp(-band);
  const r = runCascade(accounts, price, start, p);
  const extra = r.to > 0 ? Math.log(start / r.to) : 0;
  return { atRiskUsd: r.collateralUsd, pressure: band > 0 ? clamp(extra / band) : 0, to: r.to, accounts: r.accounts };
}
