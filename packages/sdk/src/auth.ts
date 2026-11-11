/**
 * Sign-in to the Parry API with a NEAR account's full-access key (NEP-413): the API checks the
 * signature against the protected account's owner on chain and returns a session token for the
 * routes that change a person's own data (settings, watched accounts, certificates).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ApiMethods } from "./api.js";
import { concatBytes, formatEd25519PublicKey, fromBase58, fromHex, toBase64, utf8 } from "./encoding.js";

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const str = (s: string) => concatBytes(u32(utf8(s).length), utf8(s));

/** NEP-413's signed payload: borsh of (tag 2^31 + 413, message, 32-byte nonce, recipient, no callback URL). */
export function nep413Payload(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  return concatBytes(u32(2 ** 31 + 413), str(message), nonce, str(recipient), Uint8Array.of(0));
}

/** Signs a NEP-413 message with an `ed25519:<base58>` secret key (64-byte or 32-byte seed form). */
export function signNep413(privateKey: string, message: string, nonce: Uint8Array, recipient: string): { publicKey: string; signature: string } {
  const raw = fromBase58(privateKey.replace(/^ed25519:/, ""));
  const seed = raw.subarray(0, 32);
  if (seed.length !== 32) throw new Error("not an ed25519 secret key");
  const signature = ed25519.sign(sha256(nep413Payload(message, nonce, recipient)), seed);
  return { publicKey: formatEd25519PublicKey(ed25519.getPublicKey(seed)), signature: toBase64(signature) };
}

/**
 * Signs in as protected account `accountId`, whose owner is the NEAR account holding
 * `privateKey` as a full-access key, and returns the session token (valid 12 hours).
 */
export async function signInNep413(api: Pick<ApiMethods, "authChallenge" | "authVerify">, accountId: string, privateKey: string): Promise<string> {
  const c = await api.authChallenge(accountId);
  const nep413 = signNep413(privateKey, c.message, fromHex(c.nonce), c.recipient);
  return (await api.authVerify({ accountId, nonce: c.nonce, nep413 })).token;
}
