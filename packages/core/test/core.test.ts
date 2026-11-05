import { describe, expect, test } from "bun:test";
import fixtures from "../fixtures/risk-cases.json";
import {
  assess,
  assessPerp,
  buildStrategy,
  cascade,
  DEFAULT_LIMITS,
  formatPrice,
  formatSize,
  healthFactor,
  hedgeEquity,
  liquidationPrice,
  liquidationProbability,
  maxWithdrawal,
  nav,
  normCdf,
  plan,
  rebalance,
  reserveProof,
  reserveRoot,
  riskScore,
  sharePrice,
  sharesFor,
  simpleHealth,
  STRATEGIES,
  targetShort,
  timeToLiquidation,
  tremor,
  verifyReserveProof,
  type LendingPosition,
  type ReserveLeaf,
  type Sample,
  type VaultBook,
} from "../src/index";

const position = (collateral: number, debt: number, price: number): LendingPosition => ({
  collateral: [{ symbol: "wNEAR", amount: collateral, priceUsd: price, volatilityRatio: 0.75, driver: true }],
  debt: [{ symbol: "USDC", amount: debt, priceUsd: 1, volatilityRatio: 0.95, driver: false }],
});

describe("normal distribution", () => {
  test("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normCdf(-1.2014)).toBeCloseTo(0.1148, 4);
  });
});

describe("risk model against hand-checked cases", () => {
  for (const c of fixtures.cases) {
    test(c.name, () => {
      const p = position(c.collateralNear, c.debtUsd, c.price);
      const e = c.expected;
      expect(healthFactor(p)).toBeCloseTo(e.health, 9);
      const liq = liquidationPrice(p, c.price);
      expect(liq).not.toBeNull();
      expect(liq!).toBeCloseTo(e.liqPrice, 9);
      const p24 = liquidationProbability(c.price, liq, c.sigmaHourly, c.trendHourly, 24);
      expect(Math.abs(p24 - e.probability24h)).toBeLessThan(1e-5);
      expect(Math.abs(liquidationProbability(c.price, liq, c.sigmaHourly, c.trendHourly, 4) - e.probability4h)).toBeLessThan(1e-5);
      const ttl = timeToLiquidation(c.price, liq, c.sigmaHourly, c.trendHourly);
      if (e.medianHours === null) expect(ttl.medianHours).toBeNull();
      else expect(Math.abs(ttl.medianHours! - e.medianHours)).toBeLessThan(0.01);
      const s = riskScore({ health: e.health, probability24h: p24, annualVol: c.annualVol, cascadePressure: c.cascadePressure });
      expect(s.score).toBe(e.score);
      expect(s.tier).toBe(e.tier as typeof s.tier);
    });
  }

  test("no debt means no liquidation price and infinite health", () => {
    const p = position(10, 0, 3);
    expect(healthFactor(p)).toBe(Infinity);
    expect(liquidationPrice({ ...p, debt: [] }, 3)).toBeNull();
  });

  test("probability grows with the horizon, with volatility and with a falling trend", () => {
    const base = liquidationProbability(2.4, 2.1, 0.0075, 0, 24);
    expect(liquidationProbability(2.4, 2.1, 0.0075, 0, 48)).toBeGreaterThan(base);
    expect(liquidationProbability(2.4, 2.1, 0.015, 0, 24)).toBeGreaterThan(base);
    expect(liquidationProbability(2.4, 2.1, 0.0075, -0.003, 24)).toBeGreaterThan(base);
    expect(liquidationProbability(2.4, 2.1, 0.0075, 0.003, 24)).toBeLessThan(base);
  });
});

/** A price path with a given hourly volatility, deterministic (seeded). */
function path(hours: number, perHour: number, sigma: number, start = 3, seed = 7, drift = 0): Sample[] {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const out: Sample[] = [];
  let price = start;
  const dt = 1 / perHour;
  for (let i = 0; i <= hours * perHour; i++) {
    out.push({ t: 1_800_000_000 + i * dt * 3600, price });
    price *= Math.exp(drift * dt + sigma * Math.sqrt(dt) * gauss());
  }
  return out;
}

