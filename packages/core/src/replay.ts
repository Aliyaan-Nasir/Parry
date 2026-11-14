/**
 * Crash replay: runs Parry's own risk model, planner and vault math through real historical NEAR
 * price crashes, hour by hour, and measures what they would have done. Everything here is pure:
 * the candles come in (scripts/replay.ts fetches them from a public source) and every number in
 * the result is computed from them and the parameters below.
 */

import { hedgeRatioForFunding, rebalance, VAULT_LEVERS, vaultRisk, type VaultBook } from "./hedge.js";
import { assess, tremor, type LendingPosition, type Sample } from "./risk.js";
import { plan, STRATEGIES, simpleHealth, type SimplePosition } from "./strategy.js";

/** One hourly candle; `t` is the open time in unix seconds. */
export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A funding payment of the perp: positive means longs pay shorts. `t` in unix seconds. */
export interface FundingPoint {
  t: number;
  rate: number;
}

export interface CrashSpan {
  /** Index of the peak candle (the close the drop is measured from). */
  peak: number;
  /** Index of the lowest close within the window after the peak. */
  trough: number;
  /** 1 − trough close / peak close. */
  drop: number;
}

/**
 * The `count` largest drawdowns over `windowHours`: for every candle, the fall from its close to
 * the lowest close within the next `windowHours`; the largest is taken, every candle whose window
 * would overlap it is excluded, and so on. Hourly candles are assumed. Candles marked in
 * `exclude` are off limits: no drawdown whose window touches one is considered.
 */
export function findCrashes(candles: readonly Candle[], opts: { windowHours?: number; count?: number; skipHours?: number; exclude?: Uint8Array } = {}): CrashSpan[] {
  const w = opts.windowHours ?? 72;
  const skip = opts.skipHours ?? 0;
  const count = opts.count ?? 6;
  const n = candles.length;
  // Prefix counts of excluded candles, so "does [i, i + w] touch one" is one subtraction.
  const excludedBefore = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) excludedBefore[i + 1] = excludedBefore[i]! + (opts.exclude?.[i] ? 1 : 0);
  const clear = (i: number) => excludedBefore[Math.min(n, i + w + 1)]! - excludedBefore[i]! === 0;
  // Sliding-window minimum of the closes in (i, i + w], scanned from the end.
  const minAfter = new Array<number>(n).fill(-1);
  const deque: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    // The window for i is (i, i + w]: add i + 1, drop indices beyond i + w.
    const add = i + 1;
    if (add < n) {
      while (deque.length && candles[deque[deque.length - 1]!]!.close >= candles[add]!.close) deque.pop();
      deque.push(add);
    }
    while (deque.length && deque[0]! > i + w) deque.shift();
    minAfter[i] = deque.length ? deque[0]! : -1;
  }
  const drops = candles.map((c, i) => (minAfter[i]! >= 0 ? { peak: i, trough: minAfter[i]!, drop: 1 - candles[minAfter[i]!]!.close / c.close } : null));
  const taken: CrashSpan[] = [];
  const blocked = new Uint8Array(n);
  const order = drops.filter((d): d is CrashSpan => d !== null && d.peak >= skip && clear(d.peak)).sort((a, b) => b.drop - a.drop);
  for (const d of order) {
    if (taken.length >= count) break;
    if (blocked[d.peak]) continue;
    taken.push(d);
    for (let j = Math.max(0, d.peak - 2 * w); j <= Math.min(n - 1, d.peak + 2 * w); j++) blocked[j] = 1;
  }
  return taken;
}

export interface SpikeSpan {
  /** Index of the low candle (the close the rally is measured from). */
  start: number;
  /** Index of the highest close within the window after it. */
  peak: number;
  /** Peak close / start close − 1. */
  rise: number;
}

/**
 * The `count` largest rallies over `windowHours`, by the same rule as `findCrashes` mirrored: for
 * every candle, the rise from its close to the highest close within the next `windowHours`; the
 * largest is taken, every candle whose window would overlap it is excluded, and so on. (It is
 * `findCrashes` on 1 / price: the largest fall of 1 / P is the largest rise of P.)
 */
export function findSpikes(candles: readonly Candle[], opts: { windowHours?: number; count?: number; skipHours?: number; exclude?: Uint8Array } = {}): SpikeSpan[] {
  const inverse = candles.map((c) => ({ t: c.t, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close }));
  return findCrashes(inverse, opts).map((d) => ({ start: d.peak, peak: d.trough, rise: candles[d.trough]!.close / candles[d.peak]!.close - 1 }));
}

/** The guardian's settings in the replay: the defaults an owner gets (docs/risk-model.md, section 9). */
export interface GuardianParams {
  startHealth: number;
  collateralNear: number;
  collateralRatio: number;
  debtRatio: number;
  triggerScore: number;
  triggerHealth: number;
  targetHealth: number;
  /** Most guardian actions per rolling 24 hours (the mandate's `max_actions_per_day`). */
  maxActionsPerDay: number;
  /** USDC rescue reserve as a fraction of the starting debt; the daily cap equals the reserve. */
  reserveFraction: number;
  /** The planner's slippage bound, and the slippage a swap actually gets. */
  maxSlippage: number;
  realizedSlippage: number;
  /** Score at or above which the model warns (the default alert threshold, "danger"). */
  warnScore: number;
}

