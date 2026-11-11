import { describe, expect, test } from "bun:test";
import {
  calibrateRegimes,
  chainedCascades,
  findCrashes,
  heatBuckets,
  heatmapPressure,
  incidentSummary,
  joinsIncident,
  INCIDENT_WINDOW_MS,
  REGIME_THRESHOLDS,
  replayPosition,
  replayVault,
  routeSaving,
  runCascade,
  tremor,
  tremorRegime,
  type Candle,
  type HeatmapAccount,
} from "../src/index";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Hourly candles: flat with a small wiggle, then a fall of `drop` over `hours`, then flat. */
function crashCandles(opts: { flat: number; drop: number; hours: number; after: number; start?: number }): Candle[] {
  const out: Candle[] = [];
  let p = opts.start ?? 5;
  let t = 1_700_000_000;
  const push = (close: number) => {
    out.push({ t, open: p, high: Math.max(p, close), low: Math.min(p, close), close });
    p = close;
    t += 3600;
  };
  for (let i = 0; i < opts.flat; i++) push(p * (1 + 0.002 * Math.sin(i)));
  const step = (1 - opts.drop) ** (1 / opts.hours);
  for (let i = 0; i < opts.hours; i++) push(p * step);
  for (let i = 0; i < opts.after; i++) push(p * (1 + 0.001 * Math.sin(i)));
  return out;
}

describe("crash finder", () => {
  test("finds the largest 72 h drawdowns without overlap, largest first", () => {
    const a = crashCandles({ flat: 300, drop: 0.4, hours: 30, after: 300 });
    const b = crashCandles({ flat: 300, drop: 0.25, hours: 20, after: 300, start: a[a.length - 1]!.close }).map((c) => ({ ...c, t: c.t + a.length * 3600 }));
    const all = [...a, ...b];
    const spans = findCrashes(all, { count: 2 });
    expect(spans).toHaveLength(2);
    expect(spans[0]!.drop).toBeCloseTo(0.4, 2);
    expect(spans[1]!.drop).toBeCloseTo(0.25, 2);
    expect(Math.abs(spans[0]!.peak - spans[1]!.peak)).toBeGreaterThan(144);
    expect(findCrashes(all, { count: 2, skipHours: 400 })[0]!.drop).toBeCloseTo(0.25, 2);
  });
});

describe("position replay", () => {
  const candles = crashCandles({ flat: 48, drop: 0.45, hours: 36, after: 24 });
  const r = replayPosition(candles, 48, candles.length - 1);

  test("the unprotected position is liquidated, warned about first", () => {
    expect(r.liquidatedAt).not.toBeNull();
    expect(r.warningHours).toBeGreaterThan(0);
    expect(r.healthWithout[0]!.h).toBeCloseTo(1.3, 6);
  });

  test("the guardian keeps the protected one above 1 with planned steps", () => {
    expect(r.liquidatedWithParryAt).toBeNull();
    expect(r.steps.length).toBeGreaterThan(0);
    expect(r.minHealthWith).toBeGreaterThan(1);
    for (const s of r.steps) expect(s.healthAfter).toBeGreaterThan(s.healthBefore);
    // The reserve pays first (repay-first), then collateral is sold.
    expect(r.steps[0]!.action).toBe("repay");
    expect(r.collateralSoldNear).toBeGreaterThan(0);
  });

  test("respects the actions-per-day cap", () => {
    const capped = replayPosition(candles, 48, candles.length - 1, { maxActionsPerDay: 1 });
    const times = capped.steps.map((s) => Date.parse(s.t));
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(86_400_000);
  });
});

describe("vault replay", () => {
  const candles = crashCandles({ flat: 48, drop: 0.45, hours: 36, after: 24 });
  test("the hedge holds the NAV while the unhedged stake falls with NEAR", () => {
    const v = replayVault(candles, [], 48, candles.length - 1, { stakingApr: 0.05 });
    expect(v.maxDrawdownUnhedgedPct).toBeGreaterThan(40);
    expect(v.maxDrawdownPct).toBeLessThan(10);
    expect(v.marginMin).toBeGreaterThan(0.4);
    expect(v.insurancePaidUsd).toBe(0);
  });

  test("negative funding is paid from the fund within its daily cap", () => {
    const funding = [];
    for (let t = candles[0]!.t - 30 * 86_400; t < candles[candles.length - 1]!.t; t += 8 * 3600) funding.push({ t, rate: t < candles[48]!.t ? 0.001 : -0.001 });
    const v = replayVault(candles, funding, 48, candles.length - 1, { stakingApr: 0.05 });
    expect(v.insuranceFundUsd).toBeGreaterThan(0);
    expect(v.insurancePaid.negativeFundingUsd).toBeGreaterThan(0);
    // At most 25 % of the fund per UTC day: the window spans at most 5 days.
    expect(v.insurancePaidUsd).toBeLessThanOrEqual(v.insuranceFundUsd * 0.25 * 5 + 1e-9);
  });
});

