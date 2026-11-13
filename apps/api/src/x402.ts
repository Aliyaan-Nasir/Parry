/**
 * Paid risk checks over x402 on NEAR. An agent pays per call in test USDC by signing a NEP-366
 * delegate action (an `ft_transfer` to the API's account). Before relaying it the API checks it
 * with @parryguard/sdk: the signature over the NEP-461 prefixed delegate, the exact asset, amount,
 * recipient and gas, and on chain that the key is the payer's full-access key, the nonce unused
 * and the delegate unexpired. It answers only after the transfer settled on chain.
 */

import { checkDelegateOnChain, decodePaymentHeader, encodePaymentResponse, verifyPayment, type PaymentRequirements } from "@parryguard/sdk";
import { contract, network, RPC_URLS } from "@parryguard/services/lib/config";
import type { Sql } from "@parryguard/services/lib/db";
import { Near } from "near-kit";
import type { Context } from "hono";

const PRICE = process.env.X402_PRICE ?? "10000"; // 0.01 test USDC
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:4500";
const reader = new Near({ network: { networkId: network, rpcUrl: RPC_URLS[0]! } });

export function requirement(resource: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: `near:${network}`,
    asset: contract("usdc"),
    amount: PRICE,
    payTo: process.env.X402_PAY_TO ?? "",
    resource,
    description: "One Parry risk check of a NEAR account's lending position (score, tier, liquidation price, probability and time to liquidation).",
    maxTimeoutSeconds: 120,
  };
}

export const requirements = (resource: string) => ({ x402Version: 2, error: "payment required", accepts: [requirement(resource)] });

export async function paidRisk(c: Context, sql: Sql, compute: () => Promise<unknown>) {
  const req = requirement(c.req.url);
  const header = c.req.header("x-payment");
  if (!header) return c.json(requirements(c.req.url), 402);
  const refuse = (reason: string) => c.json({ ...requirements(c.req.url), error: reason }, 402);
  let payment;
  try {
    payment = decodePaymentHeader(header);
  } catch (e) {
    return refuse((e as Error).message);
  }
  const local = verifyPayment(payment, req);
  if (!local.ok) return refuse(local.reason);
  const chain = await checkDelegateOnChain(reader, local.delegate);
  if (!chain.ok) return refuse(chain.reason);
  const fresh = verifyPayment(payment, req, { blockHeight: chain.blockHeight });
  if (!fresh.ok) return refuse(fresh.reason);
  const res = await fetch(`${RELAYER}/delegate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payment.payload.signedDelegateAction }) });
  const settled = (await res.json()) as { txHash?: string; error?: string };
  if (!res.ok || !settled.txHash) return refuse(`payment did not settle: ${settled.error ?? res.status}`);
  await sql`INSERT INTO payments (tx_hash, payer, amount, resource) VALUES (${settled.txHash}, ${local.delegate.senderId}, ${req.amount}, ${c.req.path}) ON CONFLICT DO NOTHING`;
  const body = await compute();
  c.header("x-payment-response", encodePaymentResponse({ success: true, transaction: settled.txHash, network: req.network }));
  return c.json(body);
}
