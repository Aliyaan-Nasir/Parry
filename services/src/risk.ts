/**
 * Risk engine: turns the monitor's snapshots into scores with @parry/core (Tremor index from the
 * stored price samples, cascade pressure across every position, first-passage probabilities),
 * keeps history, raises and resolves alerts, queues protected accounts for the guardian, and has
 * the enclave publish signed scores and marks on the risk board.
 */

import {
  alertsFor,
  assess,
  assessPerp,
  cascade,
  cascadeAlert,
  DEFAULT_ANNUAL_VOL,
  DEFAULT_THRESHOLDS,
  liquidationProbability,
  riskScore,
  timeToLiquidation,
  tremor,
  valueAtRisk99,
  MAX_TRIGGER_HEALTH,
  heatmapPressure,
  type AlertThresholds,
  type Assessment,
  type HeatmapAccount,
} from "@parry/core";
import { contract, intEnv, type Network } from "./lib/config";
import { cascadeParams, heatmapAccounts, sweep } from "./lib/heatmap";
import { nearHistory } from "./lib/history";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";
import { senderFromEnv, tendGasKey, txHash } from "./lib/near";

const reporter = senderFromEnv("MONITOR");
let lastOk = 0;
let lastReport = "";

type Row = { id: string; account: string; venue: string; label: string; raw: Record<string, unknown>; collateral_usd: number; debt_usd: number };

/**
 * Aave reports its own health factor; with collateral moving as one asset, liquidation is a fall
 * of the collateral to 1/health of today's price. Parry keeps no price history for that asset, so
 * the Tremor index's default volatility stands in, which the result says (tremor.fallback).
 */
export function assessAave(health: number, now: number): Assessment {
  const sigma = DEFAULT_ANNUAL_VOL / Math.sqrt(8760);
  const liq = Number.isFinite(health) && health > 0 ? 1 / health : null;
  const p24 = liquidationProbability(1, liq, sigma, 0, 24);
  const t = tremor([], now);
  return {
    health,
    driverPrice: 1,
    liqPrice: liq,
    distance: liq === null ? 1 : Math.max(0, 1 - liq),
    tremor: t,
    trendHourly: 0,
    probability24h: p24,
    probability4h: liquidationProbability(1, liq, sigma, 0, 4),
    ttl: timeToLiquidation(1, liq, sigma, 0),
    valueAtRisk99: valueAtRisk99(0, 0, 1, liq, sigma),
    score: riskScore({ health, probability24h: p24, annualVol: t.annual, cascadePressure: 0 }),
  };
}

/** Mainnet's borrowers from the heatmap, read at most once a minute (the scoring loop runs every 10 s). */
const heatmapCache = new WeakMap<Sql, { at: number; accounts: HeatmapAccount[] }>();
async function marketBorrowers(sql: Sql): Promise<HeatmapAccount[]> {
  const hit = heatmapCache.get(sql);
  if (hit && Date.now() - hit.at < 60_000) return hit.accounts;
  const accounts = await heatmapAccounts(sql, "mainnet").catch(() => []);
  heatmapCache.set(sql, { at: Date.now(), accounts });
  return accounts;
}

