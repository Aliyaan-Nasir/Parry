/**
 * Keeper: keeps the testnet oracle fed with the live prices mainnet lending uses, has the enclave report the vault's
 * hedge and reserves, rebalances the hedge (the vault builds and Chain Signatures signs the
 * order; this service submits it to Hyperliquid), moves margin that lands in the hedge account's
 * Spot balance into Perps, processes the withdrawal queue, liquidates the
 * unprotected demo positions it watches, warns about expiring mandates, keeps the risk board's
 * sealing key equal to the enclave's, and checks that the indexer keeps up with the chain. It
 * transacts on gas-key lanes, so these run in parallel.
 */

import { contract, intEnv, network, NEAR_USD, USDC_USD } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { runEnclave } from "./lib/enclave";
import { every, serveHealth } from "./lib/health";
import { latest, PRICE_SOURCE } from "./lib/prices";
import { spotUsdc, submitClassTransfer, submitOrder, type HlOrder } from "./lib/hyperliquid";
import { errorText, log } from "./lib/log";
import { eventsOf, returnValue, rpc, senderFromEnv, tendGasKey, txHash, view } from "./lib/near";
import { oraclePrices, readRhea } from "./lib/positions";
import { hyperliquidFunding } from "./lib/markets";
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
  await recordVaultHistory(sql);
  return `report ${txHash(o)}, score ${report.score}`;
}

type VaultStateView = {
  share_price_e6: string;
  nav_e6: string;
  risk_score: number;
  report_at: number;
  staked_linear: string;
  linear_rate_e24: string;
  near_price_e8: string;
  reserves: { root: string } | null;
  hedge: { current_e8: string; target_e8: string; mark_e8: string; account_value_e6: string; hedge_ratio_bps: number; needs_margin: boolean };
};

/** The vault's `insurance()` view, or null while the deployed vault has none. */
export async function insuranceView(): Promise<{ value_usd_e6: string; margin_reserved_usd_e6: string; paid_today_e6: string; cap_per_day_bps: number } | null> {
  return view<{ value_usd_e6: string; margin_reserved_usd_e6: string; paid_today_e6: string; cap_per_day_bps: number }>(contract("vault"), "insurance").catch(() => null);
}

/**
 * One point of the vault's history: share price and NAV, the staking and funding yield so far,
 * the hedge ratio, the insurance fund, the reserves root, the basis (LiNEAR's staking yield plus
 * the funding the short earns, a year) and the drawdown from the best share price.
 */
async function recordVaultHistory(sql: Sql): Promise<void> {
  const state = await view<VaultStateView>(contract("vault"), "vault_state");
  const y = await view<{ staking_rate_growth_bps: number; funding_e6: string }>(contract("vault"), "yield_breakdown").catch(() => null);
  const insurance = await insuranceView();
  const funding = await hyperliquidFunding().catch(() => null);
  const [first] = await sql<{ t: Date | null }[]>`SELECT min(t) AS t FROM vault_history`;
  const [best] = await sql<{ p: number | null }[]>`SELECT max(share_price) AS p FROM vault_history`;
  const days = first?.t ? Math.max(1 / 24, (Date.now() - first.t.getTime()) / 86_400_000) : 0;
  const n = (x: unknown) => Number(x ?? 0);
  const sharePrice = n(state.share_price_e6) / 1e6;
  const growth = (y?.staking_rate_growth_bps ?? 0) / 10_000;
  const linearUsd = (n(state.staked_linear) / 1e24) * (n(state.linear_rate_e24) / 1e24) * (n(state.near_price_e8) / 1e8);
  const stakingApr = days > 0 ? growth * (365 / days) : null;
  const target = n(state.hedge.target_e8);
  const short = n(state.hedge.current_e8) / 1e8;
  const notional = short * (n(state.hedge.mark_e8) / 1e8);
  const basis = stakingApr !== null && funding?.funding24hApr != null ? stakingApr + funding.funding24hApr : null;
  const peak = Math.max(best?.p ?? 0, sharePrice);
  await sql`INSERT INTO vault_history (t, share_price, nav, score, hedged, staking_yield_usd, funding_yield_usd, hedge_ratio, insurance_usd, reserves_root, basis_apr, drawdown, margin_ratio)
    VALUES (date_trunc('minute', now()), ${sharePrice}, ${n(state.nav_e6) / 1e6}, ${state.risk_score}, ${target > 0 ? n(state.hedge.current_e8) / target : 0},
      ${linearUsd * (growth / (1 + growth))}, ${y ? n(y.funding_e6) / 1e6 : null}, ${n(state.hedge.hedge_ratio_bps) / 10_000}, ${insurance ? n(insurance.value_usd_e6) / 1e6 : null},
      ${state.reserves?.root ?? null}, ${basis}, ${peak > 0 ? 1 - sharePrice / peak : 0}, ${notional > 0 ? n(state.hedge.account_value_e6) / 1e6 / notional : null})
    ON CONFLICT (t) DO NOTHING`;
}

