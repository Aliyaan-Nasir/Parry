/**
 * Guardian relay: runs the enclave for accounts the risk engine queued, then carries out what
 * it signed. It holds no power of its own: the account accepts an envelope only with the
 * enclave's signature and only within the mandate, and the risk board records the decision only
 * with the same key. This service just pays the gas and talks to Hyperliquid and EVM RPCs.
 */

import type { FinalExecutionOutcome } from "near-kit";
import { contract, intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { submitOrder, type HlOrder } from "./lib/hyperliquid";
import { errorText, log } from "./lib/log";
import { eventsOf, returnValue, senderFromEnv, TxError, txHash } from "./lib/near";
import { oraclePrices, readRhea } from "./lib/positions";
import { quoteRescue } from "./lib/routes";

const wallet = senderFromEnv("GUARDIAN");
let lastRun = 0;
let lastDetail = "idle";

interface EnclaveDecision {
  account: string;
  venue: string;
  plan: string;
  action: Record<string, unknown>;
  review: Record<string, unknown>;
  review_hash: string;
  outcome: "approved" | "rejected by the review";
  envelope?: string;
  envelope_signature?: string;
  decision_json?: string;
  decision_signature?: string;
}

interface GuardianOutput {
  decisions: EnclaveDecision[];
  skipped: { account: string; reason: string }[];
  public_key: string;
}

async function health(account: string): Promise<number | null> {
  const { near } = await oraclePrices();
  if (near === null) return null;
  const r = await readRhea(account, near).catch(() => null);
  if (!r || r.debtUsd === 0) return null;
  const c = r.position.collateral[0]!;
  const d = r.position.debt[0]!;
  return (c.amount * c.priceUsd * c.volatilityRatio) / (d.amount / d.volatilityRatio);
}

function outcomeOf(o: FinalExecutionOutcome): { outcome: string; detail: string } {
  const events = eventsOf(o);
  const has = (name: string) => events.some((e) => e.standard === "parry-account" && e.event === name);
  const refused = events.find((e) => e.event === "guardian_refused")?.data as { reason?: string } | undefined;
  if (has("deleverage_rolled_back")) return { outcome: "rolled_back", detail: refused?.reason ?? "a step failed and the position was restored" };
  if (has("deleverage_unsafe")) return { outcome: "executed", detail: "health stayed under the floor; the guardian paused itself for a day" };
  if (refused) return { outcome: "refused", detail: refused.reason ?? "refused by the account" };
  return { outcome: "executed", detail: "" };
}

async function carryOut(sql: Sql, d: EnclaveDecision) {
  const id = JSON.parse(d.decision_json ?? "{}").id ?? d.review_hash;
  const actionName = Object.keys(d.action)[0] ?? "unknown";
  const trigger = d.decision_json ? JSON.parse(d.decision_json).trigger : {};
  const before = await health(d.account);
  const txs: Record<string, string | null> = { action: null, record: null, hyperliquid: null, evm: null };
  let outcome = "rejected_by_review";
  let detail = "";
  let routes = null;
  if (d.venue === "rhea" && actionName === "deleverage") {
    const amount = Number(BigInt((d.action.deleverage as { amount: string }).amount) / 10n ** 20n) / 1e4;
    routes = await quoteRescue(amount).catch(() => null);
  }
  if (d.outcome === "approved" && d.envelope && d.envelope_signature && wallet) {
    try {
      const o = await wallet.call({
        receiverId: d.account,
        methodName: "guardian_execute",
        args: { envelope: d.envelope, signature: d.envelope_signature },
        tgas: actionName === "deleverage" ? 900 : 300,
      });
      txs.action = txHash(o);
      ({ outcome, detail } = outcomeOf(o));
      if (actionName === "hl_reduce" || actionName === "hl_hedge") {
        const sig = returnValue<{ r: string; s: string; v: number } | null>(o);
        const a = d.action[actionName] as { order: HlOrder; nonce: number };
        if (sig) {
          const res = await submitOrder(a.order, a.nonce, sig);
          txs.hyperliquid = JSON.stringify(res).slice(0, 300);
          if (res.status !== "ok") detail = `Hyperliquid answered ${JSON.stringify(res.response ?? res).slice(0, 200)}`;
        } else {
          outcome = "refused";
        }
      }
    } catch (e) {
      outcome = "refused";
      detail = errorText(e);
      if (e instanceof TxError) txs.action = e.hash ?? null;
    }
    try {
      const r = await wallet.call({ receiverId: contract("risk"), methodName: "submit", args: { report_json: d.decision_json, signature: d.decision_signature }, tgas: 100 });
      txs.record = txHash(r);
    } catch (e) {
      log.warn("decision record failed", { error: errorText(e) });
    }
  }
  const after = await health(d.account);
  await sql`INSERT INTO decisions (id, account, venue, action, plan, trigger, outcome, review, envelope, envelope_signature, txs, health_before, health_after, routes, detail)
    VALUES (${id}, ${d.account}, ${d.venue}, ${actionName}, ${d.plan}, ${sql.json(trigger)}, ${outcome}, ${sql.json(d.review as never)}, ${d.envelope ?? null},
      ${d.envelope_signature ?? null}, ${sql.json(txs as never)}, ${before}, ${after}, ${routes ? sql.json(routes as never) : null}, ${detail})
    ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES (${d.account}, 'guardian', 'info', ${`guardian:${id}`},
    ${`Guardian ${outcome.replace("_", " ")}: ${actionName.replace("_", " ")}`}, ${d.plan}) ON CONFLICT DO NOTHING`;
  log.info("guardian decision", { account: d.account, action: actionName, outcome, tx: txs.action });
}

export async function tick(sql: Sql) {
  const due = await sql<{ account: string }[]>`SELECT account FROM guardian_queue
    WHERE last_run_at IS NULL OR last_run_at < now() - make_interval(secs => ${intEnv("GUARDIAN_COOLDOWN_S", 60)}) ORDER BY queued_at LIMIT 10`;
  if (due.length === 0) return;
  const accounts = due.map((d) => d.account);
  const run = await runEnclave<GuardianOutput>("guardian", accounts);
  for (const d of run.output.decisions) await carryOut(sql, d);
  for (const s of run.output.skipped) {
    if (s.reason === "no action needed") await sql`DELETE FROM guardian_queue WHERE account = ${s.account}`;
    else log.info("guardian skipped", { account: s.account, reason: s.reason });
  }
  await sql`UPDATE guardian_queue SET last_run_at = now() WHERE account = ANY(${accounts})`;
  lastRun = Date.now();
  lastDetail = `${run.output.decisions.length} decisions, ${run.output.skipped.length} skipped${run.tx ? `, OutLayer ${run.tx}` : ""}`;
}

export async function main() {
  const sql = db();
  await migrate(sql);
  every(intEnv("GUARDIAN_MS", 15_000), "guardian", async () => {
    try {
      await tick(sql);
      await setStatus(sql, "guardian", true, lastDetail);
    } catch (e) {
      lastDetail = errorText(e);
      await setStatus(sql, "guardian", false, lastDetail);
      throw e;
    }
  });
  serveHealth("guardian", intEnv("PORT", 4300), async () => ({ ok: !!wallet, detail: wallet ? lastDetail : "GUARDIAN_ACCOUNT_ID and GUARDIAN_PRIVATE_KEY are not set", lastRunAt: lastRun ? new Date(lastRun).toISOString() : null }));
}
