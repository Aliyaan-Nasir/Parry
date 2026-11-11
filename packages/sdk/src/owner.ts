/**
 * Owner actions on a protected account. A NEAR-account owner sends them with `owner_call` and one
 * yoctoNEAR; a passkey owner signs an `OwnerRequest` whose SHA-256 (domain separated) is the
 * WebAuthn challenge, and anyone relays it to `owner_execute`.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { contractCall, ONE_YOCTO, type ContractCall } from "./calls.js";
import { concatBytes, toBase64, toBase64Url, u128, utf8 } from "./encoding.js";
import type { Network } from "./networks.js";
import type { HlOrder, Mandate } from "./types.js";

/** The `OwnerAction` enum, as the account contract reads it. */
export type OwnerAction =
  | { set_mandate: { mandate: Mandate } }
  | "revoke_mandate"
  | { pause_guardian: { until: number } }
  | "clear_pending"
  | { supply: { token: string; amount: string } }
  | { borrow: { token: string; amount: string } }
  | { repay: { token: string; amount: string } }
  | { withdraw: { token: string; amount: string } }
  | { call: { receiver_id: string; method_name: string; args: string; deposit: string; gas: string } }
  | { transfer: { receiver_id: string; amount: string } }
  | { ft_transfer: { token: string; receiver_id: string; amount: string } }
  | { mpc_sign: { path: string; payload: string; domain_id: number } }
  | { hl_order: { order: HlOrder; nonce: number } }
  | { upgrade: { code_hash: string } }
  | { close_rhea: { slippage_bps: number } }
  | { unwind: { tokens: string[]; to?: string } };

type Amount = string | number | bigint;

function seconds(t: number | Date): number {
  const s = t instanceof Date ? Math.floor(t.getTime() / 1000) : t;
  if (!Number.isSafeInteger(s) || s < 0) throw new Error("time must be whole unix seconds");
  return s;
}

/** Builders for every owner action. Amounts are token units (decimal strings or bigints). */
export const ownerActions = {
  setMandate: (mandate: Mandate): OwnerAction => ({ set_mandate: { mandate } }),
  revokeMandate: (): OwnerAction => "revoke_mandate",
  /** Stops guardian actions until `until` (unix seconds or a Date); 0 resumes. */
  pauseGuardian: (until: number | Date): OwnerAction => ({ pause_guardian: { until: seconds(until) } }),
  /** Forgets a stuck deleverage after the owner settled it by hand. */
  clearPending: (): OwnerAction => "clear_pending",
  supply: (token: string, amount: Amount): OwnerAction => ({ supply: { token, amount: u128(amount) } }),
  borrow: (token: string, amount: Amount): OwnerAction => ({ borrow: { token, amount: u128(amount) } }),
  repay: (token: string, amount: Amount): OwnerAction => ({ repay: { token, amount: u128(amount) } }),
  withdraw: (token: string, amount: Amount): OwnerAction => ({ withdraw: { token, amount: u128(amount) } }),
  /** Any contract call from the protected account. `args` is JSON (an object or text) or raw bytes. */
  call: (c: {
    receiverId: string;
    methodName: string;
    args?: Record<string, unknown> | string | Uint8Array;
    deposit?: Amount;
    tgas?: number;
  }): OwnerAction => {
    const raw = c.args === undefined ? utf8("{}") : c.args instanceof Uint8Array ? c.args : utf8(typeof c.args === "string" ? c.args : JSON.stringify(c.args));
    const tgas = c.tgas ?? 30;
    if (!Number.isInteger(tgas) || tgas <= 0 || tgas > 300) throw new Error("tgas must be 1 to 300");
    return {
      call: {
        receiver_id: c.receiverId,
        method_name: c.methodName,
        args: toBase64(raw),
        deposit: u128(c.deposit ?? 0, "deposit"),
        gas: (BigInt(tgas) * 1_000_000_000_000n).toString(),
      },
    };
  },
  /** Sends NEAR (yoctoNEAR) from the protected account. */
  transfer: (receiverId: string, amountYocto: Amount): OwnerAction => ({ transfer: { receiver_id: receiverId, amount: u128(amountYocto) } }),
  ftTransfer: (token: string, receiverId: string, amount: Amount): OwnerAction => ({
    ft_transfer: { token, receiver_id: receiverId, amount: u128(amount) },
  }),
  /** Signs a 32-byte hash (64 hex) with Chain Signatures at `path` (domain 0). Must be the only action. */
  mpcSign: (path: string, payloadHex: string, domainId = 0): OwnerAction => {
    const payload = payloadHex.replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(payload)) throw new Error("payload must be a 32-byte hash in hex");
    if (domainId !== 0) throw new Error("only domain 0 (secp256k1) is supported");
    return { mpc_sign: { path, payload, domain_id: domainId } };
  },
  /** Signs the owner's own Hyperliquid order. Must be the only action. */
  hlOrder: (order: HlOrder, nonce: number): OwnerAction => {
    if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("Hyperliquid nonce must be a positive integer (milliseconds)");
    return { hl_order: { order, nonce } };
  },
  /**
   * Closes the whole Rhea position atomically: sells just enough collateral on the Rhea exchange to
   * repay all debt, repays it, and withdraws the rest into the account; any failed step restores the
   * position. Must be the only action.
   */
  closeRhea: (slippageBps: number): OwnerAction => {
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) throw new Error("slippageBps must be an integer from 0 to 1000");
    return { close_rhea: { slippage_bps: slippageBps } };
  },
  /**
   * Revokes the mandate, withdraws every lending position into the account, then sends each listed
   * token's balance and the NEAR above the storage reserve to the owner (`to` for a passkey owner).
   */
  unwind: (tokens: string[], to?: string): OwnerAction => {
    if (new Set(tokens).size !== tokens.length) throw new Error("unwind lists each token once");
    return { unwind: to === undefined ? { tokens } : { tokens, to } };
  },
  /** Moves the account to another published global code hash (base58). */
  upgrade: (codeHash: string): OwnerAction => ({ upgrade: { code_hash: codeHash } }),
} as const;

