/**
 * Sealed mandate policies: a person's trigger thresholds and strategy, encrypted in the browser
 * to the guardian enclave's X25519 key, so nobody else can tell when the guardian will act.
 *
 * Layout: ephemeral public key (32) || nonce (12) || ChaCha20-Poly1305 ciphertext.
 * Key = SHA-256("parry-seal:v1" || shared secret || ephemeral public key || enclave public key).
 * Associated data = the protected account id, so a policy copied to another account fails to open.
 * The plaintext is the enclave's `Policy` JSON, written exactly as the enclave writes it.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { MAX_TRIGGER_HEALTH } from "@parryguard/core";
import { concatBytes, fromBase64, fromHex, fromUtf8, utf8 } from "./encoding.js";

export type Strategy = "repay-first" | "keep-exposure" | "deleverage-only";
export const STRATEGIES: ReadonlyArray<Strategy> = ["repay-first", "keep-exposure", "deleverage-only"];

/** A protective step a sealed policy may order. */
export type PolicyStep = "repay" | "add_collateral" | "deleverage" | "hl_reduce" | "evm_repay";
export const POLICY_STEPS: ReadonlyArray<PolicyStep> = ["repay", "add_collateral", "deleverage", "hl_reduce", "evm_repay"];

/** The step order a strategy implies when a policy names none (the enclave's default). */
export const STRATEGY_STEPS: Readonly<Record<Strategy, ReadonlyArray<PolicyStep>>> = {
  "repay-first": ["repay", "add_collateral", "deleverage", "hl_reduce", "evm_repay"],
  "keep-exposure": ["add_collateral", "repay", "deleverage", "hl_reduce", "evm_repay"],
  "deleverage-only": ["deleverage", "hl_reduce", "evm_repay"],
};

export const defaultSteps = (strategy: Strategy): PolicyStep[] => [...STRATEGY_STEPS[strategy]];

export interface Policy {
  /** Act at or above this risk score (0 to 100). */
  triggerScore: number;
  /** Act at or below this health, whatever the score. */
  triggerHealth: number;
  /** Health a rescue aims for. */
  targetHealth: number;
  strategy: Strategy;
  /** Fraction of a Hyperliquid position to close when it is in danger (0 to 1, default 0.25). */
  hlReduceFraction?: number;
  /** Act on an Aave position at or below this health (default 1.2). */
  evmTriggerHealth?: number;
  /**
   * The order the planner tries protective steps in: an ordered subset of `POLICY_STEPS`, each at
   * most once. It takes the first one the mandate allows that moves health toward the target.
   * Omitted: the strategy's order (`STRATEGY_STEPS`), and the sealed JSON carries no `steps`.
   */
  steps?: PolicyStep[];
}

export const POLICY_DEFAULTS = { hlReduceFraction: 0.25, evmTriggerHealth: 1.2 } as const;
/** The contract's limit on `sealed`. */
export const MAX_SEALED_BYTES = 2048;
const SEAL_DOMAIN = utf8("parry-seal:v1");
const HEADER = 32 + 12;
const TAG = 16;

/**
 * An f64 as Rust's serde_json writes it (ryu's shortest digits and layout): integers keep ".0",
 * and very small or very large magnitudes switch to exponent form at ryu's thresholds.
 */
export function rustFloat(x: number): string {
  if (!Number.isFinite(x)) throw new Error("policy numbers must be finite");
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mantissa, exponent] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const length = digits.length;
  const kk = Number(exponent) + 1; // 10^(kk-1) <= |x| < 10^kk
  const k = kk - length;
  if (k >= 0 && kk <= 16) return `${sign}${digits}${"0".repeat(k)}.0`;
  if (kk > 0 && kk <= 16) return `${sign}${digits.slice(0, kk)}.${digits.slice(kk)}`;
  if (kk > -5 && kk <= 0) return `${sign}0.${"0".repeat(-kk)}${digits}`;
  if (length === 1) return `${sign}${digits}e${kk - 1}`;
  return `${sign}${digits[0]}.${digits.slice(1)}e${kk - 1}`;
}

function assertSteps(steps: readonly string[]): void {
  if (steps.length === 0) throw new Error("steps must name at least one step");
  for (const s of steps) if (!(POLICY_STEPS as readonly string[]).includes(s)) throw new Error(`steps: ${s} is not one of ${POLICY_STEPS.join(", ")}`);
  if (new Set(steps).size !== steps.length) throw new Error("steps must name each step at most once");
}

