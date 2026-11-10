// Links to the public explorers where every Parry action can be checked.

import { network } from "./env";

export type ExplorerKind = "nearblocks" | "hyperliquid" | "intents";

const NEARBLOCKS = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
const HYPERLIQUID = network === "mainnet" ? "https://app.hyperliquid.xyz/explorer" : "https://app.hyperliquid-testnet.xyz/explorer";

export const EXPLORERS: Record<ExplorerKind, { label: string; base: string }> = {
  nearblocks: { label: "NearBlocks", base: `${NEARBLOCKS}/txns/` },
  hyperliquid: { label: "Hyperliquid explorer", base: `${HYPERLIQUID}/tx/` },
  intents: { label: "NEAR Intents explorer", base: "https://explorer.near-intents.org/transactions/" },
};

/** Transaction hashes are base58 (NEAR) or 0x hex (Hyperliquid); anything else is refused. */
const HASH = /^(0x[0-9a-fA-F]{8,128}|[1-9A-HJ-NP-Za-km-z]{16,128})$/;

/** NEAR account ids: named (alice.testnet) or implicit and universal (64 hex, 0u...). */
const NEAR_ACCOUNT = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** EVM style addresses, as Hyperliquid uses. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isTxHash(hash: string): boolean {
  return HASH.test(hash);
}

export function explorerUrl(kind: ExplorerKind, hash: string): string | null {
  const h = hash.trim();
  if (!isTxHash(h)) return null;
  return `${EXPLORERS[kind].base}${encodeURIComponent(h)}`;
}

export function explorerLabel(kind: ExplorerKind): string {
  return EXPLORERS[kind].label;
}

/** A NEAR account on NearBlocks, or null when the id is not a NEAR account id. */
export function nearAccountUrl(accountId: string): string | null {
  const id = accountId.trim();
  if (!NEAR_ACCOUNT.test(id)) return null;
  return `${NEARBLOCKS}/address/${encodeURIComponent(id)}`;
}

/** An address on the Hyperliquid explorer, or null when it is not a 0x address. */
export function hyperliquidAddressUrl(address: string): string | null {
  const a = address.trim();
  if (!EVM_ADDRESS.test(a)) return null;
  return `${HYPERLIQUID}/address/${a}`;
}