export const DEFAULT_GUARDIAN_PARAMS: GuardianParams = {
  startHealth: 1.3,
  collateralNear: 1000,
  collateralRatio: 0.75,
  debtRatio: 0.95,
  triggerScore: 60,
  triggerHealth: 1.15,
  targetHealth: 1.45,
  maxActionsPerDay: 4,
  reserveFraction: 0.1,
  maxSlippage: 0.02,
  realizedSlippage: 0.005,
  warnScore: 50,
};

export interface ReplayStep {
  t: string;
  action: "repay" | "add_collateral" | "deleverage";
  plan: string;
  healthBefore: number;
  healthAfter: number;
}

export interface PositionReplay {
  startHealth: number;
  /** Hours between the model's first warning (score at the alert threshold) and the liquidation without Parry; null when it was never liquidated or never warned. */
  warningHours: number | null;
  /** When the unprotected position was liquidated (a candle's low under health 1), or null. */
  liquidatedAt: string | null;
  /** When the protected position was liquidated anyway, or null. */
  liquidatedWithParryAt: string | null;
  /** The model's median time to liquidation at its first warning, in hours. */
  predictedHoursAtWarning: number | null;
  /** Score and health at the first warning. */
  warnedAt: string | null;
  steps: ReplayStep[];
  healthWith: { t: string; h: number }[];
  healthWithout: { t: string; h: number }[];
  minHealthWith: number;
  reserveSpentUsd: number;
  collateralSoldNear: number;
}

const iso = (t: number) => new Date(t * 1000).toISOString();
const samplesUpTo = (candles: readonly Candle[], i: number, hours = 12): Sample[] =>
  candles.slice(Math.max(0, i - hours), i + 1).map((c) => ({ t: c.t, price: c.close }));

function lending(p: SimplePosition): LendingPosition {
  return {
    collateral: [{ symbol: "wNEAR", amount: p.collateral, priceUsd: p.price, volatilityRatio: p.collateralRatio, driver: true }],
    debt: [{ symbol: "USDC", amount: p.debt, priceUsd: 1, volatilityRatio: p.debtRatio, driver: false }],
  };
}

/**
 * A Rhea wNEAR/USDC position opened at `startHealth` on the close of candle `from`, replayed to
 * candle `to` twice: alone, and protected by the guardian (assess, trigger, plan, act, once per
 * hour). A candle whose low takes health under 1 liquidates.
 */
export function replayPosition(candles: readonly Candle[], from: number, to: number, params: Partial<GuardianParams> = {}): PositionReplay {
  const g = { ...DEFAULT_GUARDIAN_PARAMS, ...params };
  const p0 = candles[from]!.close;
  const a = g.collateralRatio * g.debtRatio;
  const debt0 = (g.collateralNear * p0 * a) / g.startHealth;
  const unprotected: SimplePosition = { collateral: g.collateralNear, debt: debt0, price: p0, collateralRatio: g.collateralRatio, debtRatio: g.debtRatio };
  let pos: SimplePosition = { ...unprotected };
  const reserve = g.reserveFraction * debt0;
  let reserveLeft = reserve;
  const spentByDay = new Map<number, number>();
  const actions: number[] = [];
  const steps: ReplayStep[] = [];
  const healthWith: { t: string; h: number }[] = [];
  const healthWithout: { t: string; h: number }[] = [];
  let liquidatedAt: number | null = null;
  let liquidatedWithParryAt: number | null = null;
  let warnedAt: number | null = null;
  let predictedHoursAtWarning: number | null = null;
  let minHealthWith = Infinity;
  let sold = 0;
  const strategy = STRATEGIES.find((s) => s.id === "repay-first")!;

  for (let i = from; i <= to; i++) {
    const c = candles[i]!;
    const at = (price: number, p: SimplePosition) => simpleHealth({ ...p, price });
    // Without Parry.
    const hWithout = at(c.close, unprotected);
    healthWithout.push({ t: iso(c.t), h: hWithout });
    if (liquidatedAt === null && at(c.low, unprotected) < 1) liquidatedAt = c.t;
    if (warnedAt === null && liquidatedAt === null) {
      const seen = assess(lending({ ...unprotected, price: c.close }), c.close, samplesUpTo(candles, i), c.t);
      if (seen.score.score >= g.warnScore) {
        warnedAt = c.t;
        predictedHoursAtWarning = seen.ttl.medianHours;
      }
    }
    // With Parry: the hour's low first (the guardian acts on the close), then the guardian.
    if (liquidatedWithParryAt === null && at(c.low, pos) < 1) liquidatedWithParryAt = c.t;
    pos = { ...pos, price: c.close };
    if (liquidatedWithParryAt === null) {
      const seen = assess(lending(pos), c.close, samplesUpTo(candles, i), c.t);
      const recent = actions.filter((t) => t > c.t - 86_400).length;
      const triggered = seen.score.score >= g.triggerScore || seen.health <= g.triggerHealth;
      if (triggered && recent < g.maxActionsPerDay) {
        const day = Math.floor(c.t / 86_400);
        const spentToday = spentByDay.get(day) ?? 0;
        const p = plan(strategy, pos, g.targetHealth, {
          repayBudget: Math.max(0, Math.min(reserveLeft, reserve - spentToday)),
          collateralBudget: 0,
          deleverageBudget: pos.collateral,
          maxSlippage: g.maxSlippage,
          withdrawFloor: 1.01,
          maxSteps: g.maxActionsPerDay - recent,
        });
        for (const s of p.steps) {
          const before = simpleHealth(pos);
          let text: string;
          if (s.kind === "repay") {
            pos = { ...pos, debt: Math.max(0, pos.debt - s.amount) };
            reserveLeft -= s.amount;
            spentByDay.set(day, (spentByDay.get(day) ?? 0) + s.amount);
            text = `Repay ${s.amount.toFixed(2)} USDC from the reserve (score ${seen.score.score}, health ${seen.health.toFixed(3)}).`;
          } else if (s.kind === "deleverage") {
            const out = s.amount * c.close * (1 - g.realizedSlippage);
            pos = { ...pos, collateral: pos.collateral - s.amount, debt: Math.max(0, pos.debt - out) };
            sold += s.amount;
            text = `Sell ${s.amount.toFixed(2)} NEAR for ${out.toFixed(2)} USDC (at least ${s.minOut?.toFixed(2)}) and repay (score ${seen.score.score}, health ${seen.health.toFixed(3)}).`;
          } else {
            pos = { ...pos, collateral: pos.collateral + s.amount };
            text = `Add ${s.amount.toFixed(2)} NEAR of collateral.`;
          }
          actions.push(c.t);
          steps.push({ t: iso(c.t), action: s.kind, plan: text, healthBefore: before, healthAfter: simpleHealth(pos) });
        }
      }
    }
    const h = simpleHealth(pos);
    minHealthWith = Math.min(minHealthWith, at(c.low, pos));
    healthWith.push({ t: iso(c.t), h: Number.isFinite(h) ? h : 99 });
  }
  return {
    startHealth: g.startHealth,
    warningHours: liquidatedAt !== null && warnedAt !== null ? (liquidatedAt - warnedAt) / 3600 : null,
    liquidatedAt: liquidatedAt === null ? null : iso(liquidatedAt),
    liquidatedWithParryAt: liquidatedWithParryAt === null ? null : iso(liquidatedWithParryAt),
    predictedHoursAtWarning,
    warnedAt: warnedAt === null ? null : iso(warnedAt),
    steps,
    healthWith,
    healthWithout,
    minHealthWith,
    reserveSpentUsd: reserve - reserveLeft,
    collateralSoldNear: sold,
  };
}

