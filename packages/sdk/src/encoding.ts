/**
 * Byte encodings used across Parry's wire formats, written without Node's Buffer so the SDK
 * runs unchanged in browsers, Node and Bun.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (s: string): Uint8Array => textEncoder.encode(s);
export const fromUtf8 = (b: Uint8Array): string => textDecoder.decode(b);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Lowercase or uppercase hex, with or without `0x`. */
export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const));

/** Standard base64 with padding (what near-sdk's `Base64VecU8` reads and writes). */
export function toBase64(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < b.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < b.length ? B64[n & 63]! : "=";
  }
  return out;
}

/** Standard or URL-safe base64, padded or not. */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (clean.length % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of clean) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new Error("invalid base64 character");
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/** base64url without padding (WebAuthn's encoding). */
export const toBase64Url = (b: Uint8Array): string => toBase64(b).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i] as const));

export function toBase58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function fromBase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(v);
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

/** The 32 key bytes of `ed25519:<base58>`. */
export function parseEd25519PublicKey(key: string): Uint8Array {
  if (!key.startsWith("ed25519:")) throw new Error("expected an ed25519:<base58> public key");
  const bytes = fromBase58(key.slice("ed25519:".length));
  if (bytes.length !== 32) throw new Error("an ed25519 public key is 32 bytes");
  return bytes;
}

export const formatEd25519PublicKey = (bytes: Uint8Array): string => `ed25519:${toBase58(bytes)}`;

/** Bytes from an ArrayBuffer, a typed array or a DataView. */
export function asBytes(b: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(b);
}

/** A non-negative integer as a decimal string (u128 / u64 JSON). */
export function u128(value: string | number | bigint, field = "amount"): string {
  let n: bigint;
  try {
    n = typeof value === "bigint" ? value : BigInt(typeof value === "number" ? Math.trunc(value) : value.trim());
  } catch {
    throw new Error(`${field} must be a non-negative integer`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer or a decimal string`);
  if (n < 0n || n >= 1n << 128n) throw new Error(`${field} must be a non-negative integer below 2^128`);
  return n.toString();
}

/** Decimal NEAR (for example "0.5") to yoctoNEAR. */
export function nearToYocto(near: string | number): bigint {
  // String(0.1) is "0.1" (the shortest round trip), where toFixed would expose binary noise.
  const s = typeof near === "number" ? String(near) : near.trim();
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(s);
  if (!m) throw new Error("NEAR amount must be a non-negative decimal with at most 24 decimals");
  return BigInt(m[1]!) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
}

/** yoctoNEAR to a decimal NEAR string without trailing zeros. */
export function yoctoToNear(yocto: string | bigint): string {
  const n = BigInt(yocto);
  const whole = n / 10n ** 24n;
  const frac = (n % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
