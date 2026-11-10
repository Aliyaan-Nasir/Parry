/**
 * Keeper: keeps the testnet oracle fed with the live prices mainnet lending uses, has the enclave report the vault's
 * hedge and reserves, rebalances the hedge (the vault builds and Chain Signatures signs the
 * order; this service submits it to Hyperliquid), processes the withdrawal queue, liquidates the
 * unprotected demo positions it watches, warns about expiring mandates, keeps the risk board's
 * sealing key equal to the enclave's, and checks that the indexer keeps up with the chain. It
 * transacts on gas-key lanes, so these run in parallel.
 */

import { contract, intEnv, network, NEAR_USD, USDC_USD } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { latest, PRICE_SOURCE } from "./lib/prices";
import { submitOrder, type HlOrder } from "./lib/hyperliquid";
import { errorText, log } from "./lib/log";
import { eventsOf, returnValue, rpc, senderFromEnv, tendGasKey, txHash, view } from "./lib/near";
import { oraclePrices, readRhea } from "./lib/positions";
import { marginQuote } from "./lib/routes";

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

/** Mirrors mainnet's lending oracle prices for NEAR and USDC into Parry's testnet oracle (never on mainnet). */
async function feed(): Promise<string> {
  if (network !== "testnet") return "mainnet uses the lending contract's own oracle";
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const prices = await latest([NEAR_USD, USDC_USD]);
  // The testnet oracle's publish time is when this feeder observed the price (the source's own
  // timestamp can lag past the lending contract's 120 s freshness window between its updates).
  const observed = Math.floor(Date.now() / 1000);
  const updates = prices.map((p) => ({ price_id: p.id.replace(/^0x/, ""), price: p.price, conf: p.conf, expo: p.expo, publish_time: observed }));
  try {
    await keeper.call({ receiverId: contract("oracle"), methodName: "update_prices", args: { updates }, tgas: 30 });
  } catch (e) {
    // The source has not published a newer price yet: nothing to do.
    if (/not newer|publish_time/i.test(errorText(e))) return "already current";
    throw e;
  }
  return `NEAR ${Number(prices[0]!.price) * 10 ** prices[0]!.expo} from ${PRICE_SOURCE}`;
}

async function vaultReport(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
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

/**
 * Keeps the risk board's sealing key equal to the enclave's: owners seal their policies to the
 * key the board publishes, and only the enclave's signed `sealing_key` report can set it.
 */
async function sealingKey(): Promise<string> {
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  type Keys = { public_key: string; sealing_public_key: string; report_json: string; signature: string };
  const run = await runEnclave<Keys>("keys");
  const onBoard = await view<{ public_key: string } | null>(contract("risk"), "sealing_key").catch(() => null);
  if (onBoard?.public_key === run.output.sealing_public_key) return `current (${run.output.sealing_public_key.slice(0, 12)})`;
  const o = await keeper.call({ receiverId: contract("risk"), methodName: "submit", args: { report_json: run.output.report_json, signature: run.output.signature }, tgas: 50 });
  log.info("sealing key published", { tx: txHash(o), key: run.output.sealing_public_key });
  return `published in ${txHash(o)}`;
}

/**
 * When the vault's hedge needs margin, records how it would be funded: a dry-run 1Click quote
 * from USDC on NEAR to USDC on HyperCore, delivered to the vault's Chain Signatures address.
 * The operator executes it on mainnet; nothing moves here.
 */
async function marginRoute(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
  const v = await view<{ hedge: { needs_margin?: boolean } }>(contract("vault"), "vault_state");
  if (!v.hedge.needs_margin) return "margin sufficient";
  const [r] = await sql<{ extra: { hedgeAddress?: string } }[]>`SELECT extra FROM reports WHERE kind = 'vault_report' ORDER BY run_id DESC LIMIT 1`;
  const recipient = r?.extra?.hedgeAddress;
  if (!recipient) return "no hedge address reported yet";
  const route = await marginQuote(intEnv("MARGIN_TOPUP_USD", 100), recipient);
  await sql`INSERT INTO reports (kind, run_id, payload) VALUES ('margin_route', ${Date.now()}, ${sql.json(route as never)}) ON CONFLICT DO NOTHING`;
  return "outUsd" in route.quote ? `margin needed: ${route.amountUsd} USDC routes to ${route.quote.outUsd} on HyperCore` : `margin needed; ${route.quote.unavailable}`;
}

async function rebalance(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const o = await keeper.call({ receiverId: contract("vault"), methodName: "rebalance", args: {}, tgas: 150 });
  const sig = returnValue<{ r: string; s: string; v: number } | null>(o);
  const ev = eventsOf(o).find((e) => e.event === "hedge_order");
  if (!sig || !ev) return "in band";
  const { order, nonce, digest } = ev.data as { order: HlOrder; nonce: number; digest: string };
  const res = await submitOrder(order, nonce, sig);
  // The signed order and Hyperliquid's answer, for the API and `pnpm verify`.
  await sql`INSERT INTO reports (kind, run_id, tx_hash, payload) VALUES ('hedge_order', ${nonce}, ${txHash(o)},
    ${sql.json({ order, nonce, digest, signature: sig, status: res.status, response: res } as never)}) ON CONFLICT DO NOTHING`;
  log.info("hedge order", { order, res, tx: txHash(o) });
  return `order ${order.is_buy ? "buy" : "sell"} ${order.size} at ${order.price}: ${res.status}`;
}

async function withdrawals(): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
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
  every(600_000, "gas-key", () => tendGasKey(sql, "keeper", keeper));
  every(intEnv("FEED_MS", 20_000), "feed", track("feed", feed));
  every(intEnv("SEALING_KEY_MS", 6 * 3_600_000), "sealing-key", track("sealing-key", sealingKey));
  every(intEnv("VAULT_REPORT_MS", 300_000), "vault-report", track("vault-report", () => vaultReport(sql)));
  every(intEnv("REBALANCE_MS", 120_000), "rebalance", track("rebalance", () => rebalance(sql)));
  every(intEnv("MARGIN_ROUTE_MS", 1_800_000), "margin-route", track("margin-route", () => marginRoute(sql)));
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
