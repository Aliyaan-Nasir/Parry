/**
 * The EVM half of an Aave rescue. The account contract builds the unsigned EIP-1559 transaction
 * inside its guard and has Chain Signatures sign its hash; this module only adds the signature,
 * broadcasts the result and, once the block is final, asks the MPC network to verify the
 * transaction on the foreign chain (`verify_foreign_transaction`), so the rescue's outcome is
 * attested on NEAR too.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { contract, EVM, EVM_RPC_URL } from "./config";
import type { Sender } from "./near";

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const unhex = (s: string) => {
  const h = s.replace(/^0x/, "");
  return hexToBytes(h.length % 2 ? `0${h}` : h);
};

// ---------------------------------------------------------------------------------------------
// RLP (just what a typed transaction needs: byte strings and one flat list)
// ---------------------------------------------------------------------------------------------

export function encodeLength(len: number, offset: number): Uint8Array {
  if (len <= 55) return Uint8Array.of(offset + len);
  const bytes = unhex(len.toString(16));
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
}

export function rlpBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0]! < 0x80) return b;
  return Uint8Array.of(...encodeLength(b.length, 0x80), ...b);
}

/** Decodes a flat RLP list of byte strings (an access list, a nested list, comes back raw). */
export function rlpDecodeList(data: Uint8Array): Uint8Array[] {
  const header = (at: number): [number, number, boolean] => {
    const b = data[at]!;
    if (b < 0x80) return [at, 1, false];
    if (b <= 0xb7) return [at + 1, b - 0x80, false];
    if (b < 0xc0) {
      const n = b - 0xb7;
      return [at + 1 + n, parseInt(bytesToHex(data.slice(at + 1, at + 1 + n)), 16), false];
    }
    if (b <= 0xf7) return [at + 1, b - 0xc0, true];
    const n = b - 0xf7;
    return [at + 1 + n, parseInt(bytesToHex(data.slice(at + 1, at + 1 + n)), 16), true];
  };
  const [start, len, isList] = header(0);
  if (!isList || start + len !== data.length) throw new Error("not a single RLP list");
  const out: Uint8Array[] = [];
  for (let at = start; at < start + len; ) {
    const [s, l, nested] = header(at);
    // A nested list (the access list) is kept with its header so it re-encodes unchanged.
    out.push(nested ? data.slice(at, s + l) : data.slice(s, s + l));
    at = s + l;
  }
  return out;
}

export interface UnsignedTx {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: string;
}

const uint = (v: bigint | number) => (BigInt(v) === 0n ? new Uint8Array() : unhex(BigInt(v).toString(16)));

/** 0x02 || rlp([chainId, nonce, tip, maxFee, gas, to, value, data, []]) (hex), as the account contract builds it. */
export function encodeUnsigned(t: UnsignedTx): string {
  const fields = [uint(t.chainId), uint(t.nonce), uint(t.maxPriorityFeePerGas), uint(t.maxFeePerGas), uint(t.gasLimit), unhex(t.to), uint(t.value), unhex(t.data)];
  const payload = [...fields.flatMap((f) => [...rlpBytes(f)]), 0xc0];
  return hex(Uint8Array.of(0x02, ...encodeLength(payload.length, 0xc0), ...payload));
}

export const signingHash = (unsignedHex: string) => bytesToHex(keccak_256(unhex(unsignedHex)));

const trimmed = (b: Uint8Array) => b.slice(b.findIndex((x) => x !== 0) === -1 ? b.length : b.findIndex((x) => x !== 0));

/**
 * The signed transaction: 0x02 || rlp([...the nine unsigned fields, yParity, r, s]). The unsigned
 * fields come from the contract's `evm_signed` event; the signature from its return value.
 */
