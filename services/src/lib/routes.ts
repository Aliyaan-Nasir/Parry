/**
 * The route comparison every rescue swap carries: the Rhea pool the account swaps on (a view of
 * the exchange) against a NEAR Intents 1Click quote with `dry: true` (solvers compete on price,
 * and with `confidentiality` the route stays private). NEAR Intents has no testnet, so on
 * testnet the Intents side is a mainnet dry-run quote for the same NEAR amount, shown for
 * comparison only; on mainnet it is the route a confidential rescue would take.
 */

import { contract, dexPool, network } from "./config";
import { view } from "./near";
import { oraclePrices } from "./positions";

export interface RouteComparison {
  amountNear: number;
  rhea: { outUsd: number; priceImpact: number; poolId: number } | null;
  intents: { outUsd: number; confidential: boolean; dry: true } | { unavailable: string };
  chosen: "rhea" | "intents";
}

const ONECLICK = process.env.ONECLICK_URL ?? "https://1click.chaindefuser.com";
const MAINNET_WNEAR = "nep141:wrap.near";
const MAINNET_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export async function intentsQuote(amountNear: number): Promise<RouteComparison["intents"]> {
  const jwt = process.env.ONECLICK_JWT;
  const recipient = process.env.ONECLICK_RECIPIENT ?? "intents.near";
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: MAINNET_WNEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: MAINNET_USDC,
    amount: (BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n).toString(),
    refundTo: recipient,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    // Confidential quotes need a partner key; without one the quote is public.
    ...(jwt ? { confidentiality: "basic" } : {}),
  };
  try {
    const res = await fetch(`${ONECLICK}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const q = (await res.json()) as { quote?: { amountOut?: string }; message?: string };
    if (!res.ok || !q.quote?.amountOut) return { unavailable: `1Click: ${q.message ?? res.status}` };
    return { outUsd: Number(q.quote.amountOut) / 1e6, confidential: !!jwt, dry: true };
  } catch (e) {
    return { unavailable: `1Click unreachable: ${(e as Error).message}` };
  }
}

export async function rheaQuote(amountNear: number): Promise<RouteComparison["rhea"]> {
  const pool = dexPool();
  if (!Number.isInteger(pool) || pool < 0) return null;
  try {
    const out = await view<string>(contract("dex"), "get_return", {
      pool_id: pool,
      token_in: contract("wnear"),
      amount_in: (BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n).toString(),
      token_out: contract("usdc"),
    });
    const outUsd = Number(out) / 1e6;
    const { near } = await oraclePrices();
    return { outUsd, priceImpact: near ? Math.max(0, 1 - outUsd / (amountNear * near)) : 0, poolId: pool };
  } catch {
    return null;
  }
}

export async function quoteRescue(amountNear: number): Promise<RouteComparison> {
  const [rhea, intents] = await Promise.all([rheaQuote(amountNear), intentsQuote(amountNear)]);
  // On testnet the account can only settle on the Rhea pool; on mainnet the better quote wins.
  const chosen = network === "testnet" || !("outUsd" in intents) || (rhea && rhea.outUsd >= intents.outUsd) ? "rhea" : "intents";
  return { amountNear, rhea, intents, chosen };
}