/** Raises and resolves the risk and health alerts of one position for one person, at their thresholds. */
async function raiseAlerts(sql: Sql, account: string, positionId: string, label: string, a: Assessment, thresholds: AlertThresholds) {
  const raised = alertsFor({ id: positionId, label }, { score: a.score.score, tier: a.score.tier, health: a.health, ttlHours: a.ttl.medianHours }, thresholds);
  for (const al of raised) {
    await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES (${account}, ${al.kind}, ${al.severity}, ${al.key}, ${al.title}, ${al.body})
      ON CONFLICT (account, key) WHERE status <> 'resolved' DO UPDATE SET severity = excluded.severity, title = excluded.title, body = excluded.body, updated_at = now()`;
  }
  const keys = raised.map((x) => x.key);
  await sql`UPDATE alerts SET status = 'resolved', updated_at = now() WHERE account = ${account} AND status <> 'resolved'
    AND kind IN ('risk', 'health') AND key LIKE ${`%:${positionId}`} AND NOT (key = ANY(${keys}))`;
}

export async function scoreAll(sql: Sql): Promise<number> {
  const now = Date.now() / 1000;
  // The oracle sets the price positions are valued at; volatility comes from the market.
  const { price, history: marketHistory, hyperliquid: hlHistory } = await nearHistory(sql);
  const rows = await sql<Row[]>`SELECT id, account, venue, label, raw, collateral_usd, debt_usd FROM positions`;
  const tr = tremor(marketHistory, now);

  // Cascade pressure across every lending position on the same driver.
  const lending = rows.filter((r) => r.venue === "rhea");
  const liquidity = intEnv("CASCADE_LIQUIDITY_USD", 250_000);
  const cascadeInputs = lending.map((r) => {
    const a = assess(r.raw.position as never, price, marketHistory, now);
    return { owner: r.account, venue: "rhea", liqPrice: a.liqPrice, collateralUsd: r.collateral_usd };
  });
  const own = cascade(cascadeInputs, price, tr.sigmaHourly, liquidity);
  // The market's own borrowers (the heatmap of mainnet Rhea lending) set the pressure once read;
  // until then, the positions Parry monitors do.
  const borrowers = await marketBorrowers(sql);
  const fromHeatmap = borrowers.length > 0 ? heatmapPressure(borrowers, price, tr.sigmaHourly, cascadeParams()) : null;
  const c = fromHeatmap ? { ...own, pressure: fromHeatmap.pressure, atRiskUsd: fromHeatmap.atRiskUsd } : own;
  const cascadeSource = fromHeatmap
    ? { source: "heatmap" as const, network: "mainnet" as Network, accounts: borrowers.length, cascadeTo: fromHeatmap.to, soldUsd: fromHeatmap.soldUsd, sigmaHourly: tr.sigmaHourly }
    : { source: "positions" as const, network: null, accounts: lending.length, cascadeTo: null, soldUsd: null, sigmaHourly: tr.sigmaHourly };

  for (const r of rows) {
    let a;
    if (r.venue === "rhea") {
      a = assess(r.raw.position as never, price, marketHistory, now, c.pressure);
    } else if (r.venue === "hyperliquid") {
      const perp = r.raw.perp as { size: number; liquidation: number | null } | null;
      const mark = Number(r.raw.mark ?? 0);
      if (!perp || !mark) continue;
      a = assessPerp({ size: perp.size, markPrice: mark, liquidationPx: perp.liquidation, history: hlHistory, now });
    } else {
      a = assessAave(Number(r.raw.health), now);
    }
    const health = Number.isFinite(a.health) ? a.health : null;
    await sql`UPDATE positions SET health = ${health}, liq_price = ${a.liqPrice}, distance = ${a.distance}, score = ${a.score.score}, tier = ${a.score.tier},
      p24 = ${a.probability24h}, ttl_hours = ${a.ttl.medianHours}, var99 = ${a.valueAtRisk99}, scored_at = now() WHERE id = ${r.id}`;
    await sql`INSERT INTO position_history (position_id, t, health, score, price) VALUES (${r.id}, date_trunc('minute', now()), ${health}, ${a.score.score}, ${a.driverPrice})
      ON CONFLICT (position_id, t) DO UPDATE SET health = excluded.health, score = excluded.score, price = excluded.price`;

    // Alerts, with the person's thresholds; a watched account's alerts go to whoever watches it.
    const [s] = await sql<{ thresholds: typeof DEFAULT_THRESHOLDS }[]>`SELECT thresholds FROM settings WHERE account = ${r.account}`;
    if (r.raw.watched !== true) await raiseAlerts(sql, r.account, r.id, r.label, a, s?.thresholds ?? DEFAULT_THRESHOLDS);
    const watchers = await sql<{ owner: string; label: string | null; thresholds: { score: number; health: number } }[]>`SELECT owner, label, thresholds FROM watched WHERE account = ${r.account}`;
    for (const w of watchers) {
      await raiseAlerts(sql, w.owner, r.id, `${w.label ?? r.account}: ${r.label}`, a, { ...DEFAULT_THRESHOLDS, ...w.thresholds });
    }

    // Protected accounts in caution or worse, or under the highest trigger health a sealed policy
    // may hold, go to the guardian (it decides with the policy); the queue keeps each account's
    // last run, so the guardian's cooldown holds.
    if (r.raw.protected !== false && (a.score.tier !== "safe" || a.health < MAX_TRIGGER_HEALTH)) {
      await sql`INSERT INTO guardian_queue (account, reason) VALUES (${r.account}, ${`${r.venue} ${a.score.tier} ${a.score.score}`})
        ON CONFLICT (account) DO UPDATE SET reason = excluded.reason`;
    } else {
      await sql`DELETE FROM guardian_queue WHERE account = ${r.account} AND reason LIKE ${`${r.venue} %`}`;
    }
  }
  const market = cascadeAlert("NEAR", c.pressure, c.atRiskUsd, DEFAULT_THRESHOLDS);
  if (market) {
    for (const owner of new Set(lending.map((l) => l.account))) {
      await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES (${owner}, 'cascade', ${market.severity}, ${market.key}, ${market.title}, ${market.body})
        ON CONFLICT (account, key) WHERE status <> 'resolved' DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = now()`;
    }
  } else {
    await sql`UPDATE alerts SET status = 'resolved', updated_at = now() WHERE kind = 'cascade' AND status <> 'resolved'`;
  }
  await sql`INSERT INTO reports (kind, run_id, payload) VALUES ('market', ${Date.now()}, ${sql.json({ tremor: { sigmaHourly: tr.sigmaHourly, annual: tr.annual, level: tr.level, regime: tr.regime, windows: tr.windows }, cascade: { pressure: c.pressure, atRiskUsd: c.atRiskUsd, correlatedOwners: c.correlatedOwners.length, ...cascadeSource }, price } as never)})`;
  await sql`DELETE FROM reports WHERE kind = 'market' AND created_at < now() - interval '1 day'`;
  return rows.length;
}

