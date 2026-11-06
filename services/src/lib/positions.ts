/**
 * Reading positions where they live: Rhea lending (views), Hyperliquid (info API) at the
 * account's Chain Signatures address, and Aave on an EVM chain at its EVM address.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LendingPosition } from "@parry/core";
import { contract, EVM_RPC_URL, NEAR_USD, USDC_USD } from "./config";
import { clearinghouse } from "./hyperliquid";
import { view } from "./near";

export const PATH_HYPERLIQUID = "parry-hyperliquid";
export const PATH_EVM = "parry-evm";
export const PATH_VAULT = "parry-vault-hedge";

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BS58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const derivedCache = new Map<string, string>();

/** The EVM-style address Chain Signatures derives for `predecessor` at `path` (domain 0). */
export async function derivedAddress(predecessor: string, path: string): Promise<string> {
  const key = `${predecessor}|${path}`;
  const hit = derivedCache.get(key);
  if (hit) return hit;
  const pk = await view<string>(contract("signer"), "derived_public_key", { path, predecessor, domain_id: 0 });
  const raw = bs58decode(pk.replace(/^secp256k1:/, ""));
  const point = raw.length === 65 ? raw.slice(1) : raw;
  if (point.length !== 64) throw new Error("derived key is not an uncompressed secp256k1 point");
  const address = `0x${bytesToHex(keccak_256(point).slice(12))}`;
  derivedCache.set(key, address);
  return address;
}

interface AssetConfig {
  volatilityRatio: number;
}
const assetCache = new Map<string, { at: number; v: AssetConfig }>();

async function assetConfig(token: string): Promise<AssetConfig> {
  const hit = assetCache.get(token);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  const a = await view<{ config: { volatility_ratio: number } } | null>(contract("lending"), "get_asset", { token_id: token });
  const v = { volatilityRatio: (a?.config.volatility_ratio ?? 0) / 10_000 };
  assetCache.set(token, { at: Date.now(), v });
  return v;
}

/** NEAR/USD and USDC/USD from the lending oracle (null when stale or missing). */
export async function oraclePrices(maxAge = 300): Promise<{ near: number | null; usdc: number }> {
  const read = async (id: string) => {
    const p = await view<{ price: string; expo: number } | null>(contract("oracle"), "get_price_no_older_than", { price_id: id, age: maxAge }).catch(() => null);
    return p ? Number(p.price) * 10 ** p.expo : null;
  };
  const [near, usdc] = await Promise.all([read(NEAR_USD), read(USDC_USD)]);
  return { near, usdc: usdc ?? 1 };
}

export interface RheaRead {
  position: LendingPosition;
  collateralNear: number;
  debtUsd: number;
  collateralUsd: number;
}

/** An account's Rhea position (wNEAR collateral against USDC debt), or null if it has none. */
export async function readRhea(account: string, nearPrice: number): Promise<RheaRead | null> {
  type Line = { token_id: string; balance: string };
  const v = await view<{ collateral?: Line[]; borrowed?: Line[] } | null>(contract("lending"), "get_account", { account_id: account });
  if (!v) return null;
  const wnear = contract("wnear");
  const usdc = contract("usdc");
  const sum = (lines: Line[] | undefined, token: string, decimals: number) =>
    (lines ?? []).filter((l) => l.token_id === token).reduce((s, l) => s + Number(BigInt(l.balance) / 10n ** BigInt(decimals - 6)) / 1e6, 0);
  const collateralNear = sum(v.collateral, wnear, 24);
  const debtUsd = sum(v.borrowed, usdc, 18);
  if (collateralNear === 0 && debtUsd === 0) return null;
  const [near, usd] = await Promise.all([assetConfig(wnear), assetConfig(usdc)]);
  return {
    position: {
      collateral: [{ symbol: "wNEAR", amount: collateralNear, priceUsd: nearPrice, volatilityRatio: near.volatilityRatio, driver: true }],
      debt: [{ symbol: "USDC", amount: debtUsd, priceUsd: 1, volatilityRatio: usd.volatilityRatio, driver: false }],
    },
    collateralNear,
    debtUsd,
    collateralUsd: collateralNear * nearPrice,
  };
}

export async function readHyperliquid(account: string) {
  const address = await derivedAddress(account, PATH_HYPERLIQUID);
  const s = await clearinghouse(address, "NEAR");
  return { address, ...s };
}

/** Aave v3 `getUserAccountData` (USD values with 8 decimals, health with 18). */
export async function readAave(pool: string, user: string): Promise<{ collateralUsd: number; debtUsd: number; health: number } | null> {
  const data = `0xbf92857c${user.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const res = await fetch(EVM_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: pool, data }, "latest"] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: string };
  if (!body.result || body.result.length < 2 + 64 * 6) return null;
  const word = (i: number) => BigInt(`0x${body.result!.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  const debt = Number(word(1)) / 1e8;
  return { collateralUsd: Number(word(0)) / 1e8, debtUsd: debt, health: debt === 0 ? Infinity : Number(word(5) / 10n ** 12n) / 1e6 };
}