export interface MarginDecision {
  action: "none" | "watch" | "top_up" | "unsupported";
  amountUsd: number;
  reason: string;
}

/**
 * What the keeper does about the hedge's margin. Under `early` (account value over the short's
 * notional) it watches and says so before the vault asks; once the vault sets `needs_margin` it
 * pays a top-up from the insurance fund (`insurance_pay` kind `margin_top_up`) back to `target`,
 * but only when the deployed vault has the insurance fund.
 */
export function marginDecision(o: { ratio: number | null; needsMargin: boolean; insurance: boolean; notionalUsd: number; accountValueUsd: number; early: number; target: number }): MarginDecision {
  if (o.ratio === null) return { action: "none", amountUsd: 0, reason: "no short open" };
  if (o.needsMargin) {
    const amountUsd = Math.max(0, o.target * o.notionalUsd - o.accountValueUsd);
    if (!o.insurance) return { action: "unsupported", amountUsd, reason: "the vault needs margin, and the deployed vault has no insurance fund yet: nothing paid" };
    return amountUsd > 0 ? { action: "top_up", amountUsd, reason: `margin ratio ${o.ratio.toFixed(3)} with needs_margin set: top up to ${o.target}` } : { action: "none", amountUsd: 0, reason: "already at the target" };
  }
  if (o.ratio < o.early) return { action: "watch", amountUsd: 0, reason: `margin ratio ${o.ratio.toFixed(3)} is under the early mark ${o.early}; the vault has not asked yet` };
  return { action: "none", amountUsd: 0, reason: `margin ratio ${o.ratio.toFixed(3)}` };
}