/**
 * The vault's settings in the replay: the deployed vault's configuration (hedge ratio bounds,
 * leverage cap; `deployments/mainnet.json` params), the keeper's margin target, the insurance
 * fund's defaults (`contracts/vault/src/insurance.rs`) and Hyperliquid's margin rule.
 */
export interface VaultParams {
  navUsd: number;
  /** The configured hedge ratio (the most a report may ask for) and the vault's floor for it. */
  hedgeRatio: number;
  hedgeRatioMin: number;
  /** Leverage the short opens at (notional / margin). */
  openLeverage: number;
  /** The configured leverage cap; an elevated score lowers it to `VAULT_LEVERS.reducedLeverage`. */
  maxLeverage: number;
  /** Annual staking yield of the LiNEAR the vault holds. */
  stakingApr: number;
  /** Hyperliquid's maintenance margin for NEAR, as a fraction of notional. */
  maintenanceMargin: number;
  /** Cost of a rebalance order, as a fraction of the traded notional. */
  tradeCost: number;
  insuranceShareBps: number;
  insuranceCapPerDayBps: number;
  /** The fund's per-payout cap, USD. */
  maxPayoutUsd: number;
  /** The keeper tops margin up to this share of the short's notional once the vault asks (`MARGIN_TARGET_RATIO`). */
  marginTargetRatio: number;
}

export const DEFAULT_VAULT_PARAMS: Omit<VaultParams, "stakingApr"> = {
  navUsd: 10_000,
  hedgeRatio: 0.9,
  hedgeRatioMin: 0.7,
  openLeverage: 2,
  maxLeverage: 3,
  maintenanceMargin: 0.05,
  tradeCost: 0.0005,
  insuranceShareBps: 1000,
  insuranceCapPerDayBps: 2500,
  maxPayoutUsd: 1000,
  marginTargetRatio: 0.4,
};

export interface VaultEvent {
  t: string;
  kind: "rebalance" | "margin_top_up" | "margin_top_up_refused" | "margin_top_up_unpaid" | "negative_funding" | "deposits_paused" | "deposits_resumed" | "leverage_reduced" | "leverage_restored" | "liquidated";
  detail: string;
}

