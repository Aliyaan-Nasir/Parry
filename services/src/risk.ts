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
  type Assessment,
  type Sample,
} from "@parry/core";
import { contract, intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";
import { senderFromEnv, txHash } from "./lib/near";

const reporter = senderFromEnv("MONITOR");
let lastOk = 0;
let lastReport = "";

type Row = { id: string; account: string; venue: string; label: string; raw: Record<string, unknown>; collateral_usd: number; debt_usd: number };

async function history(sql: Sql, source: string): Promise<Sample[]> {
  const rows = await sql<{ t: Date; price: number }[]>`SELECT t, price FROM prices WHERE asset = 'NEAR' AND source = ${source} AND t > now() - interval '12 hours' ORDER BY t`;
  return rows.map((r) => ({ t: r.t.getTime() / 1000, price: r.price }));
}

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

export async function scoreAll(sql: Sql): Promise<number> {
  const now = Date.now() / 1000;
  const oracleHistory = await history(sql, "oracle");
  const hlHistory = await history(sql, "hyperliquid");
  const rows = await sql<Row[]>`SELECT id, account, venue, label, raw, collateral_usd, debt_usd FROM positions`;
  const tr = tremor(oracleHistory, now);
  const price = oracleHistory[oracleHistory.length - 1]?.price ?? 0;

  // Cascade pressure across every lending position on the same driver.
  const lending = rows.filter((r) => r.venue === "rhea");
  const liquidity = intEnv("CASCADE_LIQUIDITY_USD", 250_000);
  const cascadeInputs = lending.map((r) => {
    const a = assess(r.raw.position as never, price, oracleHistory, now);
    return { owner: r.account, venue: "rhea", liqPrice: a.liqPrice, collateralUsd: r.collateral_usd };
  });
  const c = cascade(cascadeInputs, price, tr.sigmaHourly, liquidity);

  for (const r of rows) {
    let a;
    if (r.venue === "rhea") {
      a = assess(r.raw.position as never, price, oracleHistory, now, c.pressure);
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

    // Alerts, with the person's thresholds.
    const [s] = await sql<{ thresholds: typeof DEFAULT_THRESHOLDS }[]>`SELECT thresholds FROM settings WHERE account = ${r.account}`;
    const thresholds = s?.thresholds ?? DEFAULT_THRESHOLDS;
    const raised = alertsFor({ id: r.id, label: r.label }, { score: a.score.score, tier: a.score.tier, health: a.health, ttlHours: a.ttl.medianHours }, thresholds);
    for (const al of raised) {
      await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES (${r.account}, ${al.kind}, ${al.severity}, ${al.key}, ${al.title}, ${al.body})
        ON CONFLICT (account, key) WHERE status <> 'resolved' DO UPDATE SET severity = excluded.severity, title = excluded.title, body = excluded.body, updated_at = now()`;
    }
    const keys = raised.map((x) => x.key);
    await sql`UPDATE alerts SET status = 'resolved', updated_at = now() WHERE account = ${r.account} AND status <> 'resolved'
      AND kind IN ('risk', 'health') AND key LIKE ${`%:${r.id}`} AND NOT (key = ANY(${keys}))`;

    // Protected accounts in caution or worse go to the guardian (it decides with the sealed policy).
    if (r.raw.protected !== false && a.score.tier !== "safe") {
      await sql`INSERT INTO guardian_queue (account, reason) VALUES (${r.account}, ${`${r.venue} ${a.score.tier} ${a.score.score}`})
        ON CONFLICT (account) DO UPDATE SET reason = excluded.reason`;
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
  await sql`INSERT INTO reports (kind, run_id, payload) VALUES ('market', ${Date.now()}, ${sql.json({ tremor: { sigmaHourly: tr.sigmaHourly, annual: tr.annual, level: tr.level, windows: tr.windows }, cascade: { pressure: c.pressure, atRiskUsd: c.atRiskUsd, correlatedOwners: c.correlatedOwners.length }, price } as never)})`;
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
  every(intEnv("RISK_PUBLISH_MS", 300_000), "publish", async () => {
    try {
      await publish(sql);
      await setStatus(sql, "risk-publisher", true, `last report ${lastReport}`);
    } catch (e) {
      await setStatus(sql, "risk-publisher", false, errorText(e));
      throw e;
    }
  });
  serveHealth("risk", intEnv("PORT", 4200), async () => ({ ok: Date.now() - lastOk < 60_000, detail: lastReport ? `last report ${lastReport}` : "scoring" }));
}
