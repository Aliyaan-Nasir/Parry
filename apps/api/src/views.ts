/** Database rows and chain views shaped as the API types in docs/api.md. */

import { contract, network } from "@parryguard/services/lib/config";
import { view } from "@parryguard/services/lib/near";
import { oraclePrices } from "@parryguard/services/lib/positions";
import type { Sql } from "@parryguard/services/lib/db";
import { isPublicPlan, publicPlan } from "@parryguard/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { reviewHash } from "./verify";

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
  /** The owner's full plan: projected health, the sealed target and why this step. */
  plan: string;
  /** The action alone (null for decisions stored before the guardian kept it). */
  public_plan?: string | null;
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
  /** What the review model saw, the sealed target and trigger among them. */
  facts?: Record<string, unknown> | null;
  /** The enclave-signed risk-board record and its signature (base64). */
  decision_json?: string | null;
  decision_signature?: string | null;
  created_at: Date;
}

/** The public plan of a stored decision: the enclave's own, else its full plan redacted. */
export const decisionPublicPlan = (r: Pick<DecisionRow, "plan" | "public_plan" | "action">): string =>
  isPublicPlan(r.public_plan) ? r.public_plan : publicPlan(r.plan, r.action);

/**
 * The enclave-signed record when it is public: the record a build before the public plan signed
 * carries the owner's full plan, so it goes only to the owner (the risk board holds it, and
 * `/v1/guardian/decisions/:id/verify` checks it for everyone).
 */
function publicRecord(r: DecisionRow): string | null {
  if (!r.decision_json) return null;
  try {
    const plan = (JSON.parse(r.decision_json) as { plan?: unknown }).plan;
    return typeof plan === "string" && isPublicPlan(plan) ? r.decision_json : null;
  } catch {
    return null;
  }
}

/** SHA-256 (hex) of the review's reasoning: the `reasoning_hash` the risk board records. */
const reasoningHash = (text: string | undefined) => (typeof text === "string" ? bytesToHex(sha256(utf8ToBytes(text))) : null);

/**
 * A decision as the API serves it. `owner` is true only for a request signed in as the
 * decision's own account: it gets the full record (plan, reasons, the review's reasoning, the
 * facts). Everyone else gets what public verification needs and nothing of the sealed policy.
 */
export const decision = (r: DecisionRow, opts: { owner?: boolean } = {}) => {
  const owner = opts.owner === true;
  const shown = decisionPublicPlan(r);
  const record = owner ? (r.decision_json ?? null) : publicRecord(r);
  return {
    id: r.id,
    account: r.account,
    venue: r.venue,
    action: r.action,
    /** The full plan for the owner, the public plan for everyone else. */
    plan: owner ? r.plan : shown,
    publicPlan: shown,
    /** "owner": the full record; "public": what anyone may see. */
    visibility: owner ? ("owner" as const) : ("public" as const),
    trigger: { score: r.trigger.score, tier: r.trigger.tier, healthBps: r.trigger.health_bps },
    outcome: r.outcome,
    detail: r.detail,
    review: {
      model: r.review.model,
      chatId: r.review.chat_id,
      // Decisions stored before the guardian kept the hash with the review: recompute it.
      reviewHash: r.review.review_hash || (r.review.signed_text ? reviewHash(r.review as unknown as Record<string, string>) : ""),
      requestHash: r.review.request_hash,
      responseHash: r.review.response_hash,
      verdict: r.review.verdict,
      ...(owner ? { reasoning: r.review.reasoning } : {}),
      reasoningHash: reasoningHash(r.review.reasoning),
      signingAddress: r.review.signing_address,
      signedText: r.review.signed_text,
      signature: r.review.signature,
      signatureKind: r.review.signature_kind,
    },
    envelope: r.envelope,
    envelopeSignature: r.envelope_signature,
    decisionJson: record,
    decisionSignature: record ? (r.decision_signature ?? null) : null,
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
    explanation: owner ? (r.explanation ?? null) : null,
    ...(owner ? { facts: r.facts ?? null } : {}),
    createdAt: r.created_at.toISOString(),
  };
};

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
  manual_paused?: boolean;
  risk_paused?: boolean;
  risk_score: number;
  report_at: number;
  pending_deposit_near?: string;
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

/** The vault contract's limits on deposits (contracts/vault/src/lib.rs). */
export const VAULT_REPORT_MAX_AGE_SECS = 900;
export const VAULT_ORACLE_MAX_DEVIATION_BPS = 200;

