/**
 * Guardian relay: runs the enclave for accounts the risk engine queued, then carries out what
 * it signed. It holds no power of its own: the account accepts an envelope only with the
 * enclave's signature and only within the mandate, and the risk board records the decision only
 * with the same key. This service just pays the gas and talks to Hyperliquid and EVM RPCs.
 */

import type { FinalExecutionOutcome } from "near-kit";
import { contract, intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { APPROVAL_TOPIC, assembleSigned, broadcast, finalizedBlock, receipt, REPAY_TOPIC, signerOf, verifyOnNear, waitForReceipt } from "./lib/evm";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { submitOrder, type HlOrder } from "./lib/hyperliquid";
import { errorText, log } from "./lib/log";
import { eventsOf, returnValue, senderFromEnv, TxError, txHash } from "./lib/near";
import { derivedAddress, oraclePrices, PATH_EVM, readRhea } from "./lib/positions";
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

type EvmSignature = { r: string; s: string; v: number };

/**
 * Adds the MPC signature to the transaction the account built, checks it recovers to the
 * person's own derived address, broadcasts it and waits for the receipt. The keeper later has the
 * MPC network verify it once final (`txs.evm_verify`).
 */
async function sendEvm(account: string, o: FinalExecutionOutcome, txs: Record<string, string | null>, outcome: string, detail: string) {
  const sig = returnValue<EvmSignature | null>(o);
  const signed = eventsOf(o).find((e) => e.standard === "parry-account" && e.event === "evm_signed")?.data as { unsigned_tx: string } | undefined;
  if (!sig || !signed) return { outcome: outcome === "executed" ? "refused" : outcome, detail: detail || "the account did not sign the EVM transaction" };
  const own = await derivedAddress(account, PATH_EVM);
  if (signerOf(signed.unsigned_tx, sig).toLowerCase() !== own.toLowerCase()) {
    return { outcome: "failed", detail: "the MPC signature does not recover to the account's EVM address" };
  }
  const hash = await broadcast(assembleSigned(signed.unsigned_tx, sig));
  txs.evm = hash;
  const r = await waitForReceipt(hash);
  if (!r) return { outcome, detail: "broadcast; the receipt is not in yet" };
  if (r.status !== "0x1") return { outcome: "failed", detail: "the EVM transaction reverted" };
  return { outcome, detail };
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
      if (actionName === "evm_approve" || actionName === "evm_repay") {
        ({ outcome, detail } = await sendEvm(d.account, o, txs, outcome, detail));
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

/**
 * Once an EVM rescue's block is final, the MPC network verifies the transaction on the foreign
 * chain and signs what it found (the block hash and the repay or approval log), so the outcome
 * is attested on NEAR as well as on the EVM chain.
 */
export async function verifyEvm(sql: Sql): Promise<number> {
  if (!wallet) return 0;
  const rows = await sql<{ id: string; action: string; txs: Record<string, string | null> }[]>`SELECT id, action, txs FROM decisions
    WHERE txs->>'evm' IS NOT NULL AND txs->>'evm_verify' IS NULL AND outcome = 'executed' AND created_at > now() - interval '2 days' ORDER BY created_at LIMIT 5`;
  if (rows.length === 0) return 0;
  const final = await finalizedBlock();
  let done = 0;
  for (const row of rows) {
    const r = await receipt(row.txs.evm!).catch(() => null);
    if (!r || Number(BigInt(r.blockNumber)) > final) continue;
    const topic = row.action === "evm_repay" ? REPAY_TOPIC : APPROVAL_TOPIC;
    const found = r.logs.find((l) => l.topics[0]?.toLowerCase() === topic);
    let tx: string | null = null;
    let result: unknown = null;
    try {
      const o = await verifyOnNear(wallet, row.txs.evm!, found ? Number(BigInt(found.logIndex)) : null);
      tx = txHash(o);
      result = returnValue(o) ?? null;
    } catch (e) {
      log.warn("foreign transaction verification failed", { decision: row.id, error: errorText(e) });
      if (!(e instanceof TxError) || !e.hash) continue;
      tx = e.hash;
    }
    const payloadHash = (result as { payload_hash?: string } | null)?.payload_hash ?? null;
    await sql`UPDATE decisions SET txs = txs || ${sql.json({ evm_verify: tx, evm_verified: payloadHash ? "verified" : "failed" } as never)} WHERE id = ${row.id}`;
    log.info("foreign transaction verified", { decision: row.id, near: tx, payloadHash });
    done++;
  }
  return done;
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
  every(intEnv("EVM_VERIFY_MS", 60_000), "evm-verify", async () => {
    await verifyEvm(sql);
  });
  serveHealth("guardian", intEnv("PORT", 4300), async () => ({ ok: !!wallet, detail: wallet ? lastDetail : "GUARDIAN_ACCOUNT_ID and GUARDIAN_PRIVATE_KEY are not set", lastRunAt: lastRun ? new Date(lastRun).toISOString() : null }));
}