export interface VaultReplay {
  navWith: { t: string; v: number }[];
  navUnhedged: { t: string; v: number }[];
  /**
   * Each hour: the margin ratio at the hour's high (the short's worst point, before the close's
   * rebalance), and at the close after the hour's report and rebalance the short (NEAR), its margin
   * ratio, Hyperliquid's liquidation price for it and the vault's score.
   */
  hedge: { t: string; marginAtHigh: number | null; short: number; marginRatio: number | null; liqPx: number | null; score: number }[];
  maxDrawdownPct: number;
  maxDrawdownUnhedgedPct: number;
  /** Lowest margin ratio (hedge account value / short notional), at each hour's worst price for the short (its high). */
  marginMin: number;
  marginMinAt: string | null;
  /** Closest the short came to liquidation: the least, over the hours, of its liquidation price over the hour's high, minus 1, in percent. Null without a short. */
  liquidationHeadroomMinPct: number | null;
  /** When a candle's high reached the short's liquidation price, or null. */
  liquidatedAt: string | null;
  /** The highest vault score, and the hours with deposits paused, leverage reduced and margin asked for. */
  maxScore: number;
  pausedHours: number;
  reducedLeverageHours: number;
  marginNeededHours: number;
  /** The short as a share of the NEAR exposure: the least, and at the end, in percent. */
  hedgedMinPct: number;
  hedgedEndPct: number;
  /** Share price (NAV over the opening NAV) at its lowest and at the end, and the unhedged stake at the end. */
  sharePriceMin: number;
  sharePriceEnd: number;
  unhedgedEnd: number;
  /** Insurance fund at the start (10 % of the positive yield of the 30 days before) and at the end. */
  insuranceFundUsd: number;
  insuranceFundEndUsd: number;
  /** What the fund paid: the keeper's negative funding covers and margin top-ups. */
  insurancePaidUsd: number;
  insurancePaid: { negativeFundingUsd: number; marginTopUpUsd: number };
  /** Margin top-ups paid (each clamped to what the fund may pay), any the vault refused, and the largest shortfall the vault asked to cover. */
  marginTopUps: number;
  marginTopUpsRefused: number;
  /** Hours the vault asked for margin and the keeper could pay nothing (the day's cap spent, or a payout already this hour). */
  marginTopUpsUnpaid: number;
  marginShortfallMaxUsd: number;
  fundingUsd: number;
  rebalances: number;
  /** Rebalances that bought part of the short back. */
  buybacks: number;
  events: VaultEvent[];
}

const fundingIn = (funding: readonly FundingPoint[], from: number, to: number) => funding.filter((f) => f.t >= from && f.t < to);

function maxDrawdown(series: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, 1 - v / peak);
  }
  return worst;
}

/**
 * Hyperliquid's liquidation price for a short of `size` NEAR on account value `equity` at `price`:
 * it is liquidated once equity falls to the maintenance margin, E − S (P' − P) = mm S P', so
 * P' = (E + S P) / (S (1 + mm)). Null without a short.
 */
export const shortLiquidationPrice = (equity: number, size: number, price: number, mm: number): number | null => (size > 0 ? (equity + size * price) / (size * (1 + mm)) : null);

/**
 * The delta-neutral vault through the same candles, by the rules the deployed vault, enclave and
 * keeper follow: LiNEAR staked and a short sized by the hedge ratio, which the enclave's report
 * lowers toward `hedgeRatioMin` while 7-day funding is paid by shorts (`hedgeRatioForFunding`);
 * real funding paid or charged; once an hour a vault report scored with the enclave's formula
 * (`vaultRisk`) whose score pauses deposits, lowers the leverage cap to 2 and asks for margin
 * with the contract's hysteresis (`VAULT_LEVERS`); the insurance fund as the contract keeps it
 * (its share of staking yield and funding received, owed the funding paid) and the keeper's two
 * payouts from it, the hourly negative funding cover and the margin top-up while the vault asks,
 * toward 40 % of notional, each clamped to what the fund may pay; and `rebalance()`, which trades the short
 * back to target whenever it is out of band, the target capped by the leverage cap on the hedge
 * account's value. A short is liquidated when an hour's high reaches its liquidation price, and
 * then loses its whole margin (Hyperliquid's backstop case). Against it: the same deposit, all
 * staked, unhedged.
 */