/** Signed scores and marks on chain, through the enclave. */
async function publish(sql: Sql) {
  const accounts = (await sql<{ account: string }[]>`SELECT DISTINCT account FROM positions WHERE venue = 'rhea' AND account IN (SELECT account FROM accounts) LIMIT 25`).map((r) => r.account);
  type Out = { report_json: string; signature: string; details: unknown[]; tremor: unknown; warnings: string[] };
  const run = await runEnclave<Out>("risk_update", accounts);
  if (!reporter) throw new Error("the monitor wallet is not configured");
  const o = await reporter.call({ receiverId: contract("risk"), methodName: "submit", args: { report_json: run.output.report_json, signature: run.output.signature }, tgas: 100 });
  const report = JSON.parse(run.output.report_json) as { run_id: number };
  await sql`INSERT INTO reports (kind, run_id, tx_hash, payload, extra) VALUES ('risk_update', ${report.run_id}, ${txHash(o)}, ${sql.json(report as never)},
    ${sql.json({ outlayerTx: run.tx, details: run.output.details, tremor: run.output.tremor, warnings: run.output.warnings } as never)}) ON CONFLICT DO NOTHING`;
  lastReport = txHash(o);
  log.info("risk report published", { tx: txHash(o), outlayer: run.tx, accounts: accounts.length });
}

export async function main() {
  const sql = db();
  await migrate(sql);
  every(intEnv("RISK_MS", 10_000), "score", async () => {
    const n = await scoreAll(sql);
    lastOk = Date.now();
    await setStatus(sql, "risk", true, `${n} positions scored`);
  });
  every(600_000, "gas-key", () => tendGasKey(sql, "monitor", reporter));
  every(intEnv("RISK_PUBLISH_MS", 300_000), "publish", async () => {
    try {
      await publish(sql);
      await setStatus(sql, "risk-publisher", true, `last report ${lastReport}`);
    } catch (e) {
      await setStatus(sql, "risk-publisher", false, errorText(e));
      throw e;
    }
  });
  // The liquidation heatmap: a few pages of every Rhea lending account per pass, on both networks.
  const networks = (process.env.HEATMAP_NETWORKS ?? "testnet,mainnet").split(",").map((x) => x.trim()).filter((x): x is Network => x === "testnet" || x === "mainnet");
  every(intEnv("HEATMAP_MS", 120_000), "heatmap", async () => {
    const parts: string[] = [];
    for (const net of networks) {
      try {
        const r = await sweep(sql, net);
        parts.push(`${net}: ${r.read} read, ${r.borrowers} borrowers of ${r.total}`);
      } catch (e) {
        parts.push(`${net}: ${errorText(e)}`);
      }
    }
    await setStatus(sql, "heatmap", !parts.some((p) => /error|failed|rpc /i.test(p)), parts.join("; ").slice(0, 400));
  });
  serveHealth("risk", intEnv("PORT", 4200), async () => ({ ok: Date.now() - lastOk < 60_000, detail: lastReport ? `last report ${lastReport}` : "scoring" }));
}