export interface DepositStatus {
  /** Whether the vault would take a deposit of at least the minimum now. */
  depositsOpen: boolean;
  /** Why not, in words, with when it reopens; null while open. */
  depositsClosedReason: string | null;
  /** Which check refuses: paused, risk, no_report, stale_report, cap, no_price, price_off_mark. */
  depositsClosedBy: "paused" | "risk" | "no_report" | "stale_report" | "cap" | "no_price" | "price_off_mark" | null;
  /** Seconds since the vault's latest report (the contract refuses deposits past 900). */
  reportAgeSeconds: number | null;
  /** yoctoNEAR the cap still takes. */
  depositRoomNear: string;
}

const minutes = (secs: number) => (secs < 90 ? `${Math.round(secs)} s` : secs < 5400 ? `${Math.round(secs / 60)} min` : `${(secs / 3600).toFixed(1)} h`);

/**
 * Whether the vault takes deposits now, checked exactly as `check_deposit` and the pricing
 * callback do in contracts/vault/src/deposit.rs, in their order: the owner's pause, the risk
 * pause, the minimum (a deposit at the minimum), a report at most 15 minutes old, room under the
 * cap (staked NEAR, LiNEAR valued up, plus pending deposits), then a fresh oracle price within 2%
 * of the report's hedge mark. `oracleE8` is the oracle's NEAR price no older than 120 s (null
 * when it has none; undefined when it was not read, which skips the price checks).
 */
export function depositStatus(v: VaultStateView, nowSecs: number, oracleE8?: number | null): DepositStatus {
  const age = v.report_at ? Math.max(0, nowSecs - v.report_at) : null;
  const rate = BigInt(v.linear_rate_e24 || "0");
  const staked = (BigInt(v.staked_linear || "0") * rate + 10n ** 24n - 1n) / 10n ** 24n;
  const used = staked + BigInt(v.pending_deposit_near ?? "0");
  const cap = BigInt(v.deposit_cap || "0");
  const room = cap > used ? cap - used : 0n;
  const closed = (by: NonNullable<DepositStatus["depositsClosedBy"]>, reason: string): DepositStatus => ({ depositsOpen: false, depositsClosedReason: reason, depositsClosedBy: by, reportAgeSeconds: age, depositRoomNear: room.toString() });
  const manual = v.manual_paused ?? (v.paused && !v.risk_paused);
  if (manual) return closed("paused", "the vault's owner paused deposits");
  if (v.risk_paused ?? v.paused) return closed("risk", `deposits are paused while the vault's risk score is high (${v.risk_score}); they reopen once a report scores it lower`);
  if (age === null) return closed("no_report", "the vault has no report yet; deposits open with the first one");
  if (age > VAULT_REPORT_MAX_AGE_SECS) return closed("stale_report", `the vault's report is ${minutes(age)} old (the contract takes deposits only within 15 min of one); deposits reopen with the next report`);
  if (room < BigInt(v.min_deposit || "0")) return closed("cap", "the deposit cap is reached; deposits reopen when withdrawals free room or the cap is raised");
  if (oracleE8 === null) return closed("no_price", "the NEAR oracle has no price from the last 2 minutes; deposits reopen with the next price");
  const mark = Number(v.hedge.mark_e8 ?? 0);
  if (oracleE8 !== undefined && mark > 0 && (Math.abs(oracleE8 - mark) / mark) * 10_000 > VAULT_ORACLE_MAX_DEVIATION_BPS) {
    return closed("price_off_mark", `the oracle price is ${((Math.abs(oracleE8 - mark) / mark) * 100).toFixed(1)}% from the hedge mark (over 2%); deposits reopen once they agree, by the next report at the latest`);
  }
  return { depositsOpen: true, depositsClosedReason: null, depositsClosedBy: null, reportAgeSeconds: age, depositRoomNear: room.toString() };
}

export async function vaultState(sql: Sql) {
  const v = await cached("vault_state", 10_000, () => view<VaultStateView>(contract("vault"), "vault_state"));
  // The oracle price the deposit would be priced at (the contract takes one at most 120 s old).
  const oracle = await cached("vault-oracle", 10_000, () => oraclePrices(120).then((p) => (p.near === null ? null : Math.round(p.near * 1e8)), () => undefined));
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
  const deposits = depositStatus(v, Date.now() / 1000, oracle);
  return {
    network,
    /** The contract's pause flag (owner or risk pause); `depositsOpen` is every condition a deposit needs. */
    paused: v.paused,
    ...deposits,
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
