/**
 * Keeper: keeps the testnet oracle fed from Pyth Hermes, has the enclave report the vault's
 * hedge and reserves, rebalances the hedge (the vault builds and Chain Signatures signs the
 * order; this service submits it to Hyperliquid), processes the withdrawal queue, liquidates the
 * unprotected demo positions it watches, warns about expiring mandates, and checks that the
 * indexer keeps up with the chain. It transacts on gas-key lanes, so these run in parallel.
 */

import { contract, intEnv, network, NEAR_USD, USDC_USD } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { latest } from "./lib/hermes";
import { submitOrder, type HlOrder } from "./lib/hyperliquid";
import { errorText, log } from "./lib/log";
import { eventsOf, returnValue, rpc, senderFromEnv, txHash, view } from "./lib/near";
import { oraclePrices, readRhea } from "./lib/positions";

const keeper = senderFromEnv("KEEPER");
const status: Record<string, { ok: boolean; detail: string; at: number }> = {};

function track(name: string, f: () => Promise<string>) {
  return async () => {
    try {
      const detail = await f();
      status[name] = { ok: true, detail, at: Date.now() };
    } catch (e) {
      status[name] = { ok: false, detail: errorText(e), at: Date.now() };
      throw e;
    }
  };
}

/** Publishes Hermes' NEAR and USDC prices to Parry's testnet oracle (never on mainnet). */
async function feed(): Promise<string> {
  if (network !== "testnet") return "mainnet uses the lending contract's own oracle";
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const prices = await latest([NEAR_USD, USDC_USD]);
  const updates = prices.map((p) => ({ price_id: p.id.replace(/^0x/, ""), price: p.price, conf: p.conf, expo: p.expo, publish_time: p.publishTime }));
  try {
    await keeper.call({ receiverId: contract("oracle"), methodName: "update_prices", args: { updates }, tgas: 30 });
  } catch (e) {
    // Hermes had no newer price than the one already published: nothing to do.
    if (/not newer|publish_time/i.test(errorText(e))) return "already current";
    throw e;
  }
  return `NEAR ${Number(prices[0]!.price) * 10 ** prices[0]!.expo}`;
}

async function vaultReport(sql: Sql): Promise<string> {
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  type Out = { report_json: string; signature: string; reserve_leaves: unknown[]; hedge_address: string };
  const run = await runEnclave<Out>("vault_report");
  const o = await keeper.call({ receiverId: contract("risk"), methodName: "submit", args: { report_json: run.output.report_json, signature: run.output.signature }, tgas: 120 });
  const report = JSON.parse(run.output.report_json) as { run_id: number; score: number };
  await sql`INSERT INTO reports (kind, run_id, tx_hash, payload, extra) VALUES ('vault_report', ${report.run_id}, ${txHash(o)}, ${sql.json(report as never)},
    ${sql.json({ outlayerTx: run.tx, leaves: run.output.reserve_leaves, hedgeAddress: run.output.hedge_address } as never)}) ON CONFLICT DO NOTHING`;
  const state = await view<{ share_price_e6: string; nav_e6: string; risk_score: number; hedge: { current_e8: string; target_e8: string } }>(contract("vault"), "vault_state");
  const target = Number(state.hedge.target_e8);
  await sql`INSERT INTO vault_history (t, share_price, nav, score, hedged) VALUES (date_trunc('minute', now()), ${Number(state.share_price_e6) / 1e6}, ${Number(state.nav_e6) / 1e6},
    ${state.risk_score}, ${target > 0 ? Number(state.hedge.current_e8) / target : 0}) ON CONFLICT (t) DO NOTHING`;
  return `report ${txHash(o)}, score ${report.score}`;
}

async function rebalance(): Promise<string> {
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const o = await keeper.call({ receiverId: contract("vault"), methodName: "rebalance", args: {}, tgas: 150 });
  const sig = returnValue<{ r: string; s: string; v: number } | null>(o);
  const ev = eventsOf(o).find((e) => e.event === "hedge_order");
  if (!sig || !ev) return "in band";
  const { order, nonce } = ev.data as { order: HlOrder; nonce: number };
  const res = await submitOrder(order, nonce, sig);
  log.info("hedge order", { order, res });
  return `order ${order.is_buy ? "buy" : "sell"} ${order.size} at ${order.price}: ${res.status}`;
}

async function withdrawals(): Promise<string> {
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const state = await view<{ queue_length: number }>(contract("vault"), "vault_state");
  if (state.queue_length === 0) return "queue empty";
  const o = await keeper.call({ receiverId: contract("vault"), methodName: "process_withdrawals", args: { max: 4 }, tgas: 300 });
  return `processed ${returnValue<number>(o) ?? 0}`;
}

