/**
 * WebAuthn (passkey) assertions in the form the protected account checks on chain.
 *
 * The authenticator signs SHA-256(authenticatorData || SHA-256(clientDataJSON)) with P-256 and
 * the browser returns the signature in DER; the contract wants 64-byte r || s in hex, with s in
 * the lower half of the group order.
 */

import { p256 } from "@noble/curves/nist.js";
import { asBytes, fromBase58, fromHex, fromUtf8, toBase64Url, toHex } from "./encoding.js";
import type { PasskeyAssertion } from "./types.js";

type Binary = ArrayBuffer | ArrayBufferView;

/** The parts of a browser `PublicKeyCredential` (from `navigator.credentials.get`) this reads. */
export interface WebAuthnAssertionCredential {
  response: {
    authenticatorData: Binary;
    clientDataJSON: Binary;
    signature: Binary;
  };
}

const N = p256.Point.Fn.ORDER;

/** A DER ECDSA P-256 signature as 64-byte r || s, with s normalized to the low half. */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  const sig = p256.Signature.fromBytes(der, "der");
  const s = sig.s > N / 2n ? N - sig.s : sig.s;
  return new p256.Signature(sig.r, s).toBytes("compact");
}

/** Converts a passkey assertion from the browser into the contract's `Assertion`. */
export function assertionFromWebAuthn(credential: WebAuthnAssertionCredential): PasskeyAssertion {
  const r = credential.response;
  return {
    authenticator_data: toBase64Url(asBytes(r.authenticatorData)),
    client_data_json: fromUtf8(asBytes(r.clientDataJSON)),
    signature: toHex(derToRawSignature(asBytes(r.signature))),
  };
}

/** DER prefix of a P-256 SubjectPublicKeyInfo (what `AuthenticatorAttestationResponse.getPublicKey()` returns). */
const SPKI_P256_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";

/**
 * A P-256 public key as the factory reads it (66 hex characters, compressed). Accepts compressed
 * or uncompressed bytes, a SubjectPublicKeyInfo from a passkey registration, hex, or
 * `p256:<base58>`.
 */
export function compressedPasskey(key: Uint8Array | ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof key === "string") bytes = key.startsWith("p256:") ? fromBase58(key.slice(5)) : fromHex(key);
  else bytes = asBytes(key);
  if (bytes.length === 91 && toHex(bytes.subarray(0, 26)) === SPKI_P256_PREFIX) bytes = bytes.subarray(26);
  const point = p256.Point.fromBytes(bytes);
  return toHex(point.toBytes(true));
}
