/**
 * Monitor: reads every protected position and the market, at each source's pace, and stores raw
 * snapshots for the risk engine. Rhea and the oracle every 10 s, Hyperliquid every 15 s, Aave
 * every 60 s (public RPCs are rate limited), and price samples for the Tremor index.
 */

import { contract, EVM, intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { every, serveHealth } from "./lib/health";
import { mid } from "./lib/hyperliquid";
import { errorText, log } from "./lib/log";
import { view } from "./lib/near";
import { oraclePrices, readAave, readHyperliquid, readRhea } from "./lib/positions";

let lastOk = 0;
let lastError = "";

type MandateView = { expired: boolean; paused_until: number; mandate: { evm: { pool: string; address: string } | null } } | null;
const mandates = new Map<string, { at: number; m: MandateView }>();

/** An account's mandate, read at most once a minute. */
async function mandateOf(account: string): Promise<MandateView> {
  const hit = mandates.get(account);
  if (hit && Date.now() - hit.at < 60_000) return hit.m;
  const m = await view<MandateView>(account, "mandate", {});
  mandates.set(account, { at: Date.now(), m });
  return m;
}

/** A position is protected while its account has a live mandate: only those go to the guardian. */
const guarded = (m: MandateView) => !!m && !m.expired && m.paused_until * 1000 <= Date.now();

async function watched(sql: Sql): Promise<{ account: string; protected: boolean }[]> {
  const rows = await sql<{ account: string; p: boolean }[]>`
    SELECT account, true AS p FROM accounts UNION SELECT account, false AS p FROM liquidation_watch`;
  return Promise.all(rows.map(async (r) => ({ account: r.account, protected: r.p && guarded(await mandateOf(r.account).catch(() => null)) })));
}

async function upsert(sql: Sql, id: string, account: string, venue: string, label: string, raw: unknown, collateralUsd: number, debtUsd: number) {
  await sql`INSERT INTO positions (id, account, venue, label, raw, collateral_usd, debt_usd, read_at)
    VALUES (${id}, ${account}, ${venue}, ${label}, ${sql.json(raw as never)}, ${collateralUsd}, ${debtUsd}, now())
    ON CONFLICT (id) DO UPDATE SET raw = excluded.raw, collateral_usd = excluded.collateral_usd, debt_usd = excluded.debt_usd, label = excluded.label, read_at = now()`;
}

async function tickRhea(sql: Sql) {
  const { near } = await oraclePrices();
  if (near === null) throw new Error("no fresh NEAR price on the oracle");
  await sql`INSERT INTO prices (asset, source, t, price) VALUES ('NEAR', 'oracle', date_trunc('second', now()), ${near}) ON CONFLICT DO NOTHING`;
  for (const w of await watched(sql)) {
    try {
      const r = await readRhea(w.account, near);
      if (!r) {
        await sql`DELETE FROM positions WHERE id = ${`${w.account}:rhea:main`}`;
        continue;
      }
      await upsert(sql, `${w.account}:rhea:main`, w.account, "rhea", "Rhea wNEAR/USDC", { ...r, price: near, protected: w.protected }, r.collateralUsd, r.debtUsd);
    } catch (e) {
      log.warn("rhea read failed", { account: w.account, error: errorText(e) });
    }
  }
}

async function tickHyperliquid(sql: Sql) {
  const m = await mid("NEAR");
  if (m !== null) await sql`INSERT INTO prices (asset, source, t, price) VALUES ('NEAR', 'hyperliquid', date_trunc('second', now()), ${m}) ON CONFLICT DO NOTHING`;
  const accounts = await sql<{ account: string }[]>`SELECT account FROM accounts`;
  for (const { account } of accounts) {
    try {
      const h = await readHyperliquid(account);
      if (h.perp && h.perp.size !== 0) {
        await upsert(sql, `${account}:hyperliquid:NEAR`, account, "hyperliquid", "Hyperliquid NEAR perp", { ...h, mark: m }, Math.abs(h.perp.size) * (m ?? h.perp.entry), 0);
      } else {
        await sql`DELETE FROM positions WHERE id = ${`${account}:hyperliquid:NEAR`}`;
      }
    } catch (e) {
      log.warn("hyperliquid read failed", { account, error: errorText(e) });
    }
  }
}

async function tickAave(sql: Sql) {
  const accounts = await sql<{ account: string; evm_address: string | null }[]>`SELECT account, evm_address FROM accounts`;
  for (const a of accounts) {
    try {
      const m = await mandateOf(a.account);
      const guard = m?.mandate.evm;
      if (!guard) continue;
      const r = await readAave(guard.pool, guard.address);
      if (!r || r.debtUsd === 0) {
        await sql`DELETE FROM positions WHERE id = ${`${a.account}:aave:main`}`;
        continue;
      }
      await upsert(sql, `${a.account}:aave:main`, a.account, "aave", `Aave on ${EVM.name}`, { ...r, pool: guard.pool, address: guard.address }, r.collateralUsd, r.debtUsd);
    } catch (e) {
      log.warn("aave read failed", { account: a.account, error: errorText(e) });
    }
  }
}

export async function main() {
  const sql = db();
  await migrate(sql);
  const guard = (name: string, f: (sql: Sql) => Promise<void>) => async () => {
    try {
      await f(sql);
      lastOk = Date.now();
      lastError = "";
      await setStatus(sql, "monitor", true, `reading ${contract("lending")}`);
    } catch (e) {
      lastError = `${name}: ${errorText(e)}`;
      await setStatus(sql, "monitor", false, lastError).catch(() => {});
      throw e;
    }
  };
  every(intEnv("MONITOR_RHEA_MS", 10_000), "rhea", guard("rhea", tickRhea));
  every(intEnv("MONITOR_HL_MS", 15_000), "hyperliquid", guard("hyperliquid", tickHyperliquid));
  every(intEnv("MONITOR_AAVE_MS", 60_000), "aave", guard("aave", tickAave));
  every(3_600_000, "prune", async () => {
    await sql`DELETE FROM prices WHERE t < now() - interval '3 days'`;
  });
  serveHealth("monitor", intEnv("PORT", 4100), async () => ({ ok: Date.now() - lastOk < 60_000, detail: lastError || "reading", lastOkAt: new Date(lastOk).toISOString() }));
}