/** Margin-ratio monitoring with the early top-up decision (no-op until the vault has `insurance_pay`). */
async function marginWatch(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
  const state = await view<VaultStateView>(contract("vault"), "vault_state");
  const n = (x: unknown) => Number(x ?? 0);
  const notionalUsd = (n(state.hedge.current_e8) / 1e8) * (n(state.hedge.mark_e8) / 1e8);
  const accountValueUsd = n(state.hedge.account_value_e6) / 1e6;
  const insurance = await insuranceView();
  const d = marginDecision({
    ratio: notionalUsd > 0 ? accountValueUsd / notionalUsd : null,
    needsMargin: !!state.hedge.needs_margin,
    insurance: insurance !== null,
    notionalUsd,
    accountValueUsd,
    early: Number(process.env.MARGIN_EARLY_RATIO ?? 0.2),
    target: Number(process.env.MARGIN_TARGET_RATIO ?? 0.4),
  });
  if (d.action === "none") return d.reason;
  await sql`INSERT INTO reports (kind, run_id, payload) VALUES ('margin_watch', ${Date.now()}, ${sql.json(d as never)}) ON CONFLICT DO NOTHING`;
  if (d.action !== "top_up") return d.reason;
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  // One payout an hour at most: the vault's next report shows whether it was enough.
  const [recent] = await sql`SELECT 1 FROM reports WHERE kind = 'insurance_pay' AND created_at > now() - interval '1 hour' LIMIT 1`;
  if (recent) return `${d.reason}; paid within the hour, waiting for the next report`;
  const o = await keeper.call({
    receiverId: contract("vault"),
    methodName: "insurance_pay",
    args: { kind: "margin_top_up", amount_usd_e6: String(Math.round(d.amountUsd * 1e6)), report_at: state.report_at },
    tgas: 50,
  });
  await sql`INSERT INTO reports (kind, run_id, tx_hash, payload) VALUES ('insurance_pay', ${Date.now()}, ${txHash(o)}, ${sql.json({ kind: "margin_top_up", amountUsd: d.amountUsd } as never)}) ON CONFLICT DO NOTHING`;
  return `paid a ${d.amountUsd.toFixed(2)} USD margin top-up in ${txHash(o)}`;
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
 * When the vault's hedge needs margin, or its Hyperliquid account has none yet while NEAR is
 * staked, records how it would be funded: a dry-run 1Click quote from USDC on NEAR to USDC on
 * HyperCore, delivered to the vault's Chain Signatures address. The operator executes it on
 * mainnet; nothing moves here.
 */
async function marginRoute(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
  const v = await view<{ staked_linear?: string; hedge: { needs_margin?: boolean; account_value_e6?: string } }>(contract("vault"), "vault_state");
  const unfunded = BigInt(v.hedge.account_value_e6 ?? "0") === 0n && BigInt(v.staked_linear ?? "0") > 0n;
  if (!v.hedge.needs_margin && !unfunded) return "margin sufficient";
  const [r] = await sql<{ extra: { hedgeAddress?: string } }[]>`SELECT extra FROM reports WHERE kind = 'vault_report' ORDER BY run_id DESC LIMIT 1`;
  const recipient = r?.extra?.hedgeAddress;
  if (!recipient) return "no hedge address reported yet";
  const route = await marginQuote(intEnv("MARGIN_TOPUP_USD", 100), recipient);
  await sql`INSERT INTO reports (kind, run_id, payload) VALUES ('margin_route', ${Date.now()}, ${sql.json(route as never)}) ON CONFLICT DO NOTHING`;
  return "outUsd" in route.quote ? `margin needed: ${route.amountUsd} USDC routes to ${route.quote.outUsd} on HyperCore` : `margin needed; ${route.quote.unavailable}`;
}

/** The Spot USDC to move into Perps: whole cents, nothing under `min`. */
export function sweepAmount(spot: number, min: number): string | null {
  const cents = Math.floor(spot * 100);
  return cents > 0 && cents / 100 >= min ? String(cents / 100) : null;
}

/**
 * Margin that reaches the hedge account from outside (a transfer, or 1Click's route on mainnet)
 * can land in its Spot balance, where the short cannot use it. The vault signs a
 * `usdClassTransfer` of it into Perps (no destination, toward Perps only) and this submits it.
 */
async function marginSweep(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  const [r] = await sql<{ extra: { hedgeAddress?: string } }[]>`SELECT extra FROM reports WHERE kind = 'vault_report' ORDER BY run_id DESC LIMIT 1`;
  const address = r?.extra?.hedgeAddress;
  if (!address) return "no hedge address reported yet";
  const amount = sweepAmount(await spotUsdc(address), Number(process.env.MARGIN_SWEEP_MIN_USD ?? 1));
  if (!amount) return "no USDC in Spot";
  const o = await keeper.call({ receiverId: contract("vault"), methodName: "hedge_margin_to_perp", args: { amount }, tgas: 100 });
  const sig = returnValue<{ r: string; s: string; v: number } | null>(o);
  const ev = eventsOf(o).find((e) => e.event === "hedge_margin_to_perp");
  if (!sig || !ev) throw new Error(`the vault did not sign the margin transfer (${txHash(o)})`);
  const { nonce, digest } = ev.data as { nonce: number; digest: string };
  const res = await submitClassTransfer(amount, nonce, sig);
  await sql`INSERT INTO reports (kind, run_id, tx_hash, payload) VALUES ('margin_transfer', ${nonce}, ${txHash(o)},
    ${sql.json({ amount, nonce, digest, address, signature: sig, status: res.status, response: res } as never)}) ON CONFLICT DO NOTHING`;
  log.info("margin to perps", { amount, res, tx: txHash(o) });
  if (res.status !== "ok") throw new Error(`Hyperliquid refused the margin transfer: ${JSON.stringify(res.response ?? res).slice(0, 200)}`);
  return `moved ${amount} USDC from Spot to Perps in ${txHash(o)}`;
}

async function rebalance(sql: Sql): Promise<string> {
  if (!contract("vault")) return "no vault in this deployment";
  if (!keeper) throw new Error("KEEPER wallet is not configured");
  let o;
  try {
    o = await keeper.call({ receiverId: contract("vault"), methodName: "rebalance", args: {}, tgas: 150 });
  } catch (e) {
    // The vault refuses until the enclave's next report lands: that is waiting, not failing.
    if (/waits for a fresh report|no vault report/i.test(errorText(e))) return "waiting for a fresh vault report";
    throw e;
  }
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
  let o;
  try {
    o = await keeper.call({ receiverId: contract("vault"), methodName: "process_withdrawals", args: { max: 4 }, tgas: 300 });
  } catch (e) {
    // Withdrawals settle against a report taken after the request: that is waiting, not failing.
    if (/withdrawals wait for a fresh report/i.test(errorText(e))) return `${state.queue_length} queued, waiting for a fresh vault report`;
    throw e;
  }
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
  every(intEnv("FEED_MS", 30_000), "feed", track("feed", feed));
  every(intEnv("SEALING_KEY_MS", 6 * 3_600_000), "sealing-key", track("sealing-key", sealingKey), intEnv("SEALING_KEY_RETRY_MS", 600_000));
  every(intEnv("VAULT_REPORT_MS", 300_000), "vault-report", track("vault-report", () => vaultReport(sql)));
  every(intEnv("REBALANCE_MS", 120_000), "rebalance", track("rebalance", () => rebalance(sql)));
  every(intEnv("MARGIN_ROUTE_MS", 1_800_000), "margin-route", track("margin-route", () => marginRoute(sql)));
  every(intEnv("MARGIN_WATCH_MS", 120_000), "margin-watch", track("margin-watch", () => marginWatch(sql)));
  every(intEnv("MARGIN_SWEEP_MS", 300_000), "margin-sweep", track("margin-sweep", () => marginSweep(sql)));
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
