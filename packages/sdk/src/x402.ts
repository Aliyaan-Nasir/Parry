/**
 * x402 payments on NEAR. A paid endpoint answers 402 with what it accepts; the client signs a
 * NEP-366 delegate action for `ft_transfer` of the price to the payee and repeats the request with
 * it in `X-PAYMENT`; the server checks the delegate, relays it (paying the gas) and answers with
 * `X-PAYMENT-RESPONSE`. The encoders, the parser and the verifier here are what both sides use.
 *
 * A delegate action is signed as NEP-461 prescribes for on-chain messages: ed25519 over
 * SHA-256(u32 little endian (2^30 + 366) ++ borsh(DelegateAction)), where DelegateAction is
 * { sender_id, receiver_id, actions, nonce: u64, max_block_height: u64, public_key }.
 * The transported form is borsh(SignedDelegateAction) = borsh(DelegateAction) ++ borsh(Signature).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { DELEGATE_ACTION_PREFIX, decodeSignedDelegateAction, encodeSignedDelegateAction, type Near } from "near-kit";
import { bytesEqual, concatBytes, formatEd25519PublicKey, fromBase64, fromUtf8, parseEd25519PublicKey, toBase64, utf8 } from "./encoding.js";

export const X402_VERSION = 2;
export const PAYMENT_HEADER = "X-PAYMENT";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
/** NEP-461 prefix of NEP-366 delegate actions: 2^30 + 366. */
export const NEP366_PREFIX = DELEGATE_ACTION_PREFIX;

export interface PaymentRequirements {
  scheme: "exact";
  /** `near:testnet` or `near:mainnet` */
  network: string;
  /** The NEP-141 token paid with. */
  asset: string;
  /** Token units, decimal string. */
  amount: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
}

/** The body of a 402 answer. */
export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
}

/** What `X-PAYMENT` carries (base64 of its JSON). */
export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: { signedDelegateAction: string };
}

/** What `X-PAYMENT-RESPONSE` carries (base64 of its JSON). */
export interface PaymentResponse {
  success: boolean;
  transaction: string;
  network: string;
  errorReason?: string;
}

const b64json = (v: unknown): string => toBase64(utf8(JSON.stringify(v)));
const unb64json = (s: string): unknown => JSON.parse(fromUtf8(fromBase64(s.trim())));

export const encodePaymentHeader = (p: PaymentPayload): string => b64json(p);

export function decodePaymentHeader(header: string): PaymentPayload {
  let v: Partial<PaymentPayload>;
  try {
    v = unb64json(header) as Partial<PaymentPayload>;
  } catch {
    throw new Error("X-PAYMENT is not base64 JSON");
  }
  if (typeof v !== "object" || v === null) throw new Error("X-PAYMENT is not an object");
  if (typeof v.x402Version !== "number") throw new Error("X-PAYMENT has no x402Version");
  if (v.scheme !== "exact") throw new Error("X-PAYMENT scheme must be exact");
  if (typeof v.network !== "string") throw new Error("X-PAYMENT has no network");
  if (typeof v.payload?.signedDelegateAction !== "string") throw new Error("X-PAYMENT has no payload.signedDelegateAction");
  return { x402Version: v.x402Version, scheme: "exact", network: v.network, payload: { signedDelegateAction: v.payload.signedDelegateAction } };
}

export const encodePaymentResponse = (r: PaymentResponse): string => b64json(r);

export function decodePaymentResponse(header: string): PaymentResponse {
  const v = unb64json(header) as Partial<PaymentResponse>;
  if (typeof v?.success !== "boolean") throw new Error("X-PAYMENT-RESPONSE has no success flag");
  return { success: v.success, transaction: String(v.transaction ?? ""), network: String(v.network ?? ""), ...(v.errorReason ? { errorReason: String(v.errorReason) } : {}) };
}

export type DelegateActionItem =
  | {
      type: "FunctionCall";
      methodName: string;
      /** The args parsed as JSON, or null when they are not JSON. */
      args: unknown;
      argsBase64: string;
      gas: bigint;
      deposit: bigint;
    }
  | { type: "Transfer"; deposit: bigint }
  | { type: "Other"; kind: string };