export function replayVault(candles: readonly Candle[], funding: readonly FundingPoint[], from: number, to: number, params: Partial<VaultParams> & { stakingApr: number }): VaultReplay {
  const v = { ...DEFAULT_VAULT_PARAMS, ...params };
  const share = v.insuranceShareBps / 10_000;
  const p0 = candles[from]!.close;
  const t0 = candles[from]!.t;
  const hourGrowth = (1 + v.stakingApr) ** (1 / 8760);
  // The funding-aware hedge ratio a report at t asks for: the 7-day sum of the funding rates.
  const ratioAt = (t: number) => {
    const week = funding.filter((f) => f.t > t - 7 * 86_400 && f.t <= t);
    const bps = hedgeRatioForFunding(Math.round(v.hedgeRatio * 10_000), Math.round(v.hedgeRatioMin * 10_000), week.length ? week.reduce((s, f) => s + f.rate, 0) : null);
    return bps / 10_000;
  };
  // The latest funding rate at t, per hour (Binance pays every 8 hours).
  const hourlyRateAt = (t: number) => {
    let rate = 0;
    for (const f of funding) {
      if (f.t > t) break;
      rate = f.rate / 8;
    }
    return rate;
  };
  const ratio0 = ratioAt(t0);
  let staked = v.navUsd / (p0 * (1 + ratio0 / v.openLeverage));
  let short = ratio0 * staked;
  let unhedged = v.navUsd / p0;

  // The insurance fund, as the contract keeps it: LiNEAR held by the vault (its share of the
  // staking yield) and USDC inside the hedge account (its share of the funding received), which
  // the depositors' value leaves out. It opens with its share of the 30 days before the window.
  const before = fundingIn(funding, t0 - 30 * 86_400, t0);
  let fundLinear = (share * staked * v.stakingApr * (30 / 365));
  let fundUsdc = share * before.reduce((s, f) => s + Math.max(0, f.rate) * short * p0, 0);
  // The hedge account holds the short's margin and the fund's USDC.
  let accountValue = (short * p0) / v.openLeverage + fundUsdc;
  // Earmarked for margin by top-ups: the fund's USDC (already in the hedge account) and LiNEAR
  // the operator routes into it; neither is the depositors'.
  let reservedUsdc = 0;
  let routedUsd = 0;
  const fundValue = (price: number) => fundUsdc + fundLinear * price;
  const insuranceFundUsd = fundValue(p0);
  // Funding received minus paid per report (the contract's window), and what is owed back.
  const window: number[] = [];
  let negativeOpen = 0;
  let paidDay = -1;
  let paidToday = 0;
  let dayValue = 0;
  /**
   * `insurance_pay` as the contract checks it: within the per-payout cap, the fund's value and the
   * day's cap (a share of the value at the day's first payout), else refused whole. Pays USDC
   * first, then LiNEAR; returns the two parts in USD, or null when refused.
   */
  const insurancePay = (t: number, price: number, amount: number): { usdc: number; linearUsd: number } | null => {
    const day = Math.floor(t / 86_400);
    const value = fundValue(price);
    if (day !== paidDay) {
      paidDay = day;
      paidToday = 0;
      dayValue = value;
    }
    if (amount <= 0 || amount > v.maxPayoutUsd || amount > value + 1e-9 || paidToday + amount > (v.insuranceCapPerDayBps / 10_000) * dayValue + 1e-9) return null;
    const usdc = Math.min(amount, fundUsdc);
    fundUsdc -= usdc;
    const linear = Math.min((amount - usdc) / price, fundLinear);
    fundLinear -= linear;
    paidToday += amount;
    return { usdc, linearUsd: linear * price };
  };
  let negativeFundingUsd = 0;
  let marginTopUpUsd = 0;
  let marginTopUps = 0;
  let marginTopUpsRefused = 0;
  let marginTopUpsUnpaid = 0;
  let marginNeededShortfallUsd = 0;

  let paused = false;
  let reduced = false;
  let needsMargin = false;
  let maxScore = 0;
  let pausedHours = 0;
  let reducedLeverageHours = 0;
  let marginNeededHours = 0;
  let liquidatedAt: number | null = null;
  let marginMin = Infinity;
  let marginMinAt: number | null = null;
  let headroomMin = Infinity;
  let hedgedMin = Infinity;
  let fundingUsd = 0;
  let rebalances = 0;
  let buybacks = 0;
  const events: VaultEvent[] = [];
  const navWith: { t: string; v: number }[] = [];
  const navUnhedged: { t: string; v: number }[] = [];
  const hedge: VaultReplay["hedge"] = [];
  const note = (t: number, kind: VaultEvent["kind"], detail: string) => events.push({ t: iso(t), kind, detail });

  for (let i = from; i <= to; i++) {
    const c = candles[i]!;
    let marginAtHigh: number | null = null;
    if (i > from) {
      const prev = candles[i - 1]!.close;
      // The hour's worst price for the short is its high, against the margin left at the last close.
      if (short > 0) {
        const liq = shortLiquidationPrice(accountValue, short, prev, v.maintenanceMargin)!;
        headroomMin = Math.min(headroomMin, liq / c.high - 1);
        const atHigh = (accountValue - short * (c.high - prev)) / (short * c.high);
        marginAtHigh = atHigh;
        if (atHigh < marginMin) {
          marginMin = atHigh;
          marginMinAt = c.t;
        }
        if (c.high >= liq) {
          liquidatedAt = c.t;
          note(c.t, "liquidated", `The hour's high ${c.high.toFixed(4)} reached the short's liquidation price ${liq.toFixed(4)}: ${short.toFixed(1)} NEAR closed and the hedge account's remaining ${(v.maintenanceMargin * short * liq).toFixed(2)} USD lost.`);
          short = 0;
          accountValue = 0;
          fundUsdc = 0;
          reservedUsdc = 0;
          routedUsd = 0;
        }
      }
      // Staking yield; the fund skims its share as the LiNEAR rate rises.
      const grown = staked * (hourGrowth - 1);
      staked += grown * (1 - share);
      fundLinear += grown * share;
      unhedged *= hourGrowth;
      accountValue += -short * (c.close - prev);
      let delta = 0;
      for (const f of fundingIn(funding, c.t, c.t + 3600)) {
        const paid = f.rate * short * c.close;
        accountValue += paid;
        fundingUsd += paid;
        delta += paid;
      }
      // The report's funding delta: the fund skims its share of funding received; funding paid is owed back.
      if (short > 0) {
        window.push(delta);
        if (window.length > 12) window.shift();
        if (delta > 0) fundUsdc += share * delta;
        else negativeOpen += -delta;
      }
    }

    // The hour's vault report, scored as the enclave scores it, and the vault's levers.
    const liq = shortLiquidationPrice(accountValue, short, c.close, v.maintenanceMargin);
    const risk = vaultRisk({ size: -short, mark: c.close, liquidationPx: liq, accountValue, fundingRateHourly: hourlyRateAt(c.t), oracleDeviation: 0, bookRate: 1, rate: 1, reservesRatioBps: 10_000 });
    const score = risk.score;
    maxScore = Math.max(maxScore, score);
    if (score >= VAULT_LEVERS.pauseScore && !paused) {
      paused = true;
      note(c.t, "deposits_paused", `Score ${score}: deposits paused.`);
    } else if (score < VAULT_LEVERS.resumeScore && paused) {
      paused = false;
      note(c.t, "deposits_resumed", `Score ${score}: deposits resumed.`);
    }
    if (score >= VAULT_LEVERS.reduceLeverageScore && !reduced) {
      reduced = true;
      note(c.t, "leverage_reduced", `Score ${score}: the leverage cap drops to ${VAULT_LEVERS.reducedLeverage}.`);
    } else if (score < VAULT_LEVERS.restoreLeverageScore && reduced) {
      reduced = false;
      note(c.t, "leverage_restored", `Score ${score}: the leverage cap is back at ${v.maxLeverage}.`);
    }
    needsMargin = score >= VAULT_LEVERS.marginScore;
    if (paused) pausedHours++;
    if (reduced) reducedLeverageHours++;
    if (needsMargin) marginNeededHours++;

    // The keeper's hourly negative funding cover (`fundingCover`): while the last reports show
    // funding paid, the least of what is owed back, the per-payout cap, the fund and the day's
    // cap left, at least a cent; it goes back to the depositors.
    let paidThisHour = false;
    const recent = window.reduce((s, x) => s + x, 0);
    if (recent < 0) {
      const value = fundValue(c.close);
      const sameDay = Math.floor(c.t / 86_400) === paidDay;
      const dayLeft = (v.insuranceCapPerDayBps / 10_000) * value - (sameDay ? paidToday : 0);
      const amount = Math.floor(Math.min(negativeOpen, v.maxPayoutUsd, value, dayLeft) * 1e6) / 1e6;
      if (amount >= 0.01) {
        const paid = insurancePay(c.t, c.close, amount);
        if (paid) {
          negativeOpen -= amount;
          staked += paid.linearUsd / c.close;
          negativeFundingUsd += amount;
          paidThisHour = true;
          note(c.t, "negative_funding", `The keeper covered ${amount.toFixed(2)} USD of funding the short paid from the insurance fund.`);
        }
      }
    }

    // The keeper's margin top-up (`marginDecision` with `payableUsd`): while the vault asks, the
    // shortfall back to the target ratio, clamped to what the fund may pay now (its value, the
    // per-payout cap and today's cap left) and floored to the cent; nothing under a cent; at most
    // one insurance payout an hour. USDC is earmarked where it is; LiNEAR is routed into the hedge
    // account.
    if (needsMargin && short > 0) {
      const shortfall = Math.max(0, v.marginTargetRatio * short * c.close - accountValue);
      if (shortfall > 0) {
        marginNeededShortfallUsd = Math.max(marginNeededShortfallUsd, shortfall);
        const value = fundValue(c.close);
        const sameDay = Math.floor(c.t / 86_400) === paidDay;
        const payable = Math.max(0, Math.min(value, (v.insuranceCapPerDayBps / 10_000) * value - (sameDay ? paidToday : 0), v.maxPayoutUsd));
        const amount = Math.floor(Math.min(shortfall, payable) * 100) / 100;
        if (amount >= 0.01 && !paidThisHour) {
          const paid = insurancePay(c.t, c.close, amount);
          if (paid) {
            reservedUsdc += paid.usdc;
            routedUsd += paid.linearUsd;
            accountValue += paid.linearUsd;
            marginTopUpUsd += amount;
            marginTopUps++;
            paidThisHour = true;
            const part = shortfall - amount >= 0.01 ? ` (of the ${shortfall.toFixed(2)} USD short: all the fund may pay now)` : "";
            note(c.t, "margin_top_up", `Score ${score}: the keeper paid ${amount.toFixed(2)} USD of margin from the insurance fund${part}.`);
          } else {
            marginTopUpsRefused++;
            note(c.t, "margin_top_up_refused", `Score ${score}: the vault refused the keeper's ${amount.toFixed(2)} USD margin top-up, above its daily cap.`);
          }
        } else {
          marginTopUpsUnpaid++;
          note(
            c.t,
            "margin_top_up_unpaid",
            amount < 0.01
              ? `Score ${score}: the vault asks for ${shortfall.toFixed(2)} USD of margin; the insurance fund may pay nothing more today (it holds ${value.toFixed(2)} USD).`
              : `Score ${score}: the vault asks for ${shortfall.toFixed(2)} USD of margin; the fund already paid out this hour.`,
          );
        }
      }
    }

    // The rebalance against this report.
    const maxLeverage = reduced ? Math.min(v.maxLeverage, VAULT_LEVERS.reducedLeverage) : v.maxLeverage;
    const book: VaultBook = {
      stakedLinear: staked,
      linearRate: 1,
      nearPrice: c.close,
      accountValue,
      marginBaseline: 0,
      settledPnl: 0,
      totalShares: 1,
      queuedShares: 0,
      hedgeSize: -short,
      hedgeRatio: ratioAt(c.t),
      maxLeverage,
    };
    const r = rebalance(book);
    if (r.act) {
      const leverage = accountValue > 0 ? (short * c.close) / accountValue : Infinity;
      const capped = r.target < book.hedgeRatio * staked - 1e-9;
      accountValue -= Math.abs(r.delta) * c.close * v.tradeCost;
      const why = capped ? `leverage ${Number.isFinite(leverage) ? leverage.toFixed(2) : "unbounded"} against the cap of ${maxLeverage}` : `hedge ratio ${(book.hedgeRatio * 100).toFixed(0)} %`;
      note(c.t, "rebalance", `${r.delta < 0 ? "Buy back" : "Sell"} ${Math.abs(r.delta).toFixed(1)} NEAR (${why}): short ${short.toFixed(1)} to ${r.target.toFixed(1)} NEAR.`);
      short = r.target;
      rebalances++;
      if (r.delta < 0) buybacks++;
    }
    hedgedMin = Math.min(hedgedMin, staked > 0 ? short / staked : 0);
    const after = shortLiquidationPrice(accountValue, short, c.close, v.maintenanceMargin);
    hedge.push({ t: iso(c.t), marginAtHigh, short, marginRatio: short > 0 ? accountValue / (short * c.close) : null, liqPx: after, score });
    // The depositors' value: their LiNEAR and the hedge account less what is the fund's or earmarked.
    navWith.push({ t: iso(c.t), v: staked * c.close + accountValue - fundUsdc - reservedUsdc - routedUsd });
    navUnhedged.push({ t: iso(c.t), v: unhedged * c.close });
  }
  const navs = navWith.map((x) => x.v);
  const last = candles[to]!.close;
  return {
    navWith,
    navUnhedged,
    hedge,
    maxDrawdownPct: 100 * maxDrawdown(navs),
    maxDrawdownUnhedgedPct: 100 * maxDrawdown(navUnhedged.map((x) => x.v)),
    marginMin: Number.isFinite(marginMin) ? marginMin : 0,
    marginMinAt: marginMinAt === null ? null : iso(marginMinAt),
    liquidationHeadroomMinPct: Number.isFinite(headroomMin) ? 100 * headroomMin : null,
    liquidatedAt: liquidatedAt === null ? null : iso(liquidatedAt),
    maxScore,
    pausedHours,
    reducedLeverageHours,
    marginNeededHours,
    hedgedMinPct: 100 * (Number.isFinite(hedgedMin) ? hedgedMin : 0),
    hedgedEndPct: 100 * (staked > 0 ? short / staked : 0),
    sharePriceMin: Math.min(...navs) / v.navUsd,
    sharePriceEnd: navs[navs.length - 1]! / v.navUsd,
    unhedgedEnd: navUnhedged[navUnhedged.length - 1]!.v / v.navUsd,
    insuranceFundUsd,
    insuranceFundEndUsd: fundValue(last),
    insurancePaidUsd: negativeFundingUsd + marginTopUpUsd,
    insurancePaid: { negativeFundingUsd, marginTopUpUsd },
    marginTopUps,
    marginTopUpsRefused,
    marginTopUpsUnpaid,
    marginShortfallMaxUsd: marginNeededShortfallUsd,
    fundingUsd,
    rebalances,
    buybacks,
    events,
  };
}

