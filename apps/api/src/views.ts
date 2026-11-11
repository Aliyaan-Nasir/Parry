/** Database rows and chain views shaped as the API types in docs/api.md. */

import { contract, network } from "@parry/services/lib/config";
import { view } from "@parry/services/lib/near";
import type { Sql } from "@parry/services/lib/db";

export type Tier = "safe" | "caution" | "danger" | "critical";

export interface PositionRow {
  id: string;
  account: string;
  venue: string;
  label: string;
  collateral_usd: number;
  debt_usd: number;
  health: number | null;
  liq_price: number | null;
  distance: number;
  score: number;
  tier: Tier;
  p24: number;
  ttl_hours: number | null;
  var99: number;
  read_at: Date;
  scored_at: Date | null;
}

export const position = (r: PositionRow) => ({
  id: r.id,
  account: r.account,
  venue: r.venue,
  label: r.label,
  collateralUsd: r.collateral_usd,
  debtUsd: r.debt_usd,
  health: r.health,
  liqPrice: r.liq_price,
  distance: r.distance,
  score: r.score,
  tier: r.tier,
  probability24h: r.p24,
  ttlHours: r.ttl_hours,
  valueAtRisk99: r.var99,
  updatedAt: (r.scored_at ?? r.read_at).toISOString(),
});

export interface DecisionRow {
  id: string;
  account: string;
  venue: string;
  action: string;
  plan: string;
  trigger: { score: number; tier: Tier; health_bps: number };
  outcome: string;
  review: Record<string, string>;
  envelope: string | null;
  envelope_signature: string | null;
  txs: Record<string, string | null>;
  health_before: number | null;
  health_after: number | null;
  routes: unknown;
  detail: string | null;
  explanation?: { step: string; why: string; skipped: { step: string; reason: string }[] } | null;
  created_at: Date;
}

export const decision = (r: DecisionRow) => ({
  id: r.id,
  account: r.account,
  venue: r.venue,
  action: r.action,
  plan: r.plan,
  trigger: { score: r.trigger.score, tier: r.trigger.tier, healthBps: r.trigger.health_bps },
  outcome: r.outcome,
  detail: r.detail,
  review: {
    model: r.review.model,
    chatId: r.review.chat_id,
    reviewHash: r.review.review_hash ?? "",
    requestHash: r.review.request_hash,
    responseHash: r.review.response_hash,
    verdict: r.review.verdict,
    reasoning: r.review.reasoning,
    signingAddress: r.review.signing_address,
    signedText: r.review.signed_text,
    signature: r.review.signature,
    signatureKind: r.review.signature_kind,
  },
  envelope: r.envelope,
  envelopeSignature: r.envelope_signature,
  txs: {
    action: r.txs.action ?? null,
    record: r.txs.record ?? null,
    hyperliquid: r.txs.hyperliquid ?? null,
    evm: r.txs.evm ?? null,
    evmVerify: r.txs.evm_verify ?? null,
    evmVerified: r.txs.evm_verified ?? null,
  },
  healthBefore: r.health_before,
  healthAfter: r.health_after,
  routes: r.routes,
  explanation: r.explanation ?? null,
  createdAt: r.created_at.toISOString(),
});

/** Short-lived cache for chain views many requests share. */
const cache = new Map<string, { at: number; value: unknown }>();
export async function cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await read();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export interface VaultStateView {
  network: string;
  paused: boolean;
  risk_score: number;
  report_at: number;
  staked_linear: string;
  linear_rate_e24: string;
  near_price_e8: string;
  nav_e6: string;
  share_price_e6: string;
  total_shares: string;
  queued_shares: string;
  hedge: Record<string, string | number | boolean>;
  reserves: { root: string; leaves: number; total_usd_e6: string; liabilities_usd_e6: string; ratio_bps: number } | null;
  deposit_cap: string;
  min_deposit: string;
  queue_length: number;
}

