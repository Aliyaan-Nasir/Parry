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

/**
 * The vault contract's score levers (`contracts/vault/src/report.rs`): a score at `pauseScore`
 * pauses deposits until one under `resumeScore`; at `reduceLeverageScore` the leverage cap drops
 * to `reducedLeverage` until a score under `restoreLeverageScore`; at `marginScore` the vault asks
 * the keeper for margin. A test reads the contract source and keeps these equal.
 */
export const VAULT_LEVERS = {
  pauseScore: 70,
  resumeScore: 60,
  reduceLeverageScore: 50,
  restoreLeverageScore: 40,
  reducedLeverage: 2,
  marginScore: 85,
} as const;

/**
 * Floors on the vault's score from the short's liquidation distance (liquidation price over the
 * mark, minus 1), as `VAULT_MARGIN_DISTANCE` and `VAULT_PAUSE_DISTANCE` in enclave/src/risk.rs:
 * under `marginDistance` the score is at least the margin score (with a 5 % maintenance margin, a
 * margin ratio of about 0.21, just above the keeper's early mark of 0.2), under `pauseDistance`
 * at least the pause score (about 0.26, under the 1/3 the leverage cap of 3 keeps).
 */
export const VAULT_SCORE_FLOORS = { marginDistance: 0.15, pauseDistance: 0.2 } as const;

export interface VaultRiskInput {
  /** Signed short size (negative is short), NEAR. */
  size: number;
  mark: number;
  /** Hyperliquid's liquidation price for the position, or null. */
  liquidationPx: number | null;
  /** The hedge account's value, USD. */
  accountValue: number;
  /** Hyperliquid's current funding rate, per hour (negative: shorts pay). */
  fundingRateHourly: number;
  /** Mark against the oracle, as a fraction. */
  oracleDeviation: number;
  /** NEAR per LiNEAR the vault last booked, and now. */
  bookRate: number;
  rate: number;
  /** Reserves over liabilities, bps. */
  reservesRatioBps: number;
}

export interface VaultRisk {
  /** Each 0..10000: bps of "fully risky". */
  components: { liquidation: number; margin: number; funding: number; oracle: number; rate: number; reserves: number };
  score: number;
}

const unit = (x: number) => Math.min(1, Math.max(0, x));
const toBps = (x: number) => (Number.isFinite(x) ? Math.min(999_999, Math.max(0, Math.round(x * 10_000))) : 999_999);

/**
 * The vault's risk score as the enclave signs it into every vault report (`risk::vault_risk` in
 * enclave/src/risk.rs; both pass fixtures/vault-cases.json): 35 % how close the short's
 * liquidation price is (full at the mark, none 50 % above it), 25 % leverage (full at leverage 5), 10 %
 * funding paid by shorts (full at 1 bp an hour), 10 % oracle deviation (full at 2 %), 5 % a fall
 * of the LiNEAR rate (full at 1 %) and 15 % a reserves shortfall (full at 5 %). Then floors on
 * the liquidation distance (`VAULT_SCORE_FLOORS`): a short whose liquidation price is under 20 %
 * above the mark scores at least the pause score, under 15 % at least the margin score.
 */
export function vaultRisk(i: VaultRiskInput): VaultRisk {
  const distance = i.liquidationPx !== null && i.size < 0 && i.mark > 0 ? i.liquidationPx / i.mark - 1 : null;
  const liquidation = distance === null ? 0 : toBps(unit(1 - distance / 0.5));
  const floor = distance === null ? 0 : distance < VAULT_SCORE_FLOORS.marginDistance ? VAULT_LEVERS.marginScore : distance < VAULT_SCORE_FLOORS.pauseDistance ? VAULT_LEVERS.pauseScore : 0;
  const leverage = i.accountValue > 0 ? (Math.abs(i.size) * i.mark) / i.accountValue : 0;
  const margin = toBps(unit(leverage / 5));
  const funding = toBps(unit(-i.fundingRateHourly / 0.0001));
  const oracle = toBps(unit(i.oracleDeviation / 0.02));
  const rate = i.bookRate > 0 ? toBps(unit((i.bookRate - i.rate) / i.bookRate / 0.01)) : 0;
  const reserves = toBps(unit((10_000 - i.reservesRatioBps) / 500));
  const weighted = Math.round((0.35 * liquidation + 0.25 * margin + 0.1 * funding + 0.1 * oracle + 0.05 * rate + 0.15 * reserves) / 100);
  const score = Math.min(100, Math.max(weighted, floor));
  return { components: { liquidation, margin, funding, oracle, rate, reserves }, score };
}

/**
 * The hedge ratio the enclave asks the vault for (`modes::hedge_ratio`): the full ratio while
 * shorts are paid over the last 7 days (or the funding is unknown), leaning toward the minimum as
 * 7-day funding turns against the short, all the way at 20 % a year paid; rounded down to 1 %.
 * `fundingSum7d` is the sum of the hourly rates over the 7 days.
 */
export function hedgeRatioForFunding(maxBps: number, minBps: number, fundingSum7d: number | null): number {
  const min = Math.min(minBps, maxBps);
  if (fundingSum7d === null || !Number.isFinite(fundingSum7d)) return maxBps;
  const apr = (fundingSum7d * 365) / 7;
  if (apr >= 0) return maxBps;
  const lean = unit(-apr / 0.2);
  const raw = maxBps - (maxBps - min) * lean;
  return Math.min(maxBps, Math.max(min, Math.floor(raw / 100) * 100));
}
