/**
 * Hyperliquid for a protected account. The account signs through Chain Signatures (`hl_order`,
 * `hl_margin_to_perp`) and returns `{ r, s, v }`; Hyperliquid only acts once that signature is sent
 * to its `/exchange` endpoint together with the exact action the account hashed. These helpers
 * build those bodies, send them, and read the account's balances.
 */

import type { FetchLike } from "./api.js";
import type { OwnerAction } from "./owner.js";
import type { Network } from "./networks.js";
import type { HlOrder } from "./types.js";

/** Hyperliquid's API per network. */
export const HYPERLIQUID_API: Readonly<Record<Network, string>> = {
  testnet: "https://api.hyperliquid-testnet.xyz",
  mainnet: "https://api.hyperliquid.xyz",
};

/** A Chain Signatures signature as the account returns it: hex r and s (no prefix), v 27 or 28. */
export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

/** Hyperliquid's answer to an `/exchange` request. */
export interface HyperliquidAnswer {
  status: string;
  response?: unknown;
}

function asSignature(sig: unknown): HyperliquidSignature {
  const s = sig as Partial<HyperliquidSignature> | null;
  if (!s || typeof s.r !== "string" || typeof s.s !== "string" || (s.v !== 27 && s.v !== 28)) throw new Error("the account returned no signature");
  return { r: s.r, s: s.s, v: s.v };
}

const hex = (h: string) => `0x${h.replace(/^0x/, "")}`;

/** The `/exchange` body for an order the account signed (`hl_order`): the same object it hashed, key order included. */
export function hyperliquidOrderBody(order: HlOrder, nonce: number, sig: unknown) {
  const { r, s, v } = asSignature(sig);
  const action = {
    type: "order",
    orders: [{ a: order.asset_index, b: order.is_buy, p: order.price, s: order.size, r: order.reduce_only, t: { limit: { tif: order.tif } } }],
    grouping: "na",
  };
  return { action, nonce, signature: { r: hex(r), s: hex(s), v }, vaultAddress: null };
}

/**
 * The `/exchange` body for a Spot-to-Perps `usdClassTransfer` the account signed
 * (`hl_margin_to_perp`): the fields it hashed and the Arbitrum chain id it signed under.
 */
export function hyperliquidMarginBody(amount: string, nonce: number, sig: unknown, network: Network) {
  const { r, s, v } = asSignature(sig);
  const mainnet = network === "mainnet";
  const action = { type: "usdClassTransfer", hyperliquidChain: mainnet ? "Mainnet" : "Testnet", signatureChainId: mainnet ? "0xa4b1" : "0x66eee", amount, toPerp: true, nonce };
  return { action, nonce, signature: { r: hex(r), s: hex(s), v } };
}

/** The `/exchange` body for what a signing owner action (`hl_order` or `hl_margin_to_perp`) returned. */
export function hyperliquidBody(action: OwnerAction, sig: unknown, network: Network) {
  if (typeof action === "object" && "hl_order" in action) return hyperliquidOrderBody(action.hl_order.order, action.hl_order.nonce, sig);
  if (typeof action === "object" && "hl_margin_to_perp" in action) return hyperliquidMarginBody(action.hl_margin_to_perp.amount, action.hl_margin_to_perp.nonce, sig, network);
  throw new Error("only hl_order and hl_margin_to_perp are Hyperliquid actions");
}

/**
 * Sends a signed body to Hyperliquid. Hyperliquid answers HTTP 200 with `status: "ok"` even when
 * it rejects an order, so this throws on the transport and on `status: "err"`, and
 * `hyperliquidError` reads an order's own rejection.
 */
export async function submitHyperliquid(body: unknown, network: Network, opts: { fetch?: FetchLike; url?: string } = {}): Promise<HyperliquidAnswer> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.url ?? HYPERLIQUID_API[network]}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let answer: HyperliquidAnswer;
  try {
    answer = JSON.parse(text) as HyperliquidAnswer;
  } catch {
    throw new Error(`Hyperliquid answered ${res.status}: ${text.slice(0, 200)}`);
  }
  if (answer.status !== "ok") throw new Error(`Hyperliquid refused it: ${typeof answer.response === "string" ? answer.response : JSON.stringify(answer.response)}`);
  return answer;
}

/** The rejection inside an accepted order request (`{ statuses: [{ error }] }`), or null when it rested or filled. */
export function hyperliquidError(answer: HyperliquidAnswer): string | null {
  const statuses = (answer.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses ?? [];
  const failed = statuses.find((x): x is { error: string } => typeof (x as { error?: unknown })?.error === "string");
  return failed ? failed.error : null;
}

/** An address's Perps account value and the Spot USDC it can move (total less holds). */
export async function hyperliquidBalances(address: string, network: Network, opts: { fetch?: FetchLike; url?: string } = {}): Promise<{ perps: number; spotUsdc: number }> {
  const f = opts.fetch ?? fetch;
  const post = async <T>(body: unknown): Promise<T> => {
    const res = await f(`${opts.url ?? HYPERLIQUID_API[network]}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
    return (await res.json()) as T;
  };
  const [perps, spot] = await Promise.all([
    post<{ marginSummary?: { accountValue?: string } }>({ type: "clearinghouseState", user: address }),
    post<{ balances?: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: address }),
  ]);
  const usdc = spot.balances?.find((b) => b.coin === "USDC");
  return { perps: Number(perps.marginSummary?.accountValue ?? 0), spotUsdc: usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0 };
}

/**
 * The Spot USDC worth moving, as the decimal string `hl_margin_to_perp` takes: whole cents,
 * rounded down so it never asks for more than the balance; null under `min`.
 */
export function marginAmount(spotUsdc: number, min = 0.01): string | null {
  const cents = Math.floor(spotUsdc * 100 + 1e-6);
  if (!(cents > 0) || cents / 100 < min) return null;
  return String(cents / 100);
}