describe("Tremor index", () => {
  test("recovers the volatility of a simulated path", () => {
    const samples = path(12, 60, 0.01);
    const now = samples[samples.length - 1]!.t;
    const t = tremor(samples, now);
    expect(t.fallback).toBe(false);
    expect(t.sigmaHourly).toBeGreaterThan(0.008);
    expect(t.sigmaHourly).toBeLessThan(0.012);
    expect(t.windows.map((w) => w.hours)).toEqual([1, 4, 12]);
  });

  test("weighs the last hour most", () => {
    const calm = path(11, 60, 0.002);
    const lastT = calm[calm.length - 1]!.t;
    const wild = path(1, 60, 0.03, calm[calm.length - 1]!.price, 3).map((s) => ({ t: lastT + (s.t - 1_800_000_000), price: s.price }));
    const now = wild[wild.length - 1]!.t;
    const t = tremor([...calm, ...wild.slice(1)], now);
    expect(t.windows[0]!.sigma!).toBeGreaterThan(t.windows[2]!.sigma!);
    expect(t.level === "high" || t.level === "extreme").toBe(true);
  });

  test("falls back to a default without history", () => {
    expect(tremor([], 1).fallback).toBe(true);
  });
});

describe("cascade detector", () => {
  test("counts collateral inside a 2σ daily move and flags correlated owners", () => {
    const sigma = 0.0075;
    const c = cascade(
      [
        { owner: "a", venue: "rhea", liqPrice: 2.9, collateralUsd: 1000 },
        { owner: "a", venue: "hyperliquid", liqPrice: 2.85, collateralUsd: 500 },
        { owner: "b", venue: "rhea", liqPrice: 1.0, collateralUsd: 9000 },
      ],
      3,
      sigma,
      5000,
    );
    expect(c.atRiskUsd).toBe(1500);
    expect(c.pressure).toBeCloseTo(0.3, 9);
    expect(c.correlatedOwners).toEqual(["a"]);
  });
});

describe("assessment", () => {
  test("a whole lending position", () => {
    const samples = path(12, 12, 0.008, 2.5);
    const now = samples[samples.length - 1]!.t;
    const price = samples[samples.length - 1]!.price;
    const a = assess(position(100, 150, price), price, samples, now);
    expect(a.health).toBeGreaterThan(0);
    expect(a.score.score).toBeGreaterThanOrEqual(0);
    expect(a.score.score).toBeLessThanOrEqual(100);
    expect(a.valueAtRisk99).toBeGreaterThan(0);
  });

  test("a short perp is at risk when the price rises toward its liquidation price", () => {
    const samples = path(4, 12, 0.008, 3.6);
    const now = samples[samples.length - 1]!.t;
    const near = assessPerp({ size: -100, markPrice: 3.6, liquidationPx: 3.75, history: samples, now });
    const far = assessPerp({ size: -100, markPrice: 3.6, liquidationPx: 6, history: samples, now });
    expect(near.score.score).toBeGreaterThan(far.score.score);
    expect(near.distance).toBeCloseTo(1 - 3.6 / 3.75, 9);
  });
});

describe("recovery planner", () => {
  const p = { collateral: 100, debt: 150, price: 2.3, collateralRatio: 0.75, debtRatio: 0.95 };

  test("repay first reaches the target from the reserve", () => {
    const r = plan(STRATEGIES[0]!, p, 1.5, { ...DEFAULT_LIMITS, repayBudget: 100 });
    expect(r.reached).toBe(true);
    expect(r.steps[0]!.kind).toBe("repay");
    expect(r.healthAfter).toBeGreaterThanOrEqual(1.5 - 1e-6);
  });

  test("keep exposure adds collateral first", () => {
    const r = plan(STRATEGIES[1]!, p, 1.5, { ...DEFAULT_LIMITS, repayBudget: 100, collateralBudget: 100 });
    expect(r.steps[0]!.kind).toBe("add_collateral");
    expect(r.reached).toBe(true);
  });

  test("a deep deleverage becomes several steps, each keeping health above the withdraw floor", () => {
    // Health 1.09: each withdrawal may only take what keeps health at 1.01 until its repay lands,
    // so reaching 1.3 takes several steps (and acting earlier takes fewer).
    const deep = { ...p };
    const r = plan(STRATEGIES[2]!, deep, 1.3, { ...DEFAULT_LIMITS, deleverageBudget: 100, maxSteps: 12 });
    expect(r.steps.length).toBeGreaterThan(1);
    let pos = { ...deep };
    for (const s of r.steps) {
      expect(s.amount).toBeLessThanOrEqual(maxWithdrawal(pos, DEFAULT_LIMITS.withdrawFloor) + 1e-9);
      pos = { ...pos, collateral: pos.collateral - s.amount, debt: pos.debt - s.minOut! };
      expect(simpleHealth(pos)).toBeGreaterThan(s.healthBefore);
    }
    expect(r.reached).toBe(true);
  });

  test("an empty reserve falls through to the next step", () => {
    const r = plan(STRATEGIES[0]!, p, 1.5, { ...DEFAULT_LIMITS, deleverageBudget: 50 });
    expect(r.steps.every((s) => s.kind === "deleverage")).toBe(true);
  });

  test("custom strategies keep each step once, in order", () => {
    const s = buildStrategy("Mine", ["deleverage", "repay", "deleverage"]);
    expect(s.steps).toEqual(["deleverage", "repay"]);
    expect(() => buildStrategy("None", [])).toThrow();
  });
});

