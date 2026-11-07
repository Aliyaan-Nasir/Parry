/**
 * Mandates: what a person allows the guardian to do, checked here exactly as the account
 * contract checks it (`Mandate::assert_valid`), so a bad mandate fails before it costs gas.
 */

import { parseEd25519PublicKey, toBase64, u128 } from "./encoding.js";
import { sealPolicy, type Policy } from "./seal.js";
import { POWERS, type Mandate, type Power } from "./types.js";

export const MANDATE_LIMITS = {
  maxLimits: 8,
  minHealthAfterBps: 10_500,
  maxSlippageBps: 300,
  maxBandBps: 300,
  maxActionsPerDay: 48,
  maxSealedBytes: 2048,
  maxDurationSecs: 180 * 86_400,
} as const;

type Amount = string | number | bigint;

export interface MandateInput {
  /** The protected account the mandate is for (binds the sealed policy to it). */
  account: string;
  /** The enclave's ed25519 key, `ed25519:<base58>` (the risk board's `get_enclave`). */
  guardianKey: string;
  powers: Power[];
  /** Per-token reserve (total over the mandate's life) and daily cap, in token units. */
  limits: { token: string; reserve: Amount; daily: Amount }[];
  maxActionsPerDay: number;
  /** Health a deleverage must leave, bps (at least 10500). */
  minHealthAfterBps: number;
  /** Largest rescue swap slippage against the mark, bps (at most 300). */
  maxSlippageBps: number;
  hl?: { asset: string; assetIndex: number; maxSizeE8: Amount; bandBps: number; hedgeIsBuy: boolean } | null;
  evm?: { chainId: number; pool: string; asset: string; address: string; maxAmount: Amount } | null;
  /** Unix seconds or a Date; at most 180 days ahead. */
  expiresAt: number | Date;
  /** Trigger thresholds and strategy, sealed to the enclave (needs `sealingPublicKey`). */
  policy?: Policy;
  /** The enclave's X25519 sealing key (64 hex, the risk board's `sealing_key`). */
  sealingPublicKey?: string | Uint8Array;
  /** Unix seconds used for the expiry checks; defaults to now. */
  now?: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Builds and checks a mandate. With `policy`, seals it and puts the base64 in `sealed`. */
export function buildMandate(input: MandateInput): Mandate {
  const fail = (msg: string): never => {
    throw new Error(`mandate: ${msg}`);
  };
  try {
    parseEd25519PublicKey(input.guardianKey);
  } catch {
    fail("guardian key must be an ed25519:<base58> key");
  }
  if (input.powers.length === 0) fail("a mandate needs at least one power");
  for (const p of input.powers) if (!POWERS.includes(p)) fail(`unknown power ${JSON.stringify(p)}`);
  const powers = [...new Set(input.powers)];
  if (input.limits.length > MANDATE_LIMITS.maxLimits) fail("at most 8 token limits");
  const tokens = new Set<string>();
  const limits = input.limits.map((l) => {
    if (tokens.has(l.token)) fail(`duplicate token limit for ${l.token}`);
    tokens.add(l.token);
    return { token: l.token, reserve: u128(l.reserve, "reserve"), daily: u128(l.daily, "daily") };
  });
  const intIn = (v: number, lo: number, hi: number, msg: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) fail(msg);
  };
  intIn(input.maxActionsPerDay, 1, MANDATE_LIMITS.maxActionsPerDay, "1 to 48 actions per day");
  intIn(input.minHealthAfterBps, MANDATE_LIMITS.minHealthAfterBps, 4_294_967_295, "deleverage must leave health of at least 1.05 (10500 bps)");
  intIn(input.maxSlippageBps, 0, MANDATE_LIMITS.maxSlippageBps, "slippage is capped at 3% (300 bps)");

  const hl = input.hl
    ? (() => {
        intIn(input.hl.bandBps, 1, MANDATE_LIMITS.maxBandBps, "price band is 1 to 300 bps");
        intIn(input.hl.assetIndex, 0, 4_294_967_295, "Hyperliquid asset index must be a u32");
        const size = u128(input.hl.maxSizeE8, "maxSizeE8");
        if (size === "0") fail("Hyperliquid size cap must be positive");
        return { asset: input.hl.asset, asset_index: input.hl.assetIndex, max_size_e8: size, band_bps: input.hl.bandBps, hedge_is_buy: input.hl.hedgeIsBuy };
      })()
    : null;
  if (powers.some((p) => p === "hl_reduce" || p === "hl_hedge") && !hl) fail("Hyperliquid powers need a Hyperliquid guard");

  const evm = input.evm
    ? (() => {
        for (const a of [input.evm.pool, input.evm.asset, input.evm.address]) if (!EVM_ADDRESS.test(a)) fail(`bad EVM address ${a}`);
        if (!Number.isSafeInteger(input.evm.chainId) || input.evm.chainId <= 0) fail("EVM chain id must be a positive integer");
        const max = u128(input.evm.maxAmount, "maxAmount");
        if (max === "0") fail("EVM repay cap must be positive");
        return { chain_id: input.evm.chainId, pool: input.evm.pool, asset: input.evm.asset, address: input.evm.address, max_amount: max };
      })()
    : null;
  if (powers.includes("evm_repay") && !evm) fail("EVM repay needs an EVM guard");

  const expiresAt = input.expiresAt instanceof Date ? Math.floor(input.expiresAt.getTime() / 1000) : input.expiresAt;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt)) fail("expiresAt must be whole unix seconds");
  if (expiresAt <= now) fail("mandate already expired");
  if (expiresAt > now + MANDATE_LIMITS.maxDurationSecs) fail("a mandate lasts at most 180 days");

  let sealed: string | null = null;
  if (input.policy) {
    if (!input.sealingPublicKey) fail("a policy is sealed to the enclave: pass sealingPublicKey");
    sealed = toBase64(sealPolicy(input.policy, { account: input.account, sealingPublicKey: input.sealingPublicKey! }));
  }

  return {
    guardian_key: input.guardianKey,
    powers,
    limits,
    max_actions_per_day: input.maxActionsPerDay,
    min_health_after_bps: input.minHealthAfterBps,
    max_slippage_bps: input.maxSlippageBps,
    hl,
    evm,
    sealed,
    expires_at: expiresAt,
  };
}
