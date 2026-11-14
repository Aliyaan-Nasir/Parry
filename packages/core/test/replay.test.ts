import { describe, expect, test } from "bun:test";
import vaultCases from "../fixtures/vault-cases.json";
import {
  calibrateRegimes,
  chainedCascades,
  DEFAULT_VAULT_PARAMS,
  findCrashes,
  findSpikes,
  hedgeRatioForFunding,
  outOfSampleRegimes,
  shortLiquidationPrice,
  VAULT_LEVERS,
  VAULT_SCORE_FLOORS,
  vaultRisk,
  heatBuckets,
  heatmapPressure,
  incidentSummary,
  liquidationSaleUsd,
  underwater,
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
  type FundingPoint,
  type HeatmapAccount,
  type VaultRiskInput,
} from "../src/index";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Hourly candles: flat with a small wiggle, then a fall of `drop` over `hours`, then flat (a negative drop is a rally). */
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
    expect(v.liquidatedAt).toBeNull();
    expect(v.insurancePaidUsd).toBe(0);
    expect(v.hedge).toHaveLength(candles.length - 48);
  });

  test("shorts paying funding over the week before lean the hedge toward its floor", () => {
    const funding: FundingPoint[] = [];
    for (let t = candles[0]!.t - 30 * 86_400; t < candles[candles.length - 1]!.t; t += 8 * 3600) funding.push({ t, rate: -0.001 });
    const v = replayVault(candles, funding, 48, candles.length - 1, { stakingApr: 0.05 });
    expect(v.hedgedMinPct).toBeCloseTo(100 * DEFAULT_VAULT_PARAMS.hedgeRatioMin, 0);
    expect(v.fundingUsd).toBeLessThan(0);
    // The keeper covers the funding paid from the fund, within its daily cap.
    expect(v.insurancePaid.negativeFundingUsd).toBeGreaterThan(0);
    expect(v.insurancePaid.negativeFundingUsd).toBeLessThanOrEqual(-v.fundingUsd + 1e-9);
    expect(v.insurancePaid.negativeFundingUsd).toBeLessThanOrEqual(v.insuranceFundUsd * 0.25 * 5 + 1e-6);
    expect(v.events.some((e) => e.kind === "negative_funding")).toBe(true);
  });

  test("a margin top-up pays what the fund may pay now, as the keeper clamps it", () => {
    const steep = crashCandles({ flat: 48, drop: -0.9, hours: 6, after: 24 });
    const before: FundingPoint[] = [];
    for (let t = steep[0]!.t - 30 * 86_400; t < steep[48]!.t; t += 8 * 3600) before.push({ t, rate: 0.0001 });
    const v = replayVault(steep, before, 48, steep.length - 1, { stakingApr: 0.05 });
    expect(v.marginNeededHours).toBeGreaterThan(0);
    expect(v.marginTopUps).toBeGreaterThan(0);
    expect(v.marginTopUpsRefused).toBe(0);
    // A partial top-up: at most a quarter of the fund on its day, far short of the shortfall.
    expect(v.insurancePaid.marginTopUpUsd).toBeGreaterThan(0);
    expect(v.insurancePaid.marginTopUpUsd).toBeLessThanOrEqual(0.25 * v.insuranceFundUsd * 2 + 0.01);
    expect(v.insurancePaid.marginTopUpUsd).toBeLessThan(v.marginShortfallMaxUsd);
    expect(v.events.some((e) => e.kind === "margin_top_up" && e.detail.includes("all the fund may pay now"))).toBe(true);
    // A fund large enough for the whole shortfall pays it.
    const rich: FundingPoint[] = before.map((f) => ({ ...f, rate: 0.01 }));
    const r = replayVault(steep, rich, 48, steep.length - 1, { stakingApr: 0.05, insuranceShareBps: 5000, insuranceCapPerDayBps: 10_000, maxPayoutUsd: 1e6 });
    expect(r.events.some((e) => e.kind === "margin_top_up" && !e.detail.includes("all the fund may pay now"))).toBe(true);
  });

  const rally = crashCandles({ flat: 48, drop: -0.9, hours: 36, after: 24 });
  test("in a rally the leverage cap buys the short back before Hyperliquid would liquidate it", () => {
    const v = replayVault(rally, [], 48, rally.length - 1, { stakingApr: 0.05 });
    expect(v.liquidatedAt).toBeNull();
    expect(v.buybacks).toBeGreaterThan(10);
    expect(v.marginMin).toBeGreaterThan(DEFAULT_VAULT_PARAMS.maintenanceMargin);
    expect(v.marginMin).toBeLessThan(0.5);
    expect(v.liquidationHeadroomMinPct!).toBeGreaterThan(0);
    // What the cap costs: most of the hedge is gone at the top, so the share price follows NEAR up.
    expect(v.hedgedEndPct).toBeLessThan(40);
    expect(v.sharePriceEnd).toBeGreaterThan(1);
    expect(v.sharePriceEnd).toBeLessThan(v.unhedgedEnd);
    expect(v.events.some((e) => e.kind === "rebalance" && e.detail.startsWith("Buy back"))).toBe(true);
  });

  test("without the cap the same rally liquidates the short at its liquidation price", () => {
    const v = replayVault(rally, [], 48, rally.length - 1, { stakingApr: 0.05, maxLeverage: 1000 });
    expect(v.liquidatedAt).not.toBeNull();
    expect(v.events.find((e) => e.kind === "liquidated")).toBeDefined();
    // Opened at leverage 2 with 5 % maintenance: liquidated about 43 % up from the open.
    const p0 = rally[48]!.close;
    const at = rally.find((c) => new Date(c.t * 1000).toISOString() === v.liquidatedAt)!;
    expect(at.high / p0).toBeGreaterThan(1.42);
    expect(v.hedgedEndPct).toBe(0);
  });

  test("an hour whose high jumps past the liquidation price liquidates, whatever the close", () => {
    const flat = crashCandles({ flat: 60, drop: 0, hours: 1, after: 0 });
    const p = flat[flat.length - 1]!.close;
    const jump: Candle[] = [...flat, { t: flat[flat.length - 1]!.t + 3600, open: p, high: p * 1.5, low: p, close: p * 1.01 }];
    const v = replayVault(jump, [], 48, jump.length - 1, { stakingApr: 0.05 });
    expect(v.liquidatedAt).toBe(new Date(jump[jump.length - 1]!.t * 1000).toISOString());
    expect(shortLiquidationPrice(450, 900, 1, 0.05)).toBeCloseTo(1350 / 945, 9);
  });
});

