/**
 * `pnpm replay`: runs Parry's risk model, guardian planner and vault math through NEAR's largest
 * historical crashes, and the vault through its largest rallies (where its short is at risk), from
 * real hourly candles, and writes deployments/replay.json (served by `GET /v1/replay`). It also
 * chooses the Tremor index's regime thresholds out of sample: on hours away from every scored
 * crash and spike.
 *
 *   pnpm replay              fetch, replay, write deployments/replay.json, print a summary
 *   pnpm replay --markdown   the same, and print the results as a Markdown table
 *   pnpm replay --print      print the Markdown table of the committed file without fetching
 *
 * Sources (all public, no key): Binance spot klines for NEARUSDT (1 h), Binance USD-M funding
 * history for NEARUSDT, and LiNEAR's `ft_price` on NEAR mainnet now and 30 days ago (archival
 * RPC) for the staking yield.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  calibrateRegimes,
  DEFAULT_GUARDIAN_PARAMS,
  DEFAULT_VAULT_PARAMS,
  findCrashes,
  findSpikes,
  median,
  outOfSampleRegimes,
  REGIME_THRESHOLDS,
  replayPosition,
  replayVault,
  tremorSeries,
  type Candle,
  type FundingPoint,
  type VaultReplay,
} from "@parryguard/core";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "deployments", "replay.json");
const KLINES = "https://data-api.binance.vision/api/v3/klines";
const FUNDING = "https://fapi.binance.com/fapi/v1/fundingRate";
const ARCHIVAL = "https://archival-rpc.mainnet.fastnear.com";
const SYMBOL = "NEARUSDT";
const FIRST = Date.UTC(2020, 9, 14); // NEARUSDT's first Binance candle

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

async function candles(): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = FIRST;
  for (;;) {
    const rows = await json<[number, string, string, string, string][]>(`${KLINES}?symbol=${SYMBOL}&interval=1h&startTime=${start}&limit=1000`);
    for (const r of rows) out.push({ t: r[0] / 1000, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) });
    if (rows.length < 1000) break;
    start = rows[rows.length - 1]![0] + 3_600_000;
  }
  // The last candle is still open: replay only closed hours.
  return out.filter((c) => (c.t + 3600) * 1000 <= Date.now());
}

async function funding(): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  let start = FIRST;
  for (;;) {
    const rows = await json<{ fundingTime: number; fundingRate: string }[]>(`${FUNDING}?symbol=${SYMBOL}&startTime=${start}&limit=1000`);
    for (const r of rows) out.push({ t: Math.floor(r.fundingTime / 1000), rate: Number(r.fundingRate) });
    if (rows.length < 1000) break;
    start = rows[rows.length - 1]!.fundingTime + 1;
  }
  return out;
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await json<{ result?: T; error?: unknown }>(ARCHIVAL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.result) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.result;
}

/** LiNEAR's staking yield: its `ft_price` (NEAR per LiNEAR) now and about 30 days ago, annualized. */
async function stakingApr(): Promise<{ apr: number; from: { block: number; at: string; price: string }; to: { block: number; at: string; price: string } }> {
  const head = await rpc<{ header: { height: number; timestamp_nanosec: string } }>("block", { finality: "final" });
  const past = await rpc<{ header: { height: number; timestamp_nanosec: string } }>("block", { block_id: head.header.height - Math.round((30 * 86_400) / 0.6) }).catch(() =>
    rpc<{ header: { height: number; timestamp_nanosec: string } }>("block", { block_id: head.header.height - 2_000_000 }),
  );
  const price = async (block: number) => {
    const r = await rpc<{ result: number[] }>("query", { request_type: "call_function", block_id: block, account_id: "linear-protocol.near", method_name: "ft_price", args_base64: "e30=" });
    return JSON.parse(Buffer.from(r.result).toString()) as string;
  };
  const [p0, p1] = await Promise.all([price(past.header.height), price(head.header.height)]);
  const days = (Number(head.header.timestamp_nanosec) - Number(past.header.timestamp_nanosec)) / 86_400e9;
  const apr = (Number(p1) / Number(p0)) ** (365 / days) - 1;
  const at = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
  return { apr, from: { block: past.header.height, at: at(past.header.timestamp_nanosec), price: p0 }, to: { block: head.header.height, at: at(head.header.timestamp_nanosec), price: p1 } };
}