describe("regimes", () => {
  test("thresholds map the Tremor index to calm, stressed and panic", () => {
    expect(tremorRegime(0.5)).toBe("calm");
    expect(tremorRegime(REGIME_THRESHOLDS.stressed)).toBe("stressed");
    expect(tremorRegime(REGIME_THRESHOLDS.panic + 0.1)).toBe("panic");
    expect(tremor([], 1).regime).toBe("calm");
  });

  test("calibration puts panic above stressed and flags crash hours more than ordinary ones", () => {
    const candles = crashCandles({ flat: 500, drop: 0.5, hours: 24, after: 500 });
    const cal = calibrateRegimes(candles, findCrashes(candles, { count: 1 }));
    expect(cal.panic).toBeGreaterThan(cal.stressed);
    expect(cal.panicHitRate).toBeGreaterThan(cal.panicFalseRate);
    expect(cal.panicFalseRate).toBeLessThanOrEqual(0.05);
  });

  const committed = join(import.meta.dir, "..", "..", "..", "deployments", "replay.json");
  test.skipIf(!existsSync(committed))("the committed thresholds are the ones the replay data chose", () => {
    const f = JSON.parse(readFileSync(committed, "utf8")) as { calibration: { regime: { stressed: number; panic: number } } };
    expect(f.calibration.regime.stressed).toBe(REGIME_THRESHOLDS.stressed);
    expect(f.calibration.regime.panic).toBe(REGIME_THRESHOLDS.panic);
  });
});

describe("heatmap", () => {
  const accounts: HeatmapAccount[] = [
    { account: "a", liqPrice: 2.9, driverCollateralUsd: 1_000_000, collateralUsd: 1_000_000, debtUsd: 700_000 },
    { account: "b", liqPrice: 2.87, driverCollateralUsd: 2_000_000, collateralUsd: 2_000_000, debtUsd: 1_500_000 },
    { account: "c", liqPrice: 2.0, driverCollateralUsd: 500_000, collateralUsd: 500_000, debtUsd: 200_000 },
    { account: "d", liqPrice: null, driverCollateralUsd: 0, collateralUsd: 10_000, debtUsd: 5_000 },
  ];

  test("buckets collateral by liquidation price", () => {
    const b = heatBuckets(accounts, 3, { width: 0.1 });
    expect(b[0]!.price).toBe(3);
    expect(b.reduce((s, x) => s + x.accounts, 0)).toBe(3);
    const at = b.find((x) => x.accounts === 2)!;
    expect(at.collateralUsd).toBe(3_000_000);
  });

  test("a liquidation's sale reaches the next account: a chained cascade", () => {
    const r = runCascade(accounts, 3, 2.9, { depth2pctUsd: 1_000_000, bonus: 0.05 });
    expect(r.rounds).toBe(2);
    expect(r.accounts).toBe(2);
    expect(r.to).toBeLessThan(2.87);
    const chains = chainedCascades(accounts, 3, heatBuckets(accounts, 3), { depth2pctUsd: 1_000_000, bonus: 0.05 });
    expect(chains.length).toBeGreaterThan(0);
    expect(chains[0]!.from).toBeGreaterThan(chains[0]!.to);
  });

  test("pressure is the extra fall over a 2σ day, zero without accounts in reach", () => {
    expect(heatmapPressure([], 3, 0.01).pressure).toBe(0);
    const p = heatmapPressure(accounts, 3, 0.01, { depth2pctUsd: 1_000_000, bonus: 0.05 });
    expect(p.atRiskUsd).toBe(3_000_000);
    expect(p.pressure).toBeGreaterThan(0);
    expect(p.pressure).toBeLessThanOrEqual(1);
  });
});

describe("route savings", () => {
  test("the chosen route against the worst quote", () => {
    const s = routeSaving({ amountNear: 10, rhea: { outUsd: 30 }, intents: { outUsd: 31.5 }, chosen: "intents" });
    expect(s.savedUsd).toBeCloseTo(1.5, 9);
    expect(s.worst).toEqual({ venue: "rhea", outUsd: 30 });
    const one = routeSaving({ amountNear: 10, rhea: { outUsd: 30 }, intents: { unavailable: "1Click: down" }, chosen: "rhea" });
    expect(one.savedUsd).toBe(0);
    expect(one.quotes[1]!.unavailable).toBe("1Click: down");
  });
});

describe("incidents", () => {
  test("alerts within the window join one incident, summarised worst first", () => {
    expect(joinsIncident(0, INCIDENT_WINDOW_MS, false)).toBe(true);
    expect(joinsIncident(0, INCIDENT_WINDOW_MS + 1, false)).toBe(false);
    expect(joinsIncident(0, 10, true)).toBe(false);
    const s = incidentSummary([
      { kind: "risk", severity: "warning", key: "risk:x:rhea:main", title: "Rhea: risk 60", body: "b1" },
      { kind: "health", severity: "critical", key: "health:x:rhea:main", title: "Rhea: health 1.04", body: "b2" },
      { kind: "risk", severity: "info", key: "risk:x:hyperliquid:NEAR", title: "Perp: risk 30", body: "b3" },
    ]);
    expect(s.severity).toBe("critical");
    expect(s.title).toBe("2 positions affected: Rhea: health 1.04");
    expect(incidentSummary([{ kind: "risk", severity: "info", key: "k", title: "t", body: "b" }]).title).toBe("t");
  });
});