function assertActions(actions: OwnerAction[]): void {
  if (actions.length === 0) throw new Error("no actions");
  const signing = actions.some((a) => typeof a === "object" && ("mpc_sign" in a || "hl_order" in a));
  if (signing && actions.length !== 1) throw new Error("a signing action (mpc_sign, hl_order) must be the only action");
  const closing = actions.some((a) => typeof a === "object" && "close_rhea" in a);
  if (closing && actions.length !== 1) throw new Error("close_rhea must be the only action");
}

/** `owner_call(actions)` for a NEAR-account owner: 1 yoctoNEAR, 300 Tgas. */
export function ownerCallAction(account: string, actions: OwnerAction[]): ContractCall {
  assertActions(actions);
  return contractCall(account, "owner_call", { actions }, { tgas: 300, deposit: ONE_YOCTO });
}

export const REQUEST_DOMAIN = "parry-account:v1:";

/** SHA-256("parry-account:v1:" ++ request text): the WebAuthn challenge. */
export const requestDigest = (text: string): Uint8Array => sha256(concatBytes(utf8(REQUEST_DOMAIN), utf8(text)));

export interface OwnerRequestInput {
  account: string;
  network: Network;
  /** Must be greater than the account's owner nonce (`nonces()`). */
  nonce: number;
  actions: OwnerAction[];
  /** Unix seconds; defaults to now. Valid from 10 minutes before to 5 minutes after it. */
  createdAt?: number;
}

export interface OwnerRequest {
  /** The exact request text: sign it once and relay it unchanged. */
  text: string;
  /** The WebAuthn challenge (pass it to `navigator.credentials.get`). */
  challenge: Uint8Array;
  /** The challenge as clientDataJSON carries it (base64url, no padding). */
  challengeBase64Url: string;
}

/** The request a passkey owner signs. */
export function ownerRequest(input: OwnerRequestInput): OwnerRequest {
  assertActions(input.actions);
  if (!Number.isSafeInteger(input.nonce) || input.nonce <= 0) throw new Error("nonce must be a positive integer");
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const text = JSON.stringify({
    account: input.account,
    network: input.network,
    nonce: input.nonce,
    created_at: seconds(createdAt),
    actions: input.actions,
  });
  const challenge = requestDigest(text);
  return { text, challenge, challengeBase64Url: toBase64Url(challenge) };
}
