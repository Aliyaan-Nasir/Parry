// Passkeys (WebAuthn, P-256): create one, sign an owner request or a sign-in challenge with it,
// and find the protected account of an existing passkey on a new device.

import { p256 } from "@noble/curves/nist.js";
import { useSyncExternalStore } from "react";
import { assertionFromWebAuthn, compressedPasskey, fromBase64, toBase64Url, type PasskeyAssertion } from "@parry/sdk";

export const PASSKEY_STORAGE_KEY = "parry-passkey";

/** What this browser remembers about the person's passkey. */
export interface StoredPasskey {
  /** The credential id, base64url. */
  credentialId: string;
  /** The compressed P-256 public key, 66 hex characters (the account's owner). */
  publicKey: string;
  /** The protected account the passkey owns, once created. */
  accountId: string | null;
}

export function isStoredPasskey(v: unknown): v is StoredPasskey {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.credentialId === "string" &&
    typeof o.publicKey === "string" &&
    /^0[23][0-9a-f]{64}$/.test(o.publicKey) &&
    (o.accountId === null || typeof o.accountId === "string")
  );
}

export function passkeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

const noSubscribe = () => () => {};

/** Whether this browser can use passkeys; null during the server render and hydration. */
export function usePasskeySupport(): boolean | null {
  return useSyncExternalStore(noSubscribe, passkeySupported, () => null);
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

/** Creates a passkey (ES256, a resident key when the authenticator can, user verification). */
export async function createPasskey(label: string): Promise<{ credentialId: string; publicKey: string }> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Parry", id: window.location.hostname },
      user: { id: randomBytes(16), name: label, displayName: label },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error("This browser did not return the passkey's public key.");
  if (response.getPublicKeyAlgorithm?.() !== -7) throw new Error("The passkey is not a P-256 key, which the account contract needs.");
  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), publicKey: compressedPasskey(new Uint8Array(spki)) };
}

type Assertion = { credential: PublicKeyCredential; response: AuthenticatorAssertionResponse };

async function getAssertion(challenge: Uint8Array, credentialId?: string): Promise<Assertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: copy(challenge),
      rpId: window.location.hostname,
      userVerification: "required",
      timeout: 120_000,
      ...(credentialId ? { allowCredentials: [{ type: "public-key", id: fromBase64Url(credentialId) }] } : {}),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey did not sign.");
  return { credential, response: credential.response as AuthenticatorAssertionResponse };
}

/** Signs `challenge` with the stored passkey, in the contract's assertion form. */
export async function signWithPasskey(challenge: Uint8Array, credentialId: string): Promise<PasskeyAssertion> {
  const { response } = await getAssertion(challenge, credentialId);
  return assertionFromWebAuthn({ response });
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy(bytes)));
}

/**
 * The two public keys an ECDSA P-256 signature can come from. A WebAuthn assertion does not carry
 * the public key, so on a new device the account is found by trying both candidates.
 */
export function recoverCandidates(digest: Uint8Array, der: Uint8Array): string[] {
  const sig = p256.Signature.fromBytes(der, "der");
  const out: string[] = [];
  for (const bit of [0, 1]) {
    try {
      const point = sig.addRecoveryBit(bit).recoverPublicKey(digest);
      out.push(compressedPasskey(point.toBytes(true)));
    } catch {
      // This recovery bit gives no point on the curve.
    }
  }
  return out;
}

/** Asks for any passkey of this site and returns its credential id and candidate public keys. */
export async function discoverPasskey(): Promise<{ credentialId: string; candidates: string[] }> {
  const { credential, response } = await getAssertion(randomBytes(32));
  const auth = new Uint8Array(response.authenticatorData);
  const clientHash = await sha256(new Uint8Array(response.clientDataJSON));
  const signed = new Uint8Array(auth.length + clientHash.length);
  signed.set(auth);
  signed.set(clientHash, auth.length);
  const digest = await sha256(signed);
  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), candidates: recoverCandidates(digest, new Uint8Array(response.signature)) };
}

/** True when the browser refused or the person dismissed the passkey prompt. */
export function isPasskeyCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");
}