/** Liquidates watched, unprotected test positions once their health is below 1. */
async function liquidator(sql: Sql): Promise<string> {
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const { near } = await oraclePrices(120);
  if (near === null) return "no fresh price";
  let done = 0;
  for (const { account } of await sql<{ account: string }[]>`SELECT account FROM liquidation_watch`) {
    const r = await readRhea(account, near);
    if (!r || r.debtUsd === 0) continue;
    const c = r.position.collateral[0]!;
    const d = r.position.debt[0]!;
    const C = c.amount * near * c.volatilityRatio;
    const B = d.amount / d.volatilityRatio;
    if (C >= B) continue;
    // Repay a slice that leaves the account still at risk (the lending contract requires it),
    // taking collateral worth a little less than the discounted repayment.
    const discount = (B - C) / B / 2;
    const repay = Math.max(1, Math.floor(d.amount * 0.05));
    const takeNear = ((repay / (1 - discount)) * 0.98) / near;
    try {
      await keeper.call({
        receiverId: contract("lending"),
        methodName: "execute_with_pyth",
        args: { actions: [{ Liquidate: { account_id: account, in_assets: [{ token_id: contract("usdc"), amount: (BigInt(repay) * 10n ** 18n).toString() }], out_assets: [{ token_id: contract("wnear"), amount: (BigInt(Math.floor(takeNear * 1e6)) * 10n ** 18n).toString() }], position: null, min_token_amounts: null } }] },
        deposit: 1n,
        tgas: 300,
      });
      done++;
      await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES (${account}, 'health', 'critical', ${`liquidated:${Date.now()}`}, 'Liquidated', ${`A liquidator repaid ${repay} USDC of this unprotected position and took ${takeNear.toFixed(2)} NEAR of collateral.`})`;
    } catch (e) {
      log.warn("liquidation failed", { account, error: errorText(e) });
    }
  }
  return `${done} liquidations`;
}

async function mandates(sql: Sql): Promise<string> {
  let soon = 0;
  for (const { account } of await sql<{ account: string }[]>`SELECT account FROM accounts`) {
    const m = await view<{ mandate: { expires_at: number }; expired: boolean } | null>(account, "mandate").catch(() => null);
    if (!m || m.expired) continue;
    if (m.mandate.expires_at - Date.now() / 1000 < 86_400) {
      soon++;
      await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES (${account}, 'guardian', 'warning', ${`expiry:${m.mandate.expires_at}`},
        'Mandate expires within a day', 'Renew it in Protect, or the guardian stops protecting this account.') ON CONFLICT DO NOTHING`;
    }
  }
  return `${soon} mandates expire within a day`;
}

async function indexerCheck(sql: Sql): Promise<string> {
  const head = await rpc<{ header: { height: number } }>("block", { finality: "final" });
  const [c] = await sql<{ last: string }[]>`SELECT max(last_block)::text AS last FROM indexer_cursors`;
  const lag = head.header.height - Number(c?.last ?? 0);
  await setStatus(sql, "indexer-lag", lag < 600, `${lag} blocks behind the chain head`);
  return `indexer ${lag} blocks behind`;
}

export async function main() {
  const sql = db();
  await migrate(sql);
  every(intEnv("FEED_MS", 20_000), "feed", track("feed", feed));
  every(intEnv("VAULT_REPORT_MS", 300_000), "vault-report", track("vault-report", () => vaultReport(sql)));
  every(intEnv("REBALANCE_MS", 120_000), "rebalance", track("rebalance", rebalance));
  every(intEnv("WITHDRAW_MS", 120_000), "withdrawals", track("withdrawals", withdrawals));
  every(intEnv("LIQUIDATOR_MS", 30_000), "liquidator", track("liquidator", () => liquidator(sql)));
  every(600_000, "mandates", track("mandates", () => mandates(sql)));
  every(60_000, "indexer-check", track("indexer-check", () => indexerCheck(sql)));
  every(30_000, "status", async () => {
    const bad = Object.entries(status).filter(([, s]) => !s.ok);
    await setStatus(sql, "keeper", bad.length === 0, bad.length ? bad.map(([n, s]) => `${n}: ${s.detail}`).join("; ").slice(0, 400) : Object.entries(status).map(([n, s]) => `${n}: ${s.detail}`).join("; ").slice(0, 400));
  });
  serveHealth("keeper", intEnv("PORT", 4400), async () => ({ ok: Object.values(status).every((s) => s.ok) && !!keeper, detail: keeper ? "running" : "KEEPER wallet is not configured", tasks: status }));
}