/** The Tremor index's annualized volatility at every candle, from the 12 hours of closes up to it. */
export function tremorSeries(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => tremor(samplesUpTo(candles, i), c.t).annual);
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (at - lo);
};

export interface RegimeCalibration {
  /** Tremor (annual) above which the market reads stressed: the 80th percentile of ordinary hours. */
  stressed: number;
  /** Tremor (annual) above which it reads panic: the threshold that best separates crash hours from ordinary hours (Youden's J) while flagging at most 5 % of ordinary hours. */
  panic: number;
  crashHours: number;
  ordinaryHours: number;
  /** Share of crash hours (peak to trough) at panic, and of ordinary hours at panic. */
  panicHitRate: number;
  panicFalseRate: number;
  stressedOrWorseInCrashes: number;
}

/**
 * Chooses the regime thresholds from the data: `stressed` is the 80th percentile of Tremor over
 * every ordinary hour (outside the 72 hours around each crash), and `panic` the level (on a 0.05
 * grid, above `stressed`) that maximizes the share of crash hours flagged minus the share of
 * ordinary hours flagged, among the levels that flag at most `maxFalseRate` (5 %) of ordinary
 * hours: panic must stay rare. Hours marked in `exclude` count as neither.
 */
export function calibrateRegimes(candles: readonly Candle[], crashes: readonly CrashSpan[], series = tremorSeries(candles), maxFalseRate = 0.05, exclude?: Uint8Array): RegimeCalibration {
  const inCrash = new Uint8Array(candles.length);
  const nearCrash = new Uint8Array(candles.length);
  for (const c of crashes) {
    for (let i = c.peak; i <= c.trough; i++) inCrash[i] = 1;
    for (let i = Math.max(0, c.peak - 72); i <= Math.min(candles.length - 1, c.trough + 72); i++) nearCrash[i] = 1;
  }
  // The first 12 hours have too little history for the index.
  const usable = (i: number) => i >= 12 && !exclude?.[i];
  const crash = series.filter((_, i) => usable(i) && inCrash[i]);
  const ordinary = series.filter((_, i) => usable(i) && !nearCrash[i]);
  const round = (x: number) => Math.round(x * 20) / 20;
  const stressed = round(quantile(ordinary, 0.8));
  let panic = stressed + 0.05;
  let best = -Infinity;
  for (let th = stressed + 0.05; th <= 6; th += 0.05) {
    const tpr = crash.filter((x) => x >= th).length / crash.length;
    const fpr = ordinary.filter((x) => x >= th).length / ordinary.length;
    if (fpr <= maxFalseRate && tpr - fpr > best + 1e-12) {
      best = tpr - fpr;
      panic = round(th);
    }
  }
  return {
    stressed,
    panic,
    crashHours: crash.length,
    ordinaryHours: ordinary.length,
    panicHitRate: crash.filter((x) => x >= panic).length / crash.length,
    panicFalseRate: ordinary.filter((x) => x >= panic).length / ordinary.length,
    stressedOrWorseInCrashes: crash.filter((x) => x >= stressed).length / crash.length,
  };
}