export interface ParsedDelegate {
  senderId: string;
  receiverId: string;
  actions: DelegateActionItem[];
  nonce: bigint;
  maxBlockHeight: bigint;
  /** `ed25519:<base58>` */
  publicKey: string;
  signature: Uint8Array;
  /** borsh(DelegateAction): the bytes the NEP-461 hash covers. */
  delegateBytes: Uint8Array;
  /** SHA-256(prefix ++ delegateBytes): what the sender signed. */
  hash: Uint8Array;
}

type Decoded = ReturnType<typeof decodeSignedDelegateAction>["signedDelegate"];

/** SHA-256(u32le(2^30 + 366) ++ borsh(DelegateAction)). */
export function delegateActionHash(delegateBytes: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, NEP366_PREFIX, true);
  return sha256(concatBytes(prefix, delegateBytes));
}

/** Parses a borsh SignedDelegateAction (standard base64 or bytes). Only ed25519 keys are accepted. */
export function parseSignedDelegate(input: string | Uint8Array): ParsedDelegate {
  const bytes = typeof input === "string" ? fromBase64(input) : input;
  let decoded: Decoded;
  try {
    decoded = decodeSignedDelegateAction(bytes).signedDelegate;
  } catch (e) {
    throw new Error(`not a borsh SignedDelegateAction: ${(e as Error).message}`);
  }
  // A canonical encoding with nothing after it: re-encoding gives back the same bytes.
  const again = encodeSignedDelegateAction({ signedDelegate: decoded }, "bytes");
  if (!bytesEqual(again, bytes)) throw new Error("signed delegate action has trailing or non-canonical bytes");
  const pk = decoded.delegateAction.publicKey;
  const sig = decoded.signature;
  if (!("ed25519Key" in pk) || !("ed25519Signature" in sig)) throw new Error("only ed25519 delegate actions are accepted");
  // borsh(Signature::ED25519) is a 0 tag and 64 bytes, the last 65 bytes of the payload.
  const delegateBytes = bytes.slice(0, bytes.length - 65);
  const d = decoded.delegateAction;
  const actions: DelegateActionItem[] = d.actions.map((a) => {
    if ("functionCall" in a) {
      const fc = a.functionCall;
      const raw = Uint8Array.from(fc.args);
      let args: unknown = null;
      try {
        args = JSON.parse(fromUtf8(raw));
      } catch {
        args = null;
      }
      return { type: "FunctionCall", methodName: fc.methodName, args, argsBase64: toBase64(raw), gas: BigInt(fc.gas), deposit: BigInt(fc.deposit) };
    }
    if ("transfer" in a) return { type: "Transfer", deposit: BigInt(a.transfer.deposit) };
    return { type: "Other", kind: Object.keys(a)[0] ?? "unknown" };
  });
  return {
    senderId: d.senderId,
    receiverId: d.receiverId,
    actions,
    nonce: BigInt(d.nonce),
    maxBlockHeight: BigInt(d.maxBlockHeight),
    publicKey: formatEd25519PublicKey(Uint8Array.from(pk.ed25519Key.data)),
    signature: Uint8Array.from(sig.ed25519Signature.data),
    delegateBytes,
    hash: delegateActionHash(delegateBytes),
  };
}

/** True when the delegate action's ed25519 signature verifies with its own public key. */
export function verifySignedDelegate(input: string | Uint8Array | ParsedDelegate): boolean {
  try {
    const d = typeof input === "string" || input instanceof Uint8Array ? parseSignedDelegate(input) : input;
    // Hash the signed bytes again rather than trusting a hash handed in.
    return ed25519.verify(d.signature, delegateActionHash(d.delegateBytes), parseEd25519PublicKey(d.publicKey));
  } catch {
    return false;
  }
}

export interface PaymentCheckOptions {
  /** The chain's current block height: the delegate must still be valid at it. */
  blockHeight?: bigint | number;
  /** Largest `maxBlockHeight - blockHeight` accepted (default 240 blocks, about 4 minutes). */
  maxBlocksAhead?: number;
  /** Most gas the delegate may attach, since the relayer pays for it (default 50 Tgas). */
  maxGas?: bigint;
}