const iso = (t: number) => new Date(t * 1000).toISOString();
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fmtDay = (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const r = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

interface VaultRow {
  maxDrawdownPct: number;
  maxDrawdownUnhedgedPct: number;
  marginMin: number;
  liquidationHeadroomMinPct: number | null;
  liquidatedAt: string | null;
  maxScore: number;
  pausedHours: number;
  reducedLeverageHours: number;
  hedgedMinPct: number;
  hedgedEndPct: number;
  sharePriceEnd: number;
  unhedgedEnd: number;
  fundingUsd: number;
  insurancePaidUsd: number;
  insurancePaid: { negativeFundingUsd: number; marginTopUpUsd: number };
  marginNeededHours: number;
  marginTopUps: number;
  marginTopUpsRefused: number;
  marginShortfallMaxUsd: number;
  rebalances: number;
  buybacks: number;
}

interface ReplayFile {
  generatedAt: string;
  source: string;
  sources: Record<string, string>;
  [k: string]: unknown;
  crashes: {
    id: string;
    name: string;
    dropPct: number;
    position: { warningHours: number | null; liquidatedAt: string | null; liquidatedWithParryAt: string | null; predictedHoursAtWarning: number | null; minHealthWith: number; steps: unknown[] };
    vault: VaultRow;
  }[];
  spikes: { id: string; name: string; risePct: number; vault: VaultRow }[];
  summary: Record<string, unknown>;
  calibration: {
    regime: { stressed: number; panic: number; test: { crashes: { panicRate: number; stressedOrWorseRate: number }; spikes: { panicRate: number; stressedOrWorseRate: number } } };
    inSample: { stressed: number; panic: number };
  };
}

const pct = (x: number, dp = 1) => `${x.toFixed(dp)} %`;
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const when = (t: string | null) => (t ? t.slice(0, 16).replace("T", " ") : "no");

function markdown(f: ReplayFile): string {
  const lines = [
    "| Crash | Drop | Liquidated without Parry | Warning | Guardian steps | Min health with Parry | Vault drawdown (unhedged) | Hedged | Min margin ratio | Funding | Insurance paid |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const c of f.crashes) {
    const p = c.position;
    lines.push(
      `| ${c.name} | ${pct(c.dropPct)} | ${when(p.liquidatedAt)} | ${p.warningHours === null ? "n/a" : `${p.warningHours} h`} | ${p.steps.length} | ${p.minHealthWith.toFixed(3)}${p.liquidatedWithParryAt ? " (liquidated)" : ""} | ${pct(c.vault.maxDrawdownPct)} (${pct(c.vault.maxDrawdownUnhedgedPct)}) | ${pct(c.vault.hedgedMinPct, 0)} | ${c.vault.marginMin.toFixed(3)} | ${usd(c.vault.fundingUsd)} | ${usd(c.vault.insurancePaidUsd)} |`,
    );
  }
  const s = f.summary;
  lines.push("", `Median warning ${s.medianWarningHours} h; liquidations avoided ${s.liquidationsAvoided} of ${s.liquidationsWithout}; ${s.crashes} crashes. Source: ${f.source}.`, "");
  lines.push(
    "| Spike | Rise | Vault liquidated | Min margin ratio | Closest to liquidation | Max score | Deposits paused | Margin asked | Margin topped up (largest shortfall) | Rebalances (buybacks) | Hedged at the end | Share price (unhedged) | Drawdown |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const x of f.spikes) {
    const v = x.vault;
    lines.push(
      `| ${x.name} | ${pct(x.risePct)} | ${when(v.liquidatedAt)} | ${v.marginMin.toFixed(3)} | ${v.liquidationHeadroomMinPct === null ? "n/a" : `${pct(v.liquidationHeadroomMinPct)} away`} | ${v.maxScore} | ${v.pausedHours ? `${v.pausedHours} h` : "no"} | ${v.marginNeededHours ? `${v.marginNeededHours} h` : "no"} | ${v.marginNeededHours ? `${usd(v.insurancePaid.marginTopUpUsd)} (${usd(v.marginShortfallMaxUsd)})` : "n/a"} | ${v.rebalances} (${v.buybacks}) | ${pct(v.hedgedEndPct, 0)} | ${v.sharePriceEnd.toFixed(3)} (${v.unhedgedEnd.toFixed(3)}) | ${pct(v.maxDrawdownPct)} |`,
    );
  }
  const c = f.calibration;
  lines.push(
    "",
    `Vault liquidations in the spikes: ${s.spikeLiquidations} of ${s.spikes}; deposits paused ${s.spikePausedHours} h; margin asked for ${s.spikeMarginNeededHours} h, ${s.spikeMarginTopUps} top-ups paid ${usd(Number(s.spikeMarginTopUpUsd))}${Number(s.spikeMarginTopUpsRefused) ? `, ${s.spikeMarginTopUpsRefused} refused` : ""}; insurance paid ${usd(Number(s.spikeInsurancePaidUsd))}.`,
    `Regime thresholds, out of sample: stressed ${c.regime.stressed}, panic ${c.regime.panic} (calibrating on the scored crashes would choose ${c.inSample.stressed} and ${c.inSample.panic}). ` +
      `On the scored crashes panic flags ${pct(100 * c.regime.test.crashes.panicRate)} of the hours and stressed or worse ${pct(100 * c.regime.test.crashes.stressedOrWorseRate)}; on the spikes ${pct(100 * c.regime.test.spikes.panicRate)} and ${pct(100 * c.regime.test.spikes.stressedOrWorseRate)}.`,
  );
  return lines.join("\n");
}

if (process.argv.includes("--print")) {
  if (!existsSync(OUT)) throw new Error("no deployments/replay.json yet: run pnpm replay");
  console.log(markdown(JSON.parse(readFileSync(OUT, "utf8")) as ReplayFile));
  process.exit(0);
}

console.error("fetching NEARUSDT hourly candles, funding history and LiNEAR's staking rate ...");
const [all, fundingRates, staking] = await Promise.all([candles(), funding(), stakingApr()]);
console.error(`${all.length} candles from ${iso(all[0]!.t)} to ${iso(all[all.length - 1]!.t)}, ${fundingRates.length} funding payments, staking ${(staking.apr * 100).toFixed(2)} %`);

// The first week after listing is price discovery, not a crash or a rally.
const SKIP = 7 * 24;
const WINDOW = 72;
const COUNT = 6;
const spans = findCrashes(all, { windowHours: WINDOW, count: COUNT, skipHours: SKIP });
const rallies = findSpikes(all, { windowHours: WINDOW, count: COUNT, skipHours: SKIP });
const LEAD = 24;
const TAIL = 24;

function vaultOut(vault: VaultReplay) {
  return {
    navWith: vault.navWith.map((x) => ({ t: x.t, v: r(x.v, 2) })),
    navUnhedged: vault.navUnhedged.map((x) => ({ t: x.t, v: r(x.v, 2) })),
    hedge: vault.hedge.map((x) => ({ t: x.t, marginAtHigh: x.marginAtHigh === null ? null : r(x.marginAtHigh), short: r(x.short, 2), marginRatio: x.marginRatio === null ? null : r(x.marginRatio), liqPx: x.liqPx === null ? null : r(x.liqPx), score: x.score })),
    maxDrawdownPct: r(vault.maxDrawdownPct, 2),
    maxDrawdownUnhedgedPct: r(vault.maxDrawdownUnhedgedPct, 2),
    marginMin: r(vault.marginMin),
    marginMinAt: vault.marginMinAt,
    liquidationHeadroomMinPct: vault.liquidationHeadroomMinPct === null ? null : r(vault.liquidationHeadroomMinPct, 2),
    liquidatedAt: vault.liquidatedAt,
    maxScore: vault.maxScore,
    pausedHours: vault.pausedHours,
    reducedLeverageHours: vault.reducedLeverageHours,
    marginNeededHours: vault.marginNeededHours,
    hedgedMinPct: r(vault.hedgedMinPct, 2),
    hedgedEndPct: r(vault.hedgedEndPct, 2),
    sharePriceMin: r(vault.sharePriceMin),
    sharePriceEnd: r(vault.sharePriceEnd),
    unhedgedEnd: r(vault.unhedgedEnd),
    insuranceFundUsd: r(vault.insuranceFundUsd, 2),
    insuranceFundEndUsd: r(vault.insuranceFundEndUsd, 2),
    insurancePaidUsd: r(vault.insurancePaidUsd, 2),
    insurancePaid: { negativeFundingUsd: r(vault.insurancePaid.negativeFundingUsd, 2), marginTopUpUsd: r(vault.insurancePaid.marginTopUpUsd, 2) },
    marginTopUps: vault.marginTopUps,
    marginTopUpsRefused: vault.marginTopUpsRefused,
    marginTopUpsUnpaid: vault.marginTopUpsUnpaid,
    marginShortfallMaxUsd: r(vault.marginShortfallMaxUsd, 2),
    fundingUsd: r(vault.fundingUsd, 2),
    rebalances: vault.rebalances,
    buybacks: vault.buybacks,
    events: vault.events,
  };
}

const crashes = spans
  .sort((a, b) => a.peak - b.peak)
  .map((s) => {
    const from = s.peak;
    const to = Math.min(all.length - 1, s.trough + TAIL);
    const position = replayPosition(all, from, to);
    const vault = replayVault(all, fundingRates, from, to, { stakingApr: staking.apr });
    const peak = all[s.peak]!;
    const trough = all[s.trough]!;
    return {
      id: `crash-${day(peak.t)}`,
      name: `${fmtDay(peak.t)} to ${fmtDay(trough.t)}`,
      start: iso(peak.t),
      end: iso(all[to]!.t),
      trough: iso(trough.t),
      dropPct: r(s.drop * 100, 2),
      peakPrice: peak.close,
      troughPrice: trough.close,
      candles: all.slice(Math.max(0, from - LEAD), to + 1).map((c) => ({ t: iso(c.t), price: c.close, low: c.low, high: c.high })),
      position: {
        startHealth: position.startHealth,
        warningHours: position.warningHours,
        warnedAt: position.warnedAt,
        predictedHoursAtWarning: position.predictedHoursAtWarning === null ? null : r(position.predictedHoursAtWarning, 2),
        liquidatedAt: position.liquidatedAt,
        liquidatedWithParryAt: position.liquidatedWithParryAt,
        minHealthWith: r(position.minHealthWith),
        reserveSpentUsd: r(position.reserveSpentUsd, 2),
        collateralSoldNear: r(position.collateralSoldNear, 2),
        steps: position.steps.map((x) => ({ ...x, healthBefore: r(x.healthBefore), healthAfter: r(x.healthAfter) })),
        healthWith: position.healthWith.map((x) => ({ t: x.t, h: r(x.h) })),
        healthWithout: position.healthWithout.map((x) => ({ t: x.t, h: r(x.h) })),
      },
      vault: vaultOut(vault),
    };
  });

const spikes = rallies
  .sort((a, b) => a.start - b.start)
  .map((s) => {
    const from = s.start;
    const to = Math.min(all.length - 1, s.peak + TAIL);
    const vault = replayVault(all, fundingRates, from, to, { stakingApr: staking.apr });
    const low = all[s.start]!;
    const peak = all[s.peak]!;
    return {
      id: `spike-${day(low.t)}`,
      name: `${fmtDay(low.t)} to ${fmtDay(peak.t)}`,
      start: iso(low.t),
      end: iso(all[to]!.t),
      peak: iso(peak.t),
      risePct: r(s.rise * 100, 2),
      startPrice: low.close,
      peakPrice: peak.close,
      candles: all.slice(Math.max(0, from - LEAD), to + 1).map((c) => ({ t: iso(c.t), price: c.close, low: c.low, high: c.high })),
      vault: vaultOut(vault),
    };
  });

const liquidated = crashes.filter((c) => c.position.liquidatedAt !== null);
const avoided = liquidated.filter((c) => c.position.liquidatedWithParryAt === null);
const warnings = liquidated.map((c) => c.position.warningHours).filter((x): x is number => x !== null);
const predicted = liquidated
  .filter((c) => c.position.warningHours !== null && c.position.predictedHoursAtWarning !== null)
  .map((c) => c.position.predictedHoursAtWarning! / c.position.warningHours!);
const headrooms = spikes.map((x) => x.vault.liquidationHeadroomMinPct).filter((x): x is number => x !== null);

// Regime thresholds out of sample: chosen away from every scored crash and spike, then tested on them.
const series = tremorSeries(all);
const regime = outOfSampleRegimes(all, { crashes: spans, spikes: rallies }, { marginHours: 72, calibrationCrashes: 12, skipHours: SKIP, series });
// For comparison only: what calibrating on the scored crashes themselves would choose.
const inSample = calibrateRegimes(all, spans, series);
if (regime.stressed !== REGIME_THRESHOLDS.stressed || regime.panic !== REGIME_THRESHOLDS.panic) {
  console.error(`note: the data chooses stressed ${regime.stressed} and panic ${regime.panic}; packages/core REGIME_THRESHOLDS has ${JSON.stringify(REGIME_THRESHOLDS)}`);
}
const rt = (t: { hours: number; panicRate: number; stressedOrWorseRate: number }) => ({ hours: t.hours, panicRate: r(t.panicRate), stressedOrWorseRate: r(t.stressedOrWorseRate) });

const file = {
  generatedAt: new Date().toISOString(),
  source: `${KLINES}?symbol=${SYMBOL}&interval=1h`,
  sources: {
    candles: `${KLINES}?symbol=${SYMBOL}&interval=1h&startTime=<ms>&limit=1000 (Binance spot, hourly, ${iso(all[0]!.t)} to ${iso(all[all.length - 1]!.t)}, ${all.length} candles)`,
    funding: `${FUNDING}?symbol=${SYMBOL}&startTime=<ms>&limit=1000 (Binance USD-M perpetual funding, every 8 h, ${fundingRates.length} payments)`,
    staking: `linear-protocol.near ft_price at blocks ${staking.from.block} (${staking.from.at}) and ${staking.to.block} (${staking.to.at}) via ${ARCHIVAL}: ${(staking.apr * 100).toFixed(2)} % a year`,
    model:
      "packages/core: assess (risk model) and plan (repay-first) for the position; for the vault, vaultRisk (the enclave's vault score), hedgeRatioForFunding, rebalance and the vault contract's score levers; docs/risk-model.md",
  },
  params: {
    guardian: DEFAULT_GUARDIAN_PARAMS,
    vault: { ...DEFAULT_VAULT_PARAMS, stakingApr: r(staking.apr, 6) },
    crashWindowHours: WINDOW,
    spikeWindowHours: WINDOW,
    leadHours: LEAD,
    tailHours: TAIL,
    selection: `crashes: the ${COUNT} largest falls from an hourly close to the lowest close within the next ${WINDOW} hours; spikes: the ${COUNT} largest rises from an hourly close to the highest close within the next ${WINDOW} hours; each without overlap (no two within ${2 * WINDOW} hours), skipping the first week after listing`,
  },
  crashes,
  spikes,
  summary: {
    crashes: crashes.length,
    medianWarningHours: median(warnings),
    minWarningHours: warnings.length ? Math.min(...warnings) : null,
    warnedBeforeEveryLiquidation: warnings.length === liquidated.length,
    liquidationsWithout: liquidated.length,
    liquidationsAvoided: avoided.length,
    medianPredictedOverActual: predicted.length ? r(median(predicted)!, 3) : null,
    medianVaultDrawdownPct: r(median(crashes.map((c) => c.vault.maxDrawdownPct))!, 2),
    medianUnhedgedDrawdownPct: r(median(crashes.map((c) => c.vault.maxDrawdownUnhedgedPct))!, 2),
    spikes: spikes.length,
    spikeLiquidations: spikes.filter((x) => x.vault.liquidatedAt !== null).length,
    spikeMinMarginRatio: r(Math.min(...spikes.map((x) => x.vault.marginMin))),
    spikeClosestLiquidationPct: headrooms.length ? r(Math.min(...headrooms), 2) : null,
    spikeMaxScore: Math.max(...spikes.map((x) => x.vault.maxScore)),
    spikePausedHours: spikes.reduce((s, x) => s + x.vault.pausedHours, 0),
    spikeReducedLeverageHours: spikes.reduce((s, x) => s + x.vault.reducedLeverageHours, 0),
    spikeInsurancePaidUsd: r(spikes.reduce((s, x) => s + x.vault.insurancePaidUsd, 0), 2),
    spikeMarginNeededHours: spikes.reduce((s, x) => s + x.vault.marginNeededHours, 0),
    spikeMarginTopUps: spikes.reduce((s, x) => s + x.vault.marginTopUps, 0),
    spikeMarginTopUpUsd: r(spikes.reduce((s, x) => s + x.vault.insurancePaid.marginTopUpUsd, 0), 2),
    spikeMarginTopUpsRefused: spikes.reduce((s, x) => s + x.vault.marginTopUpsRefused, 0),
    crashInsurancePaidUsd: r(crashes.reduce((s, x) => s + x.vault.insurancePaidUsd, 0), 2),
    medianSpikeHedgedEndPct: r(median(spikes.map((x) => x.vault.hedgedEndPct))!, 2),
    medianSpikeDrawdownPct: r(median(spikes.map((x) => x.vault.maxDrawdownPct))!, 2),
  },
  calibration: {
    regime: {
      ...regime,
      panicHitRate: r(regime.panicHitRate),
      panicFalseRate: r(regime.panicFalseRate),
      stressedOrWorseInCrashes: r(regime.stressedOrWorseInCrashes),
      test: { crashes: rt(regime.test.crashes), spikes: rt(regime.test.spikes) },
    },
    inSample: { stressed: inSample.stressed, panic: inSample.panic, panicHitRate: r(inSample.panicHitRate), panicFalseRate: r(inSample.panicFalseRate), note: "calibrated on the scored crashes themselves; shown for comparison, not used" },
    tremorPercentiles: Object.fromEntries([0.5, 0.8, 0.9, 0.95, 0.99].map((q) => [String(q), r([...series.slice(12)].sort((a, b) => a - b)[Math.floor(q * (series.length - 13))]!)])),
  },
};

writeFileSync(OUT, `${JSON.stringify(file, null, 1)}\n`);
console.error(`wrote ${OUT.slice(ROOT.length + 1)}`);
if (process.argv.includes("--markdown")) console.log(markdown(file as unknown as ReplayFile));
else console.log(JSON.stringify(file.summary, null, 2));