/** How a pair of thresholds reads a set of hours: the share at panic and at stressed or worse. */
export interface RegimeTest {
  hours: number;
  panicRate: number;
  stressedOrWorseRate: number;
}

export interface OutOfSampleCalibration extends RegimeCalibration {
  method: string;
  /** Hours set aside around the scored episodes: never used to choose the thresholds. */
  quarantineHours: number;
  quarantineMarginHours: number;
  /** The falls the thresholds were chosen on: the largest outside the quarantine. */
  calibrationCrashes: { start: string; trough: string; dropPct: number }[];
  /** The chosen thresholds on the scored hours they never saw: each scored crash's fall (peak to trough) and each scored spike's rise (low to peak). */
  test: { crashes: RegimeTest; spikes: RegimeTest };
}

const readsAt = (series: readonly number[], hours: readonly number[], t: { stressed: number; panic: number }): RegimeTest => ({
  hours: hours.length,
  panicRate: hours.length ? hours.filter((i) => series[i]! >= t.panic).length / hours.length : 0,
  stressedOrWorseRate: hours.length ? hours.filter((i) => series[i]! >= t.stressed).length / hours.length : 0,
});

/**
 * Out-of-sample regime thresholds: every hour from `marginHours` before each scored episode
 * (crash or spike) to `marginHours` after its extreme is set aside; the thresholds are chosen by
 * `calibrateRegimes` on the rest, with the `calibrationCrashes` largest 72-hour falls found
 * outside that quarantine as the crash hours; then they are tested on the scored episodes' own
 * hours, which played no part in choosing them.
 */