describe("vault score", () => {
  test("matches the shared fixtures the enclave also passes", () => {
    for (const c of vaultCases.vaultRisk) {
      const r = vaultRisk(c.input as VaultRiskInput);
      expect({ name: c.name, ...r }).toEqual({ name: c.name, ...c.expected });
    }
    for (const c of vaultCases.hedgeRatio) expect([c.name, hedgeRatioForFunding(c.maxBps, c.minBps, c.fundingSum7d)]).toEqual([c.name, c.expected]);
  });

  test("a short near its liquidation price alone pauses deposits and asks for margin", () => {
    const at = (liquidationPx: number) => vaultRisk({ size: -100, mark: 4, liquidationPx, accountValue: 150, fundingRateHourly: 0.00001, oracleDeviation: 0, bookRate: 1, rate: 1, reservesRatioBps: 10_000 }).score;
    expect(at(4 * (1 + VAULT_SCORE_FLOORS.marginDistance) - 0.01)).toBe(VAULT_LEVERS.marginScore);
    expect(at(4 * (1 + VAULT_SCORE_FLOORS.pauseDistance) - 0.01)).toBe(VAULT_LEVERS.pauseScore);
    expect(at(4 * (1 + VAULT_SCORE_FLOORS.pauseDistance) + 0.01)).toBeLessThan(VAULT_LEVERS.pauseScore);
    // Monotonic: the closer the liquidation price, the higher the score.
    let last = Infinity;
    for (let d = 0; d <= 0.6; d += 0.005) {
      const s = at(4 * (1 + d));
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
    // The margin floor sits at about the keeper's early margin ratio of 0.2 (5 % maintenance).
    expect(VAULT_SCORE_FLOORS.marginDistance * 1.05 + 0.05).toBeCloseTo(0.2, 1);
  });

  const repo = join(import.meta.dir, "..", "..", "..");
  test.skipIf(!existsSync(join(repo, "contracts")))("the levers and defaults are the contract's and the keeper's", () => {
    const report = readFileSync(join(repo, "contracts", "vault", "src", "report.rs"), "utf8");
    const constant = (src: string, name: string) => Number(new RegExp(`const ${name}: u\\d+ = ([\\d_]+);`).exec(src)![1]!.replace(/_/g, ""));
    expect(constant(report, "PAUSE_SCORE")).toBe(VAULT_LEVERS.pauseScore);
    expect(constant(report, "RESUME_SCORE")).toBe(VAULT_LEVERS.resumeScore);
    expect(constant(report, "REDUCE_LEVERAGE_SCORE")).toBe(VAULT_LEVERS.reduceLeverageScore);
    expect(constant(report, "RESTORE_LEVERAGE_SCORE")).toBe(VAULT_LEVERS.restoreLeverageScore);
    expect(constant(report, "REDUCED_LEVERAGE_X100")).toBe(VAULT_LEVERS.reducedLeverage * 100);
    expect(constant(report, "MARGIN_SCORE")).toBe(VAULT_LEVERS.marginScore);
    const lib = readFileSync(join(repo, "contracts", "vault", "src", "lib.rs"), "utf8");
    expect(constant(lib, "DEFAULT_HEDGE_RATIO_MIN_BPS")).toBe(DEFAULT_VAULT_PARAMS.hedgeRatioMin * 10_000);
    const insurance = readFileSync(join(repo, "contracts", "vault", "src", "insurance.rs"), "utf8");
    expect(constant(insurance, "DEFAULT_SHARE_BPS")).toBe(DEFAULT_VAULT_PARAMS.insuranceShareBps);
    expect(constant(insurance, "DEFAULT_CAP_PER_DAY_BPS")).toBe(DEFAULT_VAULT_PARAMS.insuranceCapPerDayBps);
    expect(constant(insurance, "DEFAULT_MAX_PAYOUT_E6") / 1e6).toBe(DEFAULT_VAULT_PARAMS.maxPayoutUsd);
    const keeper = readFileSync(join(repo, "services", "src", "keeper.ts"), "utf8");
    expect(Number(/MARGIN_TARGET_RATIO \?\? ([\d.]+)/.exec(keeper)![1])).toBe(DEFAULT_VAULT_PARAMS.marginTargetRatio);
    const mainnet = JSON.parse(readFileSync(join(repo, "deployments", "mainnet.json"), "utf8")) as { params: { hedgeRatioBps: number; maxLeverageX100: number } };
    expect(mainnet.params.hedgeRatioBps).toBe(DEFAULT_VAULT_PARAMS.hedgeRatio * 10_000);
    expect(mainnet.params.maxLeverageX100).toBe(DEFAULT_VAULT_PARAMS.maxLeverage * 100);
  });
});

describe("spike finder", () => {
  test("finds the largest 72 h rallies by the crash rule mirrored", () => {
    const up = crashCandles({ flat: 300, drop: -0.8, hours: 30, after: 300 });
    const spans = findSpikes(up, { count: 1 });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.rise).toBeCloseTo(0.8, 1);
    expect(up[spans[0]!.peak]!.close / up[spans[0]!.start]!.close - 1).toBeCloseTo(spans[0]!.rise, 9);
    expect(findSpikes(crashCandles({ flat: 300, drop: 0.5, hours: 30, after: 300 }), { count: 1 })[0]!.rise).toBeLessThan(0.02);
  });

  test("an excluded hour keeps every window that touches it out", () => {
    const up = crashCandles({ flat: 300, drop: -0.8, hours: 30, after: 300 });
    const exclude = new Uint8Array(up.length);
    exclude[310] = 1;
    const s = findSpikes(up, { count: 1, exclude })[0]!;
    expect(s.peak < 310 || s.start > 310).toBe(true);
    expect(s.rise).toBeLessThan(0.8);
  });
});