const book = (over: Partial<VaultBook> = {}): VaultBook => ({
  stakedLinear: 1000,
  linearRate: 1.2,
  nearPrice: 3,
  accountValue: 2000,
  marginBaseline: 2000,
  settledPnl: 0,
  totalShares: 3600,
  queuedShares: 0,
  hedgeSize: -1080,
  hedgeRatio: 0.9,
  maxLeverage: 3,
  ...over,
});

describe("vault hedge math", () => {
  test("NAV, share price and new shares", () => {
    const b = book();
    expect(nav(b)).toBeCloseTo(3600, 9);
    expect(sharePrice(b)).toBeCloseTo(1, 9);
    expect(sharesFor(b, 360)).toBeCloseTo(360, 9);
    expect(sharesFor({ ...b, totalShares: 0 }, 50)).toBe(50);
  });

  test("the share holds its value over simulated price paths (90% hedged)", () => {
    for (const seed of [3, 11, 29, 47]) {
      const prices = path(24 * 7, 1, 0.01, 3, seed).map((s) => s.price);
      const b0 = book();
      const v0 = sharePrice(b0);
      const end = prices[prices.length - 1]!;
      // The short's PnL lands in the Hyperliquid account value.
      const pnl = -b0.hedgeSize * (b0.nearPrice - end);
      const b1 = { ...b0, nearPrice: end, accountValue: b0.accountValue + pnl };
      const unhedgedMove = Math.abs(end / 3 - 1);
      const vaultMove = Math.abs(sharePrice(b1) / v0 - 1);
      expect(vaultMove).toBeLessThanOrEqual(unhedgedMove * 0.1 + 1e-9);
    }
  });

  test("target short, leverage cap and rebalance band", () => {
    const b = book();
    expect(targetShort(b)).toBeCloseTo(1080, 9);
    expect(rebalance(b).act).toBe(false);
    expect(rebalance({ ...b, stakedLinear: 1100 }).act).toBe(true);
    // A thin margin caps the short at 3x.
    expect(targetShort({ ...b, accountValue: 900 })).toBeCloseTo(900, 9);
    // Queued shares leave the hedge before they leave the vault.
    expect(targetShort({ ...b, queuedShares: 360 })).toBeCloseTo(972, 9);
    expect(hedgeEquity({ ...b, accountValue: 2100, settledPnl: 40 })).toBeCloseTo(60, 9);
  });

  test("Hyperliquid number formats", () => {
    expect(formatSize(12.38, 1)).toBe("12.3");
    expect(formatSize(12, 1)).toBe("12");
    expect(formatPrice(3.634567, 1, false)).toBe("3.6345");
    expect(formatPrice(3.634567, 1, true)).toBe("3.6346");
    expect(formatPrice(65432.1, 5, false)).toBe("65432");
    expect(formatPrice(0.0123456, 1, false)).toBe("0.01234");
  });
});

describe("proof of reserves", () => {
  const leaves: ReserveLeaf[] = [
    { asset: "LiNEAR", venue: "near", amount: "1000000000000000000000000000", usdE6: "3600000000" },
    { asset: "USDC", venue: "hyperliquid", amount: "2000000000", usdE6: "2000000000" },
    { asset: "NEAR-PERP", venue: "hyperliquid", amount: "-108000000000", usdE6: "0" },
  ];

  test("every leaf proves against the root, and a changed leaf does not", () => {
    const root = reserveRoot(leaves);
    for (const l of leaves) expect(verifyReserveProof(l, reserveProof(leaves, l), root)).toBe(true);
    const forged = { ...leaves[0]!, amount: "2000000000000000000000000000" };
    expect(verifyReserveProof(forged, reserveProof(leaves, leaves[0]!), root)).toBe(false);
  });

  test("the enclave computes the same root (enclave/src/reserves.rs pins it too)", () => {
    expect(reserveRoot(leaves)).toBe("72baafd93e5edf320aee2a823451fee2cd9fbc8e38279bec948b293b9e3b95a3");
  });

  test("the root does not depend on leaf order", () => {
    expect(reserveRoot([...leaves].reverse())).toBe(reserveRoot(leaves));
  });
});
