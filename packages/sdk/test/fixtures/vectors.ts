/**
 * Cross-language test vectors. The enclave's Rust tests (enclave/tests/seal_vector.rs and
 * review_vector.rs) read the JSON files these produce; `bun test/fixtures/write.ts` rewrites them,
 * and the SDK tests check the committed files still match.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, toBase64, toHex, utf8 } from "../../src/encoding.js";
import { policyJson, sealPolicy, type Policy } from "../../src/seal.js";
import { reviewHash, reviewJson, type ReviewRecord } from "../../src/verify.js";

const seed = (label: string) => sha256(utf8(`parry-test-vector:${label}`));

export function sealedVector() {
  const enclaveSecret = seed("enclave-seal-secret");
  const ephemeralSecret = seed("ephemeral");
  const nonce = seed("nonce").subarray(0, 12);
  const account = "0u3f9a1c2b7d.testnet";
  const policy: Policy = {
    triggerScore: 55,
    triggerHealth: 1.15,
    targetHealth: 2,
    strategy: "keep-exposure",
    hlReduceFraction: 0.000001,
    evmTriggerHealth: 1.3,
  };
  const enclavePublicKey = x25519.getPublicKey(enclaveSecret);
  const sealed = sealPolicy(policy, { account, sealingPublicKey: enclavePublicKey, ephemeralSecret, nonce });
  return {
    note: "Written by packages/sdk/test/fixtures/write.ts; read by enclave/tests/seal_vector.rs.",
    enclave_secret: toHex(enclaveSecret),
    enclave_public_key: toHex(enclavePublicKey),
    ephemeral_secret: toHex(ephemeralSecret),
    nonce: toHex(nonce),
    account,
    policy: {
      trigger_score: policy.triggerScore,
      trigger_health: policy.triggerHealth,
      target_health: policy.targetHealth,
      strategy: policy.strategy,
      hl_reduce_fraction: policy.hlReduceFraction,
      evm_trigger_health: policy.evmTriggerHealth,
    },
    plaintext: policyJson(policy),
    sealed: toBase64(sealed),
  };
}

/** A model signature as a NEAR AI TEE gives it: EIP-191 over `model:request_hash:response_hash`. */
export function modelSignature(text: string, secret: Uint8Array) {
  const message = utf8(text);
  const digest = keccak_256(concatBytes(utf8(`\x19Ethereum Signed Message:\n${message.length}`), message));
  const rec = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  // noble puts the recovery bit first; EIP-191 signatures put it last as 27 or 28.
  const sig = concatBytes(rec.subarray(1), Uint8Array.of(rec[0]! + 27));
  const pub = secp256k1.getPublicKey(secret, false);
  return { signature: `0x${toHex(sig)}`, address: `0x${toHex(keccak_256(pub.subarray(1)).subarray(12))}` };
}

export function reviewVector() {
  const model = "z-ai/glm-5.3-flash";
  const requestHash = toHex(sha256(utf8('{"model":"z-ai/glm-5.3-flash","messages":[]}')));
  const responseHash = toHex(sha256(utf8('{"id":"chatcmpl-7","choices":[]}')));
  const signedText = `${model}:${requestHash}:${responseHash}`;
  const { signature, address } = modelSignature(signedText, seed("model-key"));
  const record: ReviewRecord = {
    model,
    chatId: "chatcmpl-7",
    requestHash,
    responseHash,
    signedText,
    signature,
    signingAddress: address,
    signatureKind: "provider_tee",
    verdict: "approve",
    // Quotes, backslashes, control characters, non-ASCII and U+2028 exercise both JSON writers.
    reasoning: 'Health 0.82 is "critical"; repay 60 USDC \\ reserve.\nNext:\tok \u0001 café 漢 \u{1F600}   end/',
  };
  return {
    note: "Written by packages/sdk/test/fixtures/write.ts; read by enclave/tests/review_vector.rs.",
    review: {
      model: record.model,
      chat_id: record.chatId,
      request_hash: record.requestHash,
      response_hash: record.responseHash,
      signed_text: record.signedText,
      signature: record.signature,
      signing_address: record.signingAddress,
      signature_kind: record.signatureKind,
      verdict: record.verdict,
      reasoning: record.reasoning,
    },
    json: reviewJson(record),
    hash: reviewHash(record),
  };
}
