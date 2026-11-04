// Links to the public explorers where every Parry action can be checked.

export type ExplorerKind = "nearblocks" | "hyperliquid" | "intents";

export const EXPLORERS: Record<ExplorerKind, { label: string; base: string }> = {
  nearblocks: { label: "NearBlocks", base: "https://testnet.nearblocks.io/txns/" },
  hyperliquid: { label: "Hyperliquid explorer", base: "https://app.hyperliquid-testnet.xyz/explorer/tx/" },
  intents: { label: "NEAR Intents explorer", base: "https://explorer.near-intents.org/transactions/" },
};

/** Transaction hashes are base58 (NEAR) or 0x hex (Hyperliquid); anything else is refused. */
const HASH = /^(0x[0-9a-fA-F]{8,128}|[1-9A-HJ-NP-Za-km-z]{16,128})$/;

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