export function outOfSampleRegimes(
  candles: readonly Candle[],
  scored: { crashes: readonly CrashSpan[]; spikes: readonly SpikeSpan[] },
  opts: { marginHours?: number; calibrationCrashes?: number; skipHours?: number; series?: number[]; maxFalseRate?: number } = {},
): OutOfSampleCalibration {
  const margin = opts.marginHours ?? 72;
  const count = opts.calibrationCrashes ?? 12;
  const series = opts.series ?? tremorSeries(candles);
  const n = candles.length;
  const quarantine = new Uint8Array(n);
  const mark = (a: number, b: number) => {
    for (let i = Math.max(0, a - margin); i <= Math.min(n - 1, b + margin); i++) quarantine[i] = 1;
  };
  for (const c of scored.crashes) mark(c.peak, c.trough);
  for (const s of scored.spikes) mark(s.start, s.peak);
  const calibration = findCrashes(candles, { windowHours: 72, count, skipHours: opts.skipHours ?? 0, exclude: quarantine });
  const cal = calibrateRegimes(candles, calibration, series, opts.maxFalseRate ?? 0.05, quarantine);
  const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k).filter((i) => i >= 12);
  return {
    ...cal,
    method: `out of sample: the ${count} largest 72-hour falls outside a quarantine of ${margin} hours around every scored crash and spike, and the ordinary hours outside both`,
    quarantineHours: quarantine.reduce((s, x) => s + x, 0),
    quarantineMarginHours: margin,
    calibrationCrashes: calibration
      .sort((a, b) => a.peak - b.peak)
      .map((c) => ({ start: iso(candles[c.peak]!.t), trough: iso(candles[c.trough]!.t), dropPct: Math.round(c.drop * 10_000) / 100 })),
    test: {
      crashes: readsAt(series, scored.crashes.flatMap((c) => span(c.peak, c.trough)), cal),
      spikes: readsAt(series, scored.spikes.flatMap((s) => span(s.start, s.peak)), cal),
    },
  };
}

export const median = (xs: number[]): number | null => (xs.length ? quantile(xs, 0.5) : null);
