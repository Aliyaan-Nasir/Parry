/**
 * The delta-neutral vault's math, as the vault contract computes it: net asset value, share
 * price, the target short, the rebalance decision and Hyperliquid's price and size formatting.
 */

export interface VaultBook {
  /** LiNEAR held (whole tokens). */
  stakedLinear: number;
  /** NEAR per LiNEAR. */
  linearRate: number;
  /** NEAR/USD. */
  nearPrice: number;
  /** Hyperliquid account value, USD. */
  accountValue: number;
  /** Operator-funded margin on testnet, excluded from depositors' value. */
  marginBaseline: number;
  /** Hedge PnL already paid out to leavers, USD. */
  settledPnl: number;
  totalShares: number;
  queuedShares: number;
  /** Signed: negative is short (NEAR). */
  hedgeSize: number;
  hedgeRatio: number;
  maxLeverage: number;
}

export const nearExposure = (b: VaultBook): number => b.stakedLinear * b.linearRate;

export const hedgeEquity = (b: VaultBook): number => b.accountValue - b.marginBaseline - b.settledPnl;

/** NAV = LiNEAR value + hedge equity, floored at 0. */
export const nav = (b: VaultBook): number => Math.max(0, nearExposure(b) * b.nearPrice + hedgeEquity(b));

/** USD per share; 1 before the first deposit. */
export const sharePrice = (b: VaultBook): number => (b.totalShares > 0 && nav(b) > 0 ? nav(b) / b.totalShares : 1);

/** Shares minted for a deposit worth `valueUsd`. */
export const sharesFor = (b: VaultBook, valueUsd: number): number =>
  b.totalShares > 0 && nav(b) > 0 ? (valueUsd * b.totalShares) / nav(b) : valueUsd;

/**
 * Target short size in NEAR: the hedge ratio of the exposure that belongs to shares not waiting
 * to leave, capped so the short's notional stays within the leverage limit of the margin.
 */
export function targetShort(b: VaultBook): number {
  const active = b.totalShares > 0 ? (b.totalShares - b.queuedShares) / b.totalShares : 1;
  const want = b.hedgeRatio * nearExposure(b) * active;
  const cap = b.nearPrice > 0 ? (b.maxLeverage * b.accountValue) / b.nearPrice : 0;
  return Math.min(want, cap);
}

/** Fraction of the NEAR exposure that is hedged right now. */
export const hedgedFraction = (b: VaultBook): number => (nearExposure(b) > 0 ? Math.abs(Math.min(0, b.hedgeSize)) / nearExposure(b) : 0);

/** Leverage of the short against the margin. */
export const hedgeLeverage = (b: VaultBook): number => (b.accountValue > 0 ? (Math.abs(b.hedgeSize) * b.nearPrice) / b.accountValue : 0);

export interface RebalanceDecision {
  target: number;
  current: number;
  /** Positive: sell more (grow the short); negative: buy back (shrink it). */
  delta: number;
  act: boolean;
}

/** Rebalances when the short is off target by more than 2% of the target or 1 NEAR. */
export function rebalance(b: VaultBook): RebalanceDecision {
  const target = targetShort(b);
  const current = Math.abs(Math.min(0, b.hedgeSize));
  const delta = target - current;
  return { target, current, delta, act: Math.abs(delta) >= Math.max(0.02 * target, 1) };
}

/** Hyperliquid size: rounded down to the asset's size decimals, no trailing zeros. */
export function formatSize(size: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return trimZeros((Math.floor(size * f + 1e-9) / f).toFixed(szDecimals));
}

/**
 * Hyperliquid perp price: at most 5 significant figures and at most 6 − szDecimals decimals, no
 * trailing zeros. A sell rounds down and a buy rounds up, so rounding never worsens the limit.
 */
export function formatPrice(price: number, szDecimals: number, roundUp: boolean): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const magnitude = Math.floor(Math.log10(price));
  const sigDecimals = Math.max(0, 4 - magnitude);
  const dp = Math.min(maxDecimals, sigDecimals);
  const f = 10 ** dp;
  const v = roundUp ? Math.ceil(price * f - 1e-9) / f : Math.floor(price * f + 1e-9) / f;
  return trimZeros(v.toFixed(dp));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export interface YieldBreakdown {
  /** Annualized staking yield implied by the LiNEAR rate's growth. */
  stakingApr: number;
  /** Annualized funding on the short, relative to NAV. */
  fundingApr: number;
}

/** Annualizes the LiNEAR rate growth and the funding earned over `days`. */
export function annualize(rateFrom: number, rateTo: number, fundingUsd: number, navUsd: number, days: number): YieldBreakdown {
  if (days <= 0) return { stakingApr: 0, fundingApr: 0 };
  return {
    stakingApr: rateFrom > 0 ? (rateTo / rateFrom - 1) * (365 / days) : 0,
    fundingApr: navUsd > 0 ? (fundingUsd / navUsd) * (365 / days) : 0,
  };
}
