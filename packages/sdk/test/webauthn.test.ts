import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { assertionFromWebAuthn, compressedPasskey, derToRawSignature, ownerActions, ownerRequest } from "../src/index.js";
import { concatBytes, fromBase64, fromHex, toBase58, toHex, utf8 } from "../src/encoding.js";

const N = p256.Point.Fn.ORDER;

/** What a platform authenticator does for `navigator.credentials.get`. */
function authenticate(secret: Uint8Array, challengeB64Url: string, opts: { highS?: boolean } = {}) {
  const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: challengeB64Url, origin: "https://parry.example", crossOrigin: false }));
  // 32-byte rp id hash, flags (user present | user verified), 4-byte counter.
  const authenticatorData = concatBytes(sha256(utf8("parry.example")), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, 9));
  const signed = concatBytes(authenticatorData, sha256(clientDataJSON));
  // The authenticator hashes the signed bytes once (prehash), as WebAuthn's ES256 does.
  let sig = p256.Signature.fromBytes(p256.sign(signed, secret, { lowS: false }), "compact");
  if (opts.highS && sig.s <= N / 2n) sig = new p256.Signature(sig.r, N - sig.s);
  if (!opts.highS && sig.s > N / 2n) sig = new p256.Signature(sig.r, N - sig.s);
  return {
    // ArrayBuffers, as the browser gives them.
    response: {
      authenticatorData: authenticatorData.slice().buffer,
      clientDataJSON: clientDataJSON.slice().buffer,
      signature: sig.toBytes("der").slice().buffer,
    },
  };
}

/** The contract's check (passkey.rs): flags, challenge, then p256_verify over the prehash. */
function contractVerifies(assertion: ReturnType<typeof assertionFromWebAuthn>, challenge: Uint8Array, compressed: string): boolean {
  const auth = fromBase64(assertion.authenticator_data);
  if (auth.length < 37 || (auth[32]! & 0x05) !== 0x05) return false;
  const client = JSON.parse(assertion.client_data_json) as { type: string; challenge: string };
  const challengeB64Url = Buffer.from(challenge).toString("base64url");
  if (client.type !== "webauthn.get" || client.challenge !== challengeB64Url) return false;
  const sig = fromHex(assertion.signature);
  if (sig.length !== 64) return false;
  const digest = sha256(concatBytes(auth, sha256(utf8(assertion.client_data_json))));
  return p256.verify(sig, digest, fromHex(compressed), { prehash: false });
}

describe("WebAuthn assertions", () => {
  const secret = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secret, true);
  const request = ownerRequest({ account: "0u1234.testnet", network: "testnet", nonce: 7, createdAt: 1_800_000_000, actions: [ownerActions.revokeMandate()] });

  test("converts a DER passkey signature into the contract's assertion, which verifies", () => {
    for (let i = 0; i < 8; i++) {
      const credential = authenticate(secret, request.challengeBase64Url, { highS: i % 2 === 1 });
      const assertion = assertionFromWebAuthn(credential);
      expect(assertion.signature).toMatch(/^[0-9a-f]{128}$/);
      expect(assertion.authenticator_data).not.toMatch(/[=+/]/);
      expect(assertion.client_data_json).toBe(new TextDecoder().decode(credential.response.clientDataJSON));
      // Low s, always.
      expect(BigInt(`0x${assertion.signature.slice(64)}`) <= N / 2n).toBe(true);
      expect(contractVerifies(assertion, request.challenge, compressedPasskey(publicKey))).toBe(true);
      // And strict low-s verification (noble's default) accepts it too.
      const digest = sha256(concatBytes(fromBase64(assertion.authenticator_data), sha256(utf8(assertion.client_data_json))));
      expect(p256.verify(fromHex(assertion.signature), digest, publicKey, { prehash: false })).toBe(true);
    }
  });

  test("a signature over another request does not verify", () => {
    const other = ownerRequest({ account: "0u1234.testnet", network: "testnet", nonce: 8, createdAt: 1_800_000_000, actions: ["revoke_mandate"] });
    const assertion = assertionFromWebAuthn(authenticate(secret, other.challengeBase64Url));
    expect(contractVerifies(assertion, request.challenge, compressedPasskey(publicKey))).toBe(false);
  });

  test("high-s DER is normalized", () => {
    const msg = sha256(utf8("m"));
    let sig = p256.Signature.fromBytes(p256.sign(msg, secret, { prehash: false, lowS: false }), "compact");
    if (sig.s <= N / 2n) sig = new p256.Signature(sig.r, N - sig.s);
    const raw = derToRawSignature(sig.toBytes("der"));
    expect(toHex(raw.subarray(0, 32))).toBe(sig.r.toString(16).padStart(64, "0"));
    expect(BigInt(`0x${toHex(raw.subarray(32))}`)).toBe(N - sig.s);
    expect(p256.verify(raw, msg, publicKey, { prehash: false })).toBe(true);
  });

  test("passkey public keys in every form compress to the factory's 66 hex", () => {
    const want = toHex(publicKey);
    const uncompressed = p256.getPublicKey(secret, false);
    const spki = concatBytes(fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200"), uncompressed);
    expect(compressedPasskey(publicKey)).toBe(want);
    expect(compressedPasskey(uncompressed)).toBe(want);
    expect(compressedPasskey(spki)).toBe(want);
    expect(compressedPasskey(spki.slice().buffer)).toBe(want);
    expect(compressedPasskey(toHex(uncompressed))).toBe(want);
    expect(compressedPasskey(`p256:${toBase58(publicKey)}`)).toBe(want);
    expect(() => compressedPasskey("04abcd")).toThrow();
  });
});