describe("regimes", () => {
  test("thresholds map the Tremor index to calm, stressed and panic", () => {
    expect(tremorRegime(0.5)).toBe("calm");
    expect(tremorRegime(REGIME_THRESHOLDS.stressed)).toBe("stressed");
    expect(tremorRegime(REGIME_THRESHOLDS.panic + 0.1)).toBe("panic");
    expect(tremor([], 1).regime).toBe("calm");
  });

  test("out of sample: the scored episodes are set aside, the thresholds chosen on other falls, then tested on them", () => {
    const a = crashCandles({ flat: 400, drop: 0.5, hours: 24, after: 400 });
    const b = crashCandles({ flat: 400, drop: 0.3, hours: 24, after: 400, start: a[a.length - 1]!.close }).map((c) => ({ ...c, t: c.t + a.length * 3600 }));
    const all = [...a, ...b];
    const scored = findCrashes(all, { count: 1 });
    const cal = outOfSampleRegimes(all, { crashes: scored, spikes: [] }, { calibrationCrashes: 1 });
    expect(cal.quarantineHours).toBe(scored[0]!.trough - scored[0]!.peak + 1 + 2 * 72);
    // The calibration crash is the second, smaller fall, far from the scored one.
    expect(cal.calibrationCrashes).toHaveLength(1);
    expect(cal.calibrationCrashes[0]!.dropPct).toBeCloseTo(30, 0);
    expect(cal.panic).toBeGreaterThan(cal.stressed);
    expect(cal.test.crashes.hours).toBe(scored[0]!.trough - scored[0]!.peak + 1);
    expect(cal.test.crashes.panicRate).toBeGreaterThanOrEqual(0.5);
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
  /**
   * A real mainnet borrower as the heatmap read it on 11 Nov 2026 (thickdish7375.near): 1 214 937
   * wNEAR (ratio 0.75) and 1.97 M USD of ZEC (0.70) against 4.19 M USD of USDT and USDC (0.95),
   * NEAR at 3.585, health 1.054, liquidation at 3.327, 7.2 % away.
   */
  const NEAR = 3.585;
  const whale: HeatmapAccount = {
    account: "whale.near",
    liqPrice: (4_190_000 / 0.95 - 0.7 * 1_970_000) / (0.75 * 1_214_937),
    driverCollateralUsd: 1_214_937 * NEAR,
    collateralUsd: 1_214_937 * NEAR + 1_970_000,
    debtUsd: 4_190_000,
    exposure: 0.75 * 1_214_937,
    collateralRatio: 0.73,
    debtRatio: 0.95,
  };
  const underwaterAccount: HeatmapAccount = { account: "bad.near", liqPrice: 18_664, driverCollateralUsd: 0, collateralUsd: 92_000, debtUsd: 62_000, exposure: 1e-6 };

  test("a liquidation takes only what brings health back to 1, as Rhea allows", () => {
    expect(whale.liqPrice!).toBeCloseTo(3.327, 3);
    expect(liquidationSaleUsd(whale, NEAR, 3.4)).toBe(0);
    const p = 3.25;
    const sold = liquidationSaleUsd(whale, NEAR, p);
    // Rebuild the account after the sale: health is back at 1 (within rounding of the ratios).
    const gap = whale.exposure! * (whale.liqPrice! - p);
    const d = gap / (whale.debtUsd / 0.95) / 2;
    const seized = sold / (whale.driverCollateralUsd / whale.collateralUsd);
    const repaid = seized * (1 - d);
    const weightedDebt = whale.debtUsd / 0.95 - repaid / 0.95;
    const weightedCollateral = whale.debtUsd / 0.95 - gap - seized * 0.73;
    expect(weightedCollateral / weightedDebt).toBeCloseTo(1, 9);
    // A slice, not the whole position: about 154 K USD of NEAR for a 2.3 % fall past the liquidation price.
    expect(sold).toBeGreaterThan(100_000);
    expect(sold).toBeLessThan(400_000);
  });

  test("the realistic case: one whale 7 % away barely adds to a 2σ day", () => {
    const sigma = 0.0101; // 95 % annual
    const p = heatmapPressure([whale, underwaterAccount], NEAR, sigma);
    expect(p.accounts).toBe(1);
    expect(p.atRiskUsd).toBeCloseTo(whale.collateralUsd, 0);
    // Liquidators sell about 175 K USD of NEAR: 0.23 % more fall on a 9.9 % move, pressure 0.024,
    // not the 0.57 that selling the whole position at once gave.
    expect(p.soldUsd).toBeGreaterThan(150_000);
    expect(p.soldUsd).toBeLessThan(200_000);
    expect(p.pressure).toBeGreaterThan(0.02);
    expect(p.pressure).toBeLessThan(0.03);
  });

  test("accounts already under water are counted apart, not bucketed or cascaded", () => {
    const b = heatBuckets([whale, underwaterAccount], NEAR);
    expect(b.reduce((s, x) => s + x.accounts, 0)).toBe(1);
    expect(underwater([whale, underwaterAccount], NEAR)).toEqual({ accounts: 1, collateralUsd: 92_000, debtUsd: 62_000 });
    expect(heatmapPressure([underwaterAccount], NEAR, 0.0101).pressure).toBe(0);
  });

  test("a thin market chains: one liquidation's sales reach the next account", () => {
    const next: HeatmapAccount = { ...whale, account: "next.near", liqPrice: 3.2 };
    const thin = { depth2pctUsd: 100_000 };
    const r = runCascade([whale, next], NEAR, 3.3, thin);
    expect(r.rounds).toBe(2);
    expect(r.accounts).toBe(2);
    expect(r.to).toBeLessThan(3.2);
    const chains = chainedCascades([whale, next], NEAR, heatBuckets([whale, next], NEAR), thin);
    expect(chains[0]!.from).toBeGreaterThan(chains[0]!.to);
    expect(heatmapPressure([], NEAR, 0.01).pressure).toBe(0);
    expect(heatmapPressure([whale, next], NEAR, 0.0101, thin).pressure).toBeLessThanOrEqual(1);
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