export type PaymentCheck = { ok: true; delegate: ParsedDelegate } | { ok: false; reason: string; delegate?: ParsedDelegate };

/**
 * Checks a payment against what was asked: scheme and network, a valid signature, one
 * `ft_transfer` on the asset of exactly `amount` to `payTo` with 1 yoctoNEAR, bounded gas, and a
 * delegate that is still valid. The caller then relays it and checks the transfer succeeded.
 */
export function verifyPayment(payment: PaymentPayload, req: PaymentRequirements, opts: PaymentCheckOptions = {}): PaymentCheck {
  if (payment.x402Version !== X402_VERSION) return { ok: false, reason: `x402Version must be ${X402_VERSION}` };
  if (payment.scheme !== req.scheme) return { ok: false, reason: "scheme does not match" };
  if (payment.network !== req.network) return { ok: false, reason: "network does not match" };
  let d: ParsedDelegate;
  try {
    d = parseSignedDelegate(payment.payload.signedDelegateAction);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const fail = (reason: string): PaymentCheck => ({ ok: false, reason, delegate: d });
  if (!verifySignedDelegate(d)) return fail("delegate signature does not verify");
  if (d.receiverId !== req.asset) return fail(`delegate is for ${d.receiverId}, not the asset ${req.asset}`);
  if (d.actions.length !== 1) return fail("delegate must hold exactly one action");
  const a = d.actions[0]!;
  if (a.type !== "FunctionCall" || a.methodName !== "ft_transfer") return fail("the action must be ft_transfer");
  if (a.deposit !== 1n) return fail("ft_transfer must attach exactly 1 yoctoNEAR");
  if (a.gas > (opts.maxGas ?? 50n * 1_000_000_000_000n)) return fail("the action attaches too much gas");
  const args = a.args as { receiver_id?: unknown; amount?: unknown } | null;
  if (!args || args.receiver_id !== req.payTo) return fail(`ft_transfer must pay ${req.payTo}`);
  if (typeof args.amount !== "string" || !/^\d+$/.test(args.amount) || BigInt(args.amount) !== BigInt(req.amount)) {
    return fail(`ft_transfer must move exactly ${req.amount}`);
  }
  if (opts.blockHeight !== undefined) {
    const h = BigInt(opts.blockHeight);
    if (d.maxBlockHeight <= h) return fail("delegate expired");
    if (d.maxBlockHeight - h > BigInt(opts.maxBlocksAhead ?? 240)) return fail("delegate is valid for too long");
  }
  return { ok: true, delegate: d };
}

/**
 * The chain-side checks before relaying a payment: the sender holds the delegate's key as a
 * full-access key (a deposit of 1 yoctoNEAR needs one), the nonce is unused, and the delegate is
 * still valid at the height the key was read at.
 */
export async function checkDelegateOnChain(near: Near, d: ParsedDelegate): Promise<{ ok: true; blockHeight: bigint } | { ok: false; reason: string }> {
  const key = await near.getAccessKey(d.senderId, d.publicKey);
  if (!key) return { ok: false, reason: `${d.senderId} has no access key ${d.publicKey}` };
  if (key.permission !== "FullAccess") return { ok: false, reason: "a payment needs a full-access key: it attaches 1 yoctoNEAR" };
  if (BigInt(key.nonce) >= d.nonce) return { ok: false, reason: "the delegate's nonce is already used" };
  const blockHeight = BigInt(key.block_height);
  if (d.maxBlockHeight <= blockHeight) return { ok: false, reason: "delegate expired" };
  return { ok: true, blockHeight };
}

/** Signs the `ft_transfer` a payment requires as a NEP-366 delegate action (standard base64). */
export async function signPaymentDelegate(
  near: Near,
  payerId: string,
  req: Pick<PaymentRequirements, "asset" | "payTo" | "amount">,
  opts: { blockHeightOffset?: number } = {},
): Promise<string> {
  const { payload } = await near
    .transaction(payerId)
    .functionCall(req.asset, "ft_transfer", { receiver_id: req.payTo, amount: req.amount }, { gas: "30 Tgas", attachedDeposit: "1 yocto" })
    .delegate({ blockHeightOffset: opts.blockHeightOffset ?? 120 });
  return payload;
}