export function assembleSigned(unsignedHex: string, sig: { r: string; s: string; v: number }): string {
  const unsigned = unhex(unsignedHex);
  if (unsigned[0] !== 0x02) throw new Error("not an EIP-1559 transaction");
  const fields = rlpDecodeList(unsigned.slice(1));
  if (fields.length !== 9) throw new Error("an EIP-1559 transaction has nine fields");
  const accessList = fields[8]!;
  const yParity = sig.v >= 27 ? sig.v - 27 : sig.v;
  const items = [...fields.slice(0, 8), yParity === 0 ? new Uint8Array() : Uint8Array.of(1), trimmed(unhex(sig.r)), trimmed(unhex(sig.s))];
  // Re-encode with the access list spliced in raw (it is a list, not a byte string).
  const encoded = items.flatMap((i, n) => (n === 8 ? [...accessList, ...rlpBytes(i)] : [...rlpBytes(i)]));
  const list = Uint8Array.of(...encodeLength(encoded.length, 0xc0), ...encoded);
  return hex(Uint8Array.of(0x02, ...list));
}

/** The address that signed a typed transaction (to check a signature before broadcasting it). */
export function signerOf(unsignedHex: string, sig: { r: string; s: string; v: number }): string {
  const digest = keccak_256(unhex(unsignedHex));
  const yParity = sig.v >= 27 ? sig.v - 27 : sig.v;
  const compact = Uint8Array.of(yParity, ...unhex(sig.r.padStart(64, "0")), ...unhex(sig.s.padStart(64, "0")));
  const pub = secp256k1.recoverPublicKey(compact, digest, { prehash: false, format: "recovered" } as never);
  const point = secp256k1.Point.fromBytes(pub).toBytes(false);
  return hex(keccak_256(point.slice(1)).slice(12));
}

export const txHashOf = (rawHex: string) => hex(keccak_256(unhex(rawHex)));

// ---------------------------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------------------------

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(EVM_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Broadcasts a signed transaction; a node that already has it answers with its hash too. */
export async function broadcast(rawHex: string): Promise<string> {
  try {
    return await rpc<string>("eth_sendRawTransaction", [rawHex]);
  } catch (e) {
    if (/already known|known transaction/i.test(String(e))) return txHashOf(rawHex);
    throw e;
  }
}

export interface Receipt {
  status: "0x1" | "0x0";
  blockNumber: string;
  logs: { address: string; topics: string[]; logIndex: string }[];
}

export const receipt = (hash: string) => rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);

/** Waits for the receipt, up to `ms`. */
export async function waitForReceipt(hash: string, ms = 60_000): Promise<Receipt | null> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const r = await receipt(hash).catch(() => null);
    if (r) return r;
    await Bun.sleep(3_000);
  }
  return null;
}

export async function finalizedBlock(): Promise<number> {
  const b = await rpc<{ number: string } | null>("eth_getBlockByNumber", ["finalized", false]);
  return b ? Number(BigInt(b.number)) : 0;
}

/** Aave v3 `Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)`. */
export const REPAY_TOPIC = hex(keccak_256(new TextEncoder().encode("Repay(address,address,address,uint256,bool)")));
/** ERC-20 `Approval(address indexed owner, address indexed spender, uint256 value)`. */
export const APPROVAL_TOPIC = hex(keccak_256(new TextEncoder().encode("Approval(address,address,uint256)")));

/**
 * The MPC network's foreign-transaction check: its nodes read the transaction on the foreign
 * chain at the given finality and sign what they extracted (the block hash, and the log that
 * shows the repay or approval), and the signer contract checks that signature before answering.
 */
export function verifyRequest(txHash: string, logIndex: number | null) {
  const extractors: unknown[] = ["BlockHash"];
  if (logIndex !== null) extractors.push({ Log: { log_index: logIndex } });
  return {
    request: {
      request: { [EVM.foreignChain]: { tx_id: txHash.replace(/^0x/, "").toLowerCase(), extractors, finality: "Finalized" } },
      domain_id: 3,
      payload_version: 1,
    },
  };
}

export async function verifyOnNear(wallet: Sender, txHash: string, logIndex: number | null) {
  return wallet.call({
    receiverId: contract("signer"),
    methodName: "verify_foreign_transaction",
    args: verifyRequest(txHash, logIndex),
    tgas: 100,
    deposit: 1n,
  });
}
