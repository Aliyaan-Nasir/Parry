/**
 * Crash replay: runs Parry's own risk model, planner and vault math through real historical NEAR
 * price crashes, hour by hour, and measures what they would have done. Everything here is pure:
 * the candles come in (scripts/replay.ts fetches them from a public source) and every number in
 * the result is computed from them and the parameters below.
 */

import { rebalance, type VaultBook } from "./hedge.js";
import { assess, assessPerp, tremor, type LendingPosition, type Sample } from "./risk.js";
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
 * would overlap it is excluded, and so on. Hourly candles are assumed.
 */
export function findCrashes(candles: readonly Candle[], opts: { windowHours?: number; count?: number; skipHours?: number } = {}): CrashSpan[] {
  const w = opts.windowHours ?? 72;
  const skip = opts.skipHours ?? 0;
  const count = opts.count ?? 6;
  const n = candles.length;
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
  const order = drops.filter((d): d is CrashSpan => d !== null && d.peak >= skip).sort((a, b) => b.drop - a.drop);
  for (const d of order) {
    if (taken.length >= count) break;
    if (blocked[d.peak]) continue;
    taken.push(d);
    for (let j = Math.max(0, d.peak - 2 * w); j <= Math.min(n - 1, d.peak + 2 * w); j++) blocked[j] = 1;
  }
  return taken;
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

/** The vault's settings in the replay: the deployed vault's hedge ratio and leverage cap. */
export interface VaultParams {
  navUsd: number;
  hedgeRatio: number;
  /** Leverage the short opens at (notional / margin). */
  openLeverage: number;
  maxLeverage: number;
  /** Annual staking yield of the LiNEAR the vault holds. */
  stakingApr: number;
  /** Hyperliquid's maintenance margin for NEAR, as a fraction of notional. */
  maintenanceMargin: number;
  /** Score at or above which the vault asks for margin (the vault contract's MARGIN_SCORE). */
  marginScore: number;
  /** Cost of a rebalance order, as a fraction of the traded notional. */
  tradeCost: number;
  insuranceShareBps: number;
  insuranceCapPerDayBps: number;
}

export const DEFAULT_VAULT_PARAMS: Omit<VaultParams, "stakingApr"> = {
  navUsd: 10_000,
  hedgeRatio: 0.9,
  openLeverage: 2,
  maxLeverage: 3,
  maintenanceMargin: 0.05,
  marginScore: 85,
  tradeCost: 0.0005,
  insuranceShareBps: 1000,
  insuranceCapPerDayBps: 2500,
};

export interface VaultReplay {
  navWith: { t: string; v: number }[];
  navUnhedged: { t: string; v: number }[];
  maxDrawdownPct: number;
  maxDrawdownUnhedgedPct: number;
  /** Lowest margin ratio (hedge account value / short notional). */
  marginMin: number;
  /** Insurance fund at the start: 10 % of the positive yield of the 30 days before. */
  insuranceFundUsd: number;
  insurancePaidUsd: number;
  insurancePaid: { negativeFundingUsd: number; marginTopUpUsd: number };
  fundingUsd: number;
  rebalances: number;
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
 * The delta-neutral vault through the same candles: LiNEAR staked and a short sized by the hedge
 * ratio, rebalanced with `rebalance()`, paid or charged real funding, scored with `assessPerp`
 * (the vault asks for margin at its margin score), with the insurance fund paying negative funding
 * and margin top-ups within its daily cap. Against it: the same deposit, all staked, unhedged.
 */
export function replayVault(candles: readonly Candle[], funding: readonly FundingPoint[], from: number, to: number, params: Partial<VaultParams> & { stakingApr: number }): VaultReplay {
  const v = { ...DEFAULT_VAULT_PARAMS, ...params };
  const p0 = candles[from]!.close;
  const hourGrowth = (1 + v.stakingApr) ** (1 / 8760);
  let staked = v.navUsd / (p0 * (1 + v.hedgeRatio / v.openLeverage));
  let short = v.hedgeRatio * staked;
  const margin0 = (short * p0) / v.openLeverage;
  let accountValue = margin0;
  let unhedged = v.navUsd / p0;

  // The fund: 10 % of the positive yield over the 30 days before the window.
  const t0 = candles[from]!.t;
  const before = fundingIn(funding, t0 - 30 * 86_400, t0);
  const stakingYield = staked * p0 * v.stakingApr * (30 / 365);
  const positiveFunding = before.reduce((s, f) => s + Math.max(0, f.rate) * short * p0, 0);
  let fund = (v.insuranceShareBps / 10_000) * (stakingYield + positiveFunding);
  const insuranceFundUsd = fund;
  const paidByDay = new Map<number, number>();
  let negativeFundingUsd = 0;
  let marginTopUpUsd = 0;
  const pay = (t: number, want: number): number => {
    const day = Math.floor(t / 86_400);
    const cap = (v.insuranceCapPerDayBps / 10_000) * insuranceFundUsd - (paidByDay.get(day) ?? 0);
    const amount = Math.max(0, Math.min(want, fund, cap));
    fund -= amount;
    paidByDay.set(day, (paidByDay.get(day) ?? 0) + amount);
    return amount;
  };

  const navWith: { t: string; v: number }[] = [];
  const navUnhedged: { t: string; v: number }[] = [];
  let marginMin = Infinity;
  let fundingUsd = 0;
  let rebalances = 0;
  for (let i = from; i <= to; i++) {
    const c = candles[i]!;
    const prev = i > from ? candles[i - 1]!.close : p0;
    if (i > from) {
      staked *= hourGrowth;
      unhedged *= hourGrowth;
      accountValue += -short * (c.close - prev);
      for (const f of fundingIn(funding, c.t, c.t + 3600)) {
        const paid = f.rate * short * c.close;
        accountValue += paid;
        fundingUsd += paid;
        // Negative funding (the short pays) is payable from the fund.
        if (paid < 0) {
          const covered = pay(c.t, -paid);
          accountValue += covered;
          negativeFundingUsd += covered;
        }
      }
    }
    // The vault's own score of the short: Hyperliquid liquidates it once equity falls to the
    // maintenance margin, P' = (equity + S P) / (S (1 + mm)).
    const liq = short > 0 ? (accountValue + short * c.close) / (short * (1 + v.maintenanceMargin)) : null;
    const scored = assessPerp({ size: -short, markPrice: c.close, liquidationPx: liq, history: samplesUpTo(candles, i), now: c.t });
    if (scored.score.score >= v.marginScore) {
      const want = (short * c.close) / v.openLeverage - accountValue;
      if (want > 0) {
        const topUp = pay(c.t, want);
        accountValue += topUp;
        marginTopUpUsd += topUp;
      }
    }
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
      hedgeRatio: v.hedgeRatio,
      maxLeverage: v.maxLeverage,
    };
    const r = rebalance(book);
    if (r.act) {
      accountValue -= Math.abs(r.delta) * c.close * v.tradeCost;
      short = r.target;
      rebalances++;
    }
    marginMin = Math.min(marginMin, short > 0 ? accountValue / (short * c.close) : Infinity);
    navWith.push({ t: iso(c.t), v: staked * c.close + accountValue });
    navUnhedged.push({ t: iso(c.t), v: unhedged * c.close });
  }
  return {
    navWith,
    navUnhedged,
    maxDrawdownPct: 100 * maxDrawdown(navWith.map((x) => x.v)),
    maxDrawdownUnhedgedPct: 100 * maxDrawdown(navUnhedged.map((x) => x.v)),
    marginMin: Number.isFinite(marginMin) ? marginMin : 0,
    insuranceFundUsd,
    insurancePaidUsd: negativeFundingUsd + marginTopUpUsd,
    insurancePaid: { negativeFundingUsd, marginTopUpUsd },
    fundingUsd,
    rebalances,
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
 * every hour outside the crash windows, and `panic` the level (on a 0.05 grid, above `stressed`)
 * that maximizes the share of crash hours flagged minus the share of ordinary hours flagged, among
 * the levels that flag at most `maxFalseRate` (5 %) of ordinary hours: panic must stay rare.
 */
export function calibrateRegimes(candles: readonly Candle[], crashes: readonly CrashSpan[], series = tremorSeries(candles), maxFalseRate = 0.05): RegimeCalibration {
  const inCrash = new Uint8Array(candles.length);
  const nearCrash = new Uint8Array(candles.length);
  for (const c of crashes) {
    for (let i = c.peak; i <= c.trough; i++) inCrash[i] = 1;
    for (let i = Math.max(0, c.peak - 72); i <= Math.min(candles.length - 1, c.trough + 72); i++) nearCrash[i] = 1;
  }
  // The first 12 hours have too little history for the index.
  const crash = series.filter((_, i) => i >= 12 && inCrash[i]);
  const ordinary = series.filter((_, i) => i >= 12 && !nearCrash[i]);
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

export const median = (xs: number[]): number | null => (xs.length ? quantile(xs, 0.5) : null);
