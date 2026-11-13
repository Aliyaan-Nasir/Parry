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
  | { hl_margin_to_perp: { amount: string; nonce: number } }
  | { upgrade: { code_hash: string } }
  | { close_rhea: { slippage_bps: number; pool_id: number } }
  | { unwind: { tokens: string[]; to?: string } };

type Amount = string | number | bigint;

/** The most gas one function call may carry on NEAR (1 PGas). */
export const MAX_CALL_TGAS = 1000;
/** Gas for an ordinary owner call. */
export const OWNER_CALL_TGAS = 300;
/** `close_rhea`: the account needs 750 + 30 per protocol token Tgas (810 with two, 840 with three). */
export const CLOSE_RHEA_TGAS = 900;
/** `retry_close`: the account needs 360 Tgas. */
export const RETRY_CLOSE_TGAS = 400;
export const MAX_CLOSE_SLIPPAGE_BPS = 1000;
export const MAX_UNWIND_TOKENS = 16;
/** Protocol tokens assumed when the caller does not say (testnet lists two, wNEAR and USDC). */
const DEFAULT_PROTOCOL_TOKENS = 3;

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
  /** Forgets a stuck deleverage or close after the owner settled it by hand. */
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
   * Signs a Hyperliquid `usdClassTransfer` that moves `amount` USDC (a decimal string, at most 8
   * decimals) from the account's own Hyperliquid Spot balance into its Perps margin. USDC sent
   * from a Unified Hyperliquid account lands in Spot, where orders cannot use it. The transfer
   * names no destination. Must be the only action; submit the signature with
   * `hyperliquidMarginBody`.
   */
  hlMarginToPerp: (amount: string, nonce: number): OwnerAction => {
    if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(amount) || !/[1-9]/.test(amount)) throw new Error("amount must be a positive USDC amount with at most 8 decimals, such as \"20\" or \"12.5\"");
    if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("Hyperliquid nonce must be a positive integer (milliseconds)");
    return { hl_margin_to_perp: { amount, nonce } };
  },
  /**
   * Closes the Rhea position through the exchange pool `poolId` (the API's `/v1/config` names it as
   * `dexPool`): one round sells at most the collateral that keeps health at 1.02, repays the debt
   * it buys, and when that is the whole debt withdraws the rest of the collateral into the account
   * (`position_closed`); otherwise it emits `close_progress` and the next call continues. A failed
   * step before the swap restores the round's collateral. Must be the only action; it needs
   * `CLOSE_RHEA_TGAS`.
   */
  closeRhea: (o: { slippageBps: number; poolId: number }): OwnerAction => {
    if (!Number.isInteger(o.slippageBps) || o.slippageBps < 1 || o.slippageBps > MAX_CLOSE_SLIPPAGE_BPS) throw new Error(`slippageBps must be an integer from 1 to ${MAX_CLOSE_SLIPPAGE_BPS}`);
    if (!Number.isSafeInteger(o.poolId) || o.poolId < 0) throw new Error("poolId must be the exchange pool's index (the API config's dexPool)");
    return { close_rhea: { slippage_bps: o.slippageBps, pool_id: o.poolId } };
  },
  /**
   * Revokes the mandate, withdraws every lending supply into the account, then sends each listed
   * token's balance and the NEAR above the storage reserve to the owner (`to`, required for a
   * passkey owner). At most 16 tokens, each once. Must be the only action; it needs `unwindTgas`.
   */
  unwind: (tokens: string[], to?: string): OwnerAction => {
    if (new Set(tokens).size !== tokens.length) throw new Error("unwind lists each token once");
    if (tokens.length > MAX_UNWIND_TOKENS) throw new Error(`unwind takes at most ${MAX_UNWIND_TOKENS} tokens`);
    return { unwind: to === undefined ? { tokens } : { tokens, to } };
  },
  /** Moves the account to another published global code hash (base58). */
  upgrade: (codeHash: string): OwnerAction => ({ upgrade: { code_hash: codeHash } }),
} as const;

function assertActions(actions: OwnerAction[]): void {
  if (actions.length === 0) throw new Error("no actions");
  const signing = actions.some((a) => typeof a === "object" && ("mpc_sign" in a || "hl_order" in a || "hl_margin_to_perp" in a));
  if (signing && actions.length !== 1) throw new Error("a signing action (mpc_sign, hl_order, hl_margin_to_perp) must be the only action");
  const closing = actions.some((a) => typeof a === "object" && "close_rhea" in a);
  if (closing && actions.length !== 1) throw new Error("close_rhea must be the only action");
  const unwinding = actions.some((a) => typeof a === "object" && "unwind" in a);
  if (unwinding && actions.length !== 1) throw new Error("unwind must be the only action");
}

// ---------------------------------------------------------------------------------------------
// Gas: the account refuses a close, retry or unwind sent with less than its whole chain needs
// ---------------------------------------------------------------------------------------------

/**
 * Gas for `unwind`: the account needs 160 + 130 per protocol token (one lending withdrawal each)
 * + 25 per listed token Tgas; this sends 60 Tgas more, at least 600 and at most 1 PGas.
 */
export function unwindTgas(tokens: number, protocolTokens = DEFAULT_PROTOCOL_TOKENS): number {
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_UNWIND_TOKENS) throw new Error(`unwind takes 0 to ${MAX_UNWIND_TOKENS} tokens`);
  if (!Number.isInteger(protocolTokens) || protocolTokens < 0) throw new Error("protocolTokens must be a whole number");
  const need = 160 + 130 * protocolTokens + 25 * tokens;
  if (need > MAX_CALL_TGAS) throw new Error(`an unwind of ${tokens} tokens over ${protocolTokens} protocol tokens needs ${need} Tgas, more than one call may carry`);
  return Math.min(MAX_CALL_TGAS, Math.max(600, need + 60));
}

/**
 * The gas an owner call (or a relayed owner request) with these actions needs: `CLOSE_RHEA_TGAS`
 * for a close, `unwindTgas` for an unwind, `OWNER_CALL_TGAS` otherwise. `protocolTokens` is the
 * number of tokens in the account's `protocol()` (default 3, which covers testnet's two).
 */
export function ownerActionsTgas(actions: OwnerAction[], opts: { protocolTokens?: number } = {}): number {
  let tgas = OWNER_CALL_TGAS;
  for (const a of actions) {
    if (typeof a !== "object") continue;
    if ("close_rhea" in a) tgas = Math.max(tgas, CLOSE_RHEA_TGAS);
    if ("unwind" in a) tgas = Math.max(tgas, unwindTgas(a.unwind.tokens.length, opts.protocolTokens));
  }
  return tgas;
}

/**
 * `owner_call(actions)` for a NEAR-account owner: 1 yoctoNEAR, with the gas the actions need
 * (`ownerActionsTgas`: 300 Tgas, 900 for a close, 600 or more for an unwind).
 */
export function ownerCallAction(account: string, actions: OwnerAction[], opts: { protocolTokens?: number } = {}): ContractCall {
  assertActions(actions);
  return contractCall(account, "owner_call", { actions }, { tgas: ownerActionsTgas(actions, opts), deposit: ONE_YOCTO });
}

/** `retry_close()` on a protected account: resumes a close stuck after its swap. Anyone may send it; 400 Tgas, no deposit. */
export function retryCloseAction(account: string): ContractCall {
  return contractCall(account, "retry_close", {}, { tgas: RETRY_CLOSE_TGAS });
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
