/** Hyperliquid's public API: reads, and submitting orders and margin transfers signed by Chain Signatures. */

import { HYPERLIQUID_URL, network } from "./config";

export async function info<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HYPERLIQUID_URL}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`hyperliquid info ${res.status}`);
  return (await res.json()) as T;
}

export async function mid(coin = "NEAR"): Promise<number | null> {
  const mids = await info<Record<string, string>>({ type: "allMids" });
  const v = Number(mids[coin]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export interface PerpPosition {
  size: number;
  entry: number;
  liquidation: number | null;
  unrealized: number;
  marginUsed: number;
}

export async function clearinghouse(address: string, coin = "NEAR"): Promise<{ accountValue: number; perp: PerpPosition | null }> {
  type State = { marginSummary: { accountValue: string }; assetPositions: { position: { coin: string; szi: string; entryPx: string; liquidationPx: string | null; unrealizedPnl: string; marginUsed: string } }[] };
  const s = await info<State>({ type: "clearinghouseState", user: address });
  const p = s.assetPositions.find((a) => a.position.coin === coin)?.position;
  return {
    accountValue: Number(s.marginSummary.accountValue),
    perp: p
      ? { size: Number(p.szi), entry: Number(p.entryPx), liquidation: p.liquidationPx ? Number(p.liquidationPx) : null, unrealized: Number(p.unrealizedPnl), marginUsed: Number(p.marginUsed) }
      : null,
  };
}

/** 5-minute closes over the last `hours`. */
export async function candles(coin: string, hours: number): Promise<{ t: number; price: number }[]> {
  const end = Date.now();
  const rows = await info<{ T: number; c: string }[]>({ type: "candleSnapshot", req: { coin, interval: "5m", startTime: end - hours * 3_600_000, endTime: end } });
  return rows.map((r) => ({ t: Math.floor(r.T / 1000), price: Number(r.c) }));
}

export interface HlOrder {
  asset_index: number;
  is_buy: boolean;
  price: string;
  size: string;
  reduce_only: boolean;
  tif: string;
}

/**
 * Submits an order whose agent digest a NEAR contract had Chain Signatures sign. The action is
 * the same object the contract encoded (key order matters to Hyperliquid's hash).
 */
export async function submitOrder(order: HlOrder, nonce: number, sig: { r: string; s: string; v: number }): Promise<{ status: string; response?: unknown }> {
  const action = {
    type: "order",
    orders: [{ a: order.asset_index, b: order.is_buy, p: order.price, s: order.size, r: order.reduce_only, t: { limit: { tif: order.tif } } }],
    grouping: "na",
  };
  const body = { action, nonce, signature: { r: `0x${sig.r}`, s: `0x${sig.s}`, v: sig.v }, vaultAddress: null };
  const res = await fetch(`${HYPERLIQUID_URL}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return (await res.json()) as { status: string; response?: unknown };
}

/** USDC `address` holds in its Spot balance and can move (total minus holds). */
export async function spotUsdc(address: string): Promise<number> {
  const s = await info<{ balances: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: address });
  const b = s.balances.find((x) => x.coin === "USDC");
  return b ? Math.max(0, Number(b.total) - Number(b.hold)) : 0;
}

/**
 * The `/exchange` body for a Spot-to-Perps `usdClassTransfer` whose EIP-712 digest a NEAR contract
 * had Chain Signatures sign: the same fields the contract hashed, and the Arbitrum chain id it
 * signed under.
 */
export function classTransferBody(amount: string, nonce: number, sig: { r: string; s: string; v: number }, mainnet = network === "mainnet") {
  const action = { type: "usdClassTransfer", hyperliquidChain: mainnet ? "Mainnet" : "Testnet", signatureChainId: mainnet ? "0xa4b1" : "0x66eee", amount, toPerp: true, nonce };
  return { action, nonce, signature: { r: `0x${sig.r}`, s: `0x${sig.s}`, v: sig.v } };
}

export async function submitClassTransfer(amount: string, nonce: number, sig: { r: string; s: string; v: number }): Promise<{ status: string; response?: unknown }> {
  const res = await fetch(`${HYPERLIQUID_URL}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(classTransferBody(amount, nonce, sig)), signal: AbortSignal.timeout(15_000) });
  return (await res.json()) as { status: string; response?: unknown };
}
