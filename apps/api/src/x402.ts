/**
 * Paid risk checks over x402 on NEAR (x402 v2, the `exact` scheme on NEAR). An agent pays per call
 * in test USDC by signing a NEP-366 delegate action (an `ft_transfer` to the API's account) and
 * sending it in `PAYMENT-SIGNATURE` (or the v1 `X-PAYMENT`). Before relaying it the API checks it
 * with @parryguard/sdk: the signature over the NEP-461 prefixed delegate, the exact asset, amount,
 * recipient and gas, and on chain that the key is the payer's full-access key, the nonce unused
 * and the delegate unexpired. It answers only after the transfer settled on chain, with
 * `PAYMENT-RESPONSE` (and the v1 `X-PAYMENT-RESPONSE`).
 */

import {
  checkDelegateOnChain,
  decodePaymentHeader,
  encodePaymentRequired,
  encodePaymentResponse,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  V1_PAYMENT_HEADER,
  V1_PAYMENT_RESPONSE_HEADER,
  verifyPayment,
  type ParsedDelegate,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentResponse,
} from "@parryguard/sdk";
import { contract, network, RPC_URLS } from "@parryguard/services/lib/config";
import type { Sql } from "@parryguard/services/lib/db";
import { Near } from "near-kit";
import type { Context } from "hono";

const PRICE = process.env.X402_PRICE ?? "10000"; // 0.01 test USDC
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:4500";
/** How long a payment's delegate may stay valid, in blocks (NEAR's exact scheme counts 1 s a block). */
const TIMEOUT_BLOCKS = 240;
const DESCRIPTION = "One Parry risk check of a NEAR account's lending position (score, tier, liquidation price, probability and time to liquidation).";
const reader = new Near({ network: { networkId: network, rpcUrl: RPC_URLS[0]! } });

export function requirement(): PaymentRequirements {
  return {
    scheme: "exact",
    network: `near:${network}`,
    asset: contract("usdc"),
    amount: PRICE,
    payTo: process.env.X402_PAY_TO ?? "",
    maxTimeoutSeconds: TIMEOUT_BLOCKS,
  };
}

export const requirements = (resource: string, error = "payment required"): PaymentRequired => ({
  x402Version: 2,
  error,
  resource: { url: resource, description: DESCRIPTION, mimeType: "application/json" },
  accepts: [requirement()],
});

const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const first = (v: string | undefined) => v?.split(",")[0]?.trim() || undefined;

/**
 * The public URL of the requested resource. Behind Caddy and Cloudflare the API itself sees plain
 * http on its own port, so the origin comes from `PUBLIC_API_URL` when set, else from the
 * proxy's X-Forwarded-Proto and X-Forwarded-Host, else from the request; path and query are the
 * request's.
 */
export function resourceUrl(requestUrl: string, header: (name: string) => string | undefined, publicUrl = process.env.PUBLIC_API_URL): string {
  const u = new URL(requestUrl);
  const path = `${u.pathname}${u.search}`;
  if (publicUrl) {
    try {
      const base = new URL(publicUrl);
      if (base.protocol === "https:" || base.protocol === "http:") return `${base.origin}${base.pathname.replace(/\/+$/, "")}${path}`;
    } catch {
      // not a URL: fall through to the proxy headers
    }
  }
  const proto = first(header("x-forwarded-proto"))?.toLowerCase();
  const host = first(header("x-forwarded-host")) ?? header("host");
  const scheme = proto === "https" || proto === "http" ? proto : u.protocol.slice(0, -1);
  return `${scheme}://${host && HOST.test(host) ? host : u.host}${path}`;
}

/** What the paid route needs from the outside world; tests replace them. */
export interface PaidDeps {
  checkOnChain: (d: ParsedDelegate) => ReturnType<typeof checkDelegateOnChain>;
  /** Relays the signed delegate and waits for the transfer: the transaction hash, or why not. */
  relay: (signedDelegateAction: string) => Promise<{ txHash?: string; error?: string }>;
  record: (p: { txHash: string; payer: string; amount: string; path: string }) => Promise<void>;
}

const defaultDeps = (sql: Sql): PaidDeps => ({
  checkOnChain: (d) => checkDelegateOnChain(reader, d),
  relay: async (signedDelegateAction) => {
    const res = await fetch(`${RELAYER}/delegate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: signedDelegateAction }) });
    const out = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
    return res.ok && out.txHash ? { txHash: out.txHash } : { error: out.error ?? String(res.status) };
  },
  record: async ({ txHash, payer, amount, path }) => {
    await sql`INSERT INTO payments (tx_hash, payer, amount, resource) VALUES (${txHash}, ${payer}, ${amount}, ${path}) ON CONFLICT DO NOTHING`;
  },
});

/** Delegates being settled right now: the same payment sent twice at once is relayed once. */
const settling = new Set<string>();

export async function paidRisk(c: Context, sql: Sql, compute: () => Promise<unknown>, deps: Partial<PaidDeps> = {}) {
  const { checkOnChain, relay, record } = { ...defaultDeps(sql), ...deps };
  const resource = resourceUrl(c.req.url, (name) => c.req.header(name));
  const req = requirement();
  const settlement = (r: PaymentResponse) => {
    const v = encodePaymentResponse(r);
    c.header(PAYMENT_RESPONSE_HEADER, v);
    c.header(V1_PAYMENT_RESPONSE_HEADER, v);
  };
  const refuse = (reason: string) => {
    const body = requirements(resource, reason);
    c.header(PAYMENT_REQUIRED_HEADER, encodePaymentRequired(body));
    return c.json(body, 402);
  };
  const header = c.req.header(PAYMENT_SIGNATURE_HEADER) ?? c.req.header(V1_PAYMENT_HEADER);
  if (!header) return refuse("payment required");
  let payment;
  try {
    payment = decodePaymentHeader(header);
  } catch (e) {
    return refuse((e as Error).message);
  }
  const local = verifyPayment(payment, req, { resource });
  if (!local.ok) return refuse(local.reason);
  const chain = await checkOnChain(local.delegate);
  if (!chain.ok) return refuse(chain.reason);
  const fresh = verifyPayment(payment, req, { resource, blockHeight: chain.blockHeight });
  if (!fresh.ok) return refuse(fresh.reason);
  const key = Buffer.from(local.delegate.hash).toString("hex");
  if (settling.has(key)) return refuse("duplicate_settlement: this payment is being settled");
  settling.add(key);
  let settled;
  try {
    settled = await relay(payment.payload.signedDelegateAction);
  } finally {
    settling.delete(key);
  }
  if (!settled.txHash) {
    const reason = `payment did not settle: ${settled.error ?? "no transaction"}`;
    settlement({ success: false, errorReason: reason, transaction: "", network: req.network });
    return refuse(reason);
  }
  await record({ txHash: settled.txHash, payer: local.delegate.senderId, amount: req.amount, path: c.req.path });
  const body = await compute();
  settlement({ success: true, transaction: settled.txHash, network: req.network, payer: local.delegate.senderId });
  return c.json(body);
}