function assertPolicy(p: Policy): Required<Omit<Policy, "steps">> & Pick<Policy, "steps"> {
  if (!Number.isInteger(p.triggerScore) || p.triggerScore < 0 || p.triggerScore > 100) throw new Error("triggerScore must be an integer from 0 to 100");
  if (!STRATEGIES.includes(p.strategy)) throw new Error(`strategy must be one of ${STRATEGIES.join(", ")}`);
  if (p.steps !== undefined) assertSteps(p.steps);
  const full: Required<Omit<Policy, "steps">> & Pick<Policy, "steps"> = {
    ...p,
    hlReduceFraction: p.hlReduceFraction ?? POLICY_DEFAULTS.hlReduceFraction,
    evmTriggerHealth: p.evmTriggerHealth ?? POLICY_DEFAULTS.evmTriggerHealth,
  };
  for (const [name, v] of Object.entries(full)) if (name !== "strategy" && name !== "steps" && !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  if (full.triggerHealth <= 0 || full.targetHealth <= 0 || full.evmTriggerHealth <= 0) throw new Error("health values must be positive");
  // The risk engine hands the guardian positions under this health; a higher trigger would never fire.
  if (full.triggerHealth > MAX_TRIGGER_HEALTH || full.evmTriggerHealth > MAX_TRIGGER_HEALTH) throw new Error(`trigger health values must be at most ${MAX_TRIGGER_HEALTH}`);
  if (full.hlReduceFraction < 0 || full.hlReduceFraction > 1) throw new Error("hlReduceFraction must be from 0 to 1");
  return full;
}

/** The exact plaintext the enclave's `Policy` serializes to (field order and number format). */
export function policyJson(policy: Policy): string {
  const p = assertPolicy(policy);
  return (
    `{"trigger_score":${p.triggerScore},"trigger_health":${rustFloat(p.triggerHealth)},` +
    `"target_health":${rustFloat(p.targetHealth)},"strategy":${JSON.stringify(p.strategy)},` +
    `"hl_reduce_fraction":${rustFloat(p.hlReduceFraction)},"evm_trigger_health":${rustFloat(p.evmTriggerHealth)}` +
    (p.steps ? `,"steps":${JSON.stringify(p.steps)}` : "") +
    "}"
  );
}

function parsePolicy(text: string): Policy {
  const v = JSON.parse(text) as Record<string, unknown>;
  const num = (k: string, fallback?: number): number => {
    const x = v[k] ?? fallback;
    if (typeof x !== "number") throw new Error(`sealed policy: ${k} missing`);
    return x;
  };
  if (typeof v["strategy"] !== "string") throw new Error("sealed policy: strategy missing");
  return {
    triggerScore: num("trigger_score"),
    triggerHealth: num("trigger_health"),
    targetHealth: num("target_health"),
    strategy: v["strategy"] as Strategy,
    hlReduceFraction: num("hl_reduce_fraction", POLICY_DEFAULTS.hlReduceFraction),
    evmTriggerHealth: num("evm_trigger_health", POLICY_DEFAULTS.evmTriggerHealth),
    ...(Array.isArray(v["steps"]) ? { steps: v["steps"] as PolicyStep[] } : {}),
  };
}

function key32(k: Uint8Array | string, what: string): Uint8Array {
  const bytes = typeof k === "string" ? fromHex(k) : k;
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return bytes;
}

function sealKey(shared: Uint8Array, eph: Uint8Array, enclave: Uint8Array): Uint8Array {
  return sha256(concatBytes(SEAL_DOMAIN, shared, eph, enclave));
}

export interface SealOptions {
  /** The protected account the mandate is set on (the associated data). */
  account: string;
  /** The enclave's X25519 sealing key: 64 hex characters (the risk board's `sealing_key`) or bytes. */
  sealingPublicKey: string | Uint8Array;
  /** Fixed ephemeral secret and nonce, for test vectors only. Random by default. */
  ephemeralSecret?: Uint8Array;
  nonce?: Uint8Array;
}

/** Encrypts `policy` to the enclave for `account`. Returns the bytes the mandate's `sealed` carries. */
export function sealPolicy(policy: Policy, opts: SealOptions): Uint8Array {
  const enclave = key32(opts.sealingPublicKey, "sealing public key");
  const ephSecret = opts.ephemeralSecret ?? x25519.utils.randomSecretKey();
  const nonce = opts.nonce ?? randomBytes(12);
  if (ephSecret.length !== 32 || nonce.length !== 12) throw new Error("ephemeral secret is 32 bytes and nonce 12 bytes");
  const eph = x25519.getPublicKey(ephSecret);
  const k = sealKey(x25519.getSharedSecret(ephSecret, enclave), eph, enclave);
  const ct = chacha20poly1305(k, nonce, utf8(opts.account)).encrypt(utf8(policyJson(policy)));
  const sealed = concatBytes(eph, nonce, ct);
  if (sealed.length > MAX_SEALED_BYTES) throw new Error("sealed policy is larger than the contract's 2 KiB limit");
  return sealed;
}

/**
 * Opens a sealed policy with the enclave's X25519 secret. Only the enclave holds that secret;
 * this exists for tests and for tools run with a known test secret.
 */
export function openPolicy(sealed: Uint8Array | string, opts: { account: string; secret: Uint8Array | string }): Policy {
  const bytes = typeof sealed === "string" ? fromBase64(sealed) : sealed;
  if (bytes.length < HEADER + TAG) throw new Error("sealed policy too short");
  const secret = key32(opts.secret, "sealing secret");
  const eph = bytes.subarray(0, 32);
  const enclave = x25519.getPublicKey(secret);
  const k = sealKey(x25519.getSharedSecret(secret, eph), eph, enclave);
  let plain: Uint8Array;
  try {
    plain = chacha20poly1305(k, bytes.subarray(32, HEADER), utf8(opts.account)).decrypt(bytes.subarray(HEADER));
  } catch {
    throw new Error("sealed policy does not open with this key for this account");
  }
  return parsePolicy(fromUtf8(plain));
}
