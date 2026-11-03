/**
 * Proof of reserves: the enclave publishes the root of a Merkle tree over every reserve the
 * vault holds (LiNEAR on NEAR, margin and the short on Hyperliquid, the settlement buffer), and
 * anyone holding a leaf and its proof can check it against the root on the risk board.
 *
 * Leaf = SHA-256("parry-reserve:v1|" asset "|" venue "|" amount "|" usd_e6). Inner node =
 * SHA-256(0x01 || lower || higher), with the two children sorted so proofs need no left/right
 * flags. An odd node is carried up unchanged.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface ReserveLeaf {
  asset: string;
  venue: string;
  /** Decimal string in the asset's smallest unit. */
  amount: string;
  /** USD value scaled by 1e6, decimal string. */
  usdE6: string;
}

export const leafHash = (l: ReserveLeaf): string =>
  bytesToHex(sha256(utf8ToBytes(`parry-reserve:v1|${l.asset}|${l.venue}|${l.amount}|${l.usdE6}`)));

function nodeHash(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const buf = new Uint8Array(65);
  buf[0] = 1;
  buf.set(hexToBytes(lo), 1);
  buf.set(hexToBytes(hi), 33);
  return bytesToHex(sha256(buf));
}

export const EMPTY_ROOT = bytesToHex(sha256(utf8ToBytes("parry-reserve:v1|empty")));

/** The tree's levels, leaves first (leaves sorted by hash). */
function levels(leaves: ReserveLeaf[]): string[][] {
  let level = leaves.map(leafHash).sort();
  const out = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i]!, level[i + 1]!) : level[i]!);
    out.push(next);
    level = next;
  }
  return out;
}

export function reserveRoot(leaves: ReserveLeaf[]): string {
  if (leaves.length === 0) return EMPTY_ROOT;
  const ls = levels(leaves);
  return ls[ls.length - 1]![0]!;
}

/** The sibling hashes from `leaf` up to the root. */
export function reserveProof(leaves: ReserveLeaf[], leaf: ReserveLeaf): string[] {
  const ls = levels(leaves);
  let index = ls[0]!.indexOf(leafHash(leaf));
  if (index < 0) throw new Error("leaf not in the tree");
  const proof: string[] = [];
  for (let d = 0; d < ls.length - 1; d++) {
    const sibling = index ^ 1;
    if (sibling < ls[d]!.length) proof.push(ls[d]![sibling]!);
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyReserveProof(leaf: ReserveLeaf, proof: string[], root: string): boolean {
  return proof.reduce((h, sibling) => nodeHash(h, sibling), leafHash(leaf)) === root.toLowerCase();
}

/** Reserves over liabilities in bps (10000 = fully backed). */
export const reserveRatioBps = (reservesUsd: number, liabilitiesUsd: number): number =>
  liabilitiesUsd > 0 ? Math.floor((reservesUsd / liabilitiesUsd) * 10_000) : 10_000;