export async function vaultState(sql: Sql) {
  const v = await cached("vault_state", 10_000, () => view<VaultStateView>(contract("vault"), "vault_state"));
  const y = await cached("yield", 60_000, () => view<{ staking_rate_growth_bps: number; funding_e6: string; hedge_pnl_e6: string }>(contract("vault"), "yield_breakdown").catch(() => null));
  const [first] = await sql<{ t: Date }[]>`SELECT min(t) AS t FROM vault_history`;
  const days = first?.t ? Math.max(1 / 24, (Date.now() - first.t.getTime()) / 86_400_000) : 0;
  const h = v.hedge;
  const n = (x: unknown) => Number(x ?? 0);
  const [hedgeAddress] = await sql<{ extra: { hedgeAddress?: string } }[]>`SELECT extra FROM reports WHERE kind = 'vault_report' ORDER BY run_id DESC LIMIT 1`;
  const [margin] = await sql<{ payload: { amountUsd: number; quote: { outUsd?: number; unavailable?: string } }; created_at: Date }[]>`
    SELECT payload, created_at FROM reports WHERE kind = 'margin_route' ORDER BY run_id DESC LIMIT 1`;
  const [order] = await sql<{ tx_hash: string; payload: { order: { is_buy: boolean; size: string; price: string }; status: string }; created_at: Date }[]>`
    SELECT tx_hash, payload, created_at FROM reports WHERE kind = 'hedge_order' ORDER BY run_id DESC LIMIT 1`;
  return {
    network,
    paused: v.paused,
    riskScore: v.risk_score,
    reportAt: v.report_at ? new Date(v.report_at * 1000).toISOString() : null,
    sharePriceUsd: n(v.share_price_e6) / 1e6,
    navUsd: n(v.nav_e6) / 1e6,
    totalShares: v.total_shares,
    queuedShares: v.queued_shares,
    stakedLinear: v.staked_linear,
    linearRate: n(v.linear_rate_e24) / 1e24,
    nearPriceUsd: n(v.near_price_e8) / 1e8,
    hedge: {
      targetNear: n(h.target_e8) / 1e8,
      currentNear: n(h.current_e8) / 1e8,
      entry: n(h.entry_e8) / 1e8,
      mark: n(h.mark_e8) / 1e8,
      liquidation: n(h.liquidation_e8) / 1e8,
      leverage: n(h.leverage_x100) / 100,
      maxLeverage: n(h.effective_max_leverage_x100) / 100,
      hedgeRatio: n(h.hedge_ratio_bps) / 10_000,
      needsMargin: !!h.needs_margin,
      accountValueUsd: n(h.account_value_e6) / 1e6,
      fundingUsd: n(h.funding_e6) / 1e6,
      address: hedgeAddress?.extra?.hedgeAddress ?? null,
      lastOrder: order
        ? { tx: order.tx_hash, side: order.payload.order.is_buy ? "buy" : "sell", size: order.payload.order.size, price: order.payload.order.price, status: order.payload.status, at: order.created_at.toISOString() }
        : null,
      marginRoute: margin ? { amountUsd: margin.payload.amountUsd, outUsd: margin.payload.quote.outUsd ?? null, unavailable: margin.payload.quote.unavailable ?? null, at: margin.created_at.toISOString() } : null,
    },
    yield: {
      stakingApr: y && days > 0 ? (y.staking_rate_growth_bps / 10_000) * (365 / days) : null,
      fundingUsd: y ? n(y.funding_e6) / 1e6 : 0,
      hedgePnlUsd: y ? n(y.hedge_pnl_e6) / 1e6 : 0,
    },
    reserves: v.reserves
      ? { root: v.reserves.root, leaves: v.reserves.leaves, totalUsd: n(v.reserves.total_usd_e6) / 1e6, liabilitiesUsd: n(v.reserves.liabilities_usd_e6) / 1e6, ratioBps: v.reserves.ratio_bps }
      : null,
    depositCapNear: v.deposit_cap,
    minDepositNear: v.min_deposit,
    queueLength: v.queue_length,
  };
}
