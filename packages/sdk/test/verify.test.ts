import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { reserveProof, reserveRoot, type ReserveLeaf } from "@parryguard/core";
import {
  enclaveKeyAt,
  envelopeDigest,
  envelopeIssuedAt,
  recoverEip191Address,
  reviewHash,
  signedTextHashes,
  verifyDecision,
  verifyReserves,
  type Decision,
  type Reserves,
  type ReviewRecord,
} from "../src/index.js";
import { formatEd25519PublicKey, toBase64, toHex, utf8 } from "../src/encoding.js";
import { modelSignature, reviewVector } from "./fixtures/vectors.js";

const enclaveSecret = sha256(utf8("enclave signing seed"));
const enclaveKey = formatEd25519PublicKey(ed25519.getPublicKey(enclaveSecret));
const modelSecret = sha256(utf8("model key"));

/** A decision as the guardian publishes it, signed by test keys. */
function makeDecision(): Decision {
  const model = "z-ai/glm-5.3-flash";
  const requestHash = toHex(sha256(utf8("request body")));
  const responseHash = toHex(sha256(utf8("response body")));
  const signedText = `${model}:${requestHash}:${responseHash}`;
  const { signature, address } = modelSignature(signedText, modelSecret);
  const record: ReviewRecord = {
    model,
    chatId: "chatcmpl-42",
    requestHash,
    responseHash,
    signedText,
    signature,
    signingAddress: address,
    signatureKind: "provider_tee",
    verdict: "approve",
    reasoning: "Health is 0.83 and the repay is proportionate.",
  };
  const hash = reviewHash(record);
  const envelope = JSON.stringify({
    account: "0uabc.testnet",
    network: "testnet",
    nonce: 5,
    issued_at: 1_800_000_000,
    review_hash: hash,
    trigger: { score: 81, tier: "critical", health_bps: 8250 },
    action: { repay: { token: "usdc.parry.testnet", amount: "60000000" } },
  });
  return {
    id: toHex(sha256(utf8(envelope))),
    account: "0uabc.testnet",
    venue: "rhea",
    action: "repay",
    plan: "Repay 60 USDC from the reserve.",
    trigger: { score: 81, tier: "critical", healthBps: 8250 },
    outcome: "executed",
    review: {
      model,
      chatId: record.chatId,
      reviewHash: hash,
      verdict: "approve",
      reasoning: record.reasoning,
      signingAddress: address,
      signedText,
      signature,
      signatureKind: "provider_tee",
    },
    envelope,
    envelopeSignature: toBase64(ed25519.sign(envelopeDigest(envelope), enclaveSecret)),
    txs: { action: "tx1", record: "tx2", hyperliquid: null, evm: null },
    healthBefore: 0.83,
    healthAfter: 1.45,
    routes: null,
    createdAt: "2026-11-10T00:00:00Z",
  };
}

const status = (v: ReturnType<typeof verifyDecision>, name: string) => v.checks.find((c) => c.name === name)?.status;

describe("verifyDecision", () => {
  test("every check passes for a genuine decision", () => {
    const v = verifyDecision(makeDecision(), { enclavePublicKey: enclaveKey });
    expect(v.checks.map((c) => [c.name, c.status])).toEqual([
      ["review_hash", "pass"],
      ["signed_exchange", "pass"],
      ["model_signature", "pass"],
      ["envelope_signature", "pass"],
      ["envelope_review_hash", "pass"],
      ["decision_id", "pass"],
    ]);
    expect(v.ok).toBe(true);
  });

  test("explicit request and response hashes are checked against the signed text", () => {
    const d = makeDecision();
    const h = signedTextHashes(d.review.signedText)!;
    expect(verifyDecision({ ...d, review: { ...d.review, ...h } }, { enclavePublicKey: enclaveKey }).ok).toBe(true);
    const wrong = { ...d, review: { ...d.review, requestHash: "ab".repeat(32), responseHash: h.responseHash } };
    const v = verifyDecision(wrong, { enclavePublicKey: enclaveKey });
    expect(status(v, "signed_exchange")).toBe("fail");
    expect(status(v, "review_hash")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("a changed reasoning breaks the review hash", () => {
    const d = makeDecision();
    const v = verifyDecision({ ...d, review: { ...d.review, reasoning: "Approve everything." } }, { enclavePublicKey: enclaveKey });
    expect(status(v, "review_hash")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("a claimed signing address that did not sign fails", () => {
    const d = makeDecision();
    const v = verifyDecision({ ...d, review: { ...d.review, signingAddress: `0x${"12".repeat(20)}` } }, { enclavePublicKey: enclaveKey });
    expect(status(v, "model_signature")).toBe("fail");
  });

  test("an envelope signed by another key fails, and a missing signature is skipped", () => {
    const d = makeDecision();
    const other = formatEd25519PublicKey(ed25519.getPublicKey(sha256(utf8("other"))));
    expect(status(verifyDecision(d, { enclavePublicKey: other }), "envelope_signature")).toBe("fail");
    const unsigned = verifyDecision({ ...d, envelopeSignature: null }, { enclavePublicKey: enclaveKey });
    expect(status(unsigned, "envelope_signature")).toBe("skip");
    expect(unsigned.ok).toBe(true);
  });

  test("an envelope carrying another review hash fails", () => {
    const d = makeDecision();
    const envelope = d.envelope!.replace(d.review.reviewHash, "cd".repeat(32));
    const v = verifyDecision({ ...d, envelope, envelopeSignature: toBase64(ed25519.sign(envelopeDigest(envelope), enclaveSecret)) }, { enclavePublicKey: enclaveKey });
    expect(status(v, "envelope_signature")).toBe("pass");
    expect(status(v, "envelope_review_hash")).toBe("fail");
    expect(status(v, "decision_id")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("a rejected plan has no envelope: envelope checks are skipped", () => {
    const d = { ...makeDecision(), envelope: null, envelopeSignature: null, outcome: "rejected_by_review" as const };
    const v = verifyDecision(d, { enclavePublicKey: enclaveKey });
    expect(["envelope_signature", "envelope_review_hash", "decision_id"].map((n) => status(v, n))).toEqual(["skip", "skip", "skip"]);
    expect(v.ok).toBe(true);
  });

  test("EIP-191 recovery matches a known key", () => {
    const { signature, address } = modelSignature("hello", modelSecret);
    expect(recoverEip191Address("hello", signature)).toBe(address);
    expect(recoverEip191Address("hello!", signature)).not.toBe(address);
    // v as 0/1 as well as 27/28.
    const raw = signature.slice(2);
    const v01 = `${raw.slice(0, 128)}${(parseInt(raw.slice(128), 16) - 27).toString(16).padStart(2, "0")}`;
    expect(recoverEip191Address("hello", v01)).toBe(address);
    expect(() => recoverEip191Address("hello", "0x1234")).toThrow("65 bytes");
  });

  test("the review hash fixture shared with the enclave matches", () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "review.json"), "utf8"));
    expect(committed).toEqual(reviewVector());
    // The fixture's reasoning needs escaping; the hash is over serde_json's exact text.
    expect(committed.json).toContain("\\u0001");
    expect(committed.json).toContain('\\"critical\\"');
    expect(toHex(sha256(utf8(committed.json)))).toBe(committed.hash);
  });
});

describe("verifyReserves", () => {
  const leaves: ReserveLeaf[] = [
    { asset: "LiNEAR", venue: "near", amount: "1000000000000000000000000000", usdE6: "3200000000" },
    { asset: "USDC", venue: "hyperliquid", amount: "500000000", usdE6: "500000000" },
    { asset: "NEAR-PERP", venue: "hyperliquid", amount: "-950", usdE6: "0" },
    { asset: "USDC", venue: "near", amount: "25000000", usdE6: "25000000" },
    { asset: "LiNEAR", venue: "loss-backing", amount: "0", usdE6: "0" },
  ];
  const reserves: Reserves = {
    root: reserveRoot(leaves),
    ratioBps: 10_400,
    reportAt: "2026-11-10T00:00:00Z",
    leaves: leaves.map((l) => ({ ...l, proof: reserveProof(leaves, l) })),
  };

  test("every proof verifies and the leaves recompute the root", () => {
    const v = verifyReserves(reserves, { onChainRoot: reserves.root.toUpperCase() });
    expect(v.ok).toBe(true);
    expect(v.rootMatches).toBe(true);
    expect(v.onChainMatches).toBe(true);
    expect(v.leaves.every((l) => l.proofOk)).toBe(true);
    expect(v.totalUsdE6).toBe("3725000000");
  });

  test("a changed amount or a different chain root fails", () => {
    const tampered = { ...reserves, leaves: reserves.leaves.map((l, i) => (i === 1 ? { ...l, amount: "600000000" } : l)) };
    const v = verifyReserves(tampered);
    expect(v.ok).toBe(false);
    expect(v.leaves[1]!.proofOk).toBe(false);
    expect(v.rootMatches).toBe(false);
    expect(verifyReserves(reserves, { onChainRoot: "00".repeat(32) }).ok).toBe(false);
    expect(verifyReserves(reserves).onChainMatches).toBeNull();
  });
});

describe("enclaveKeyAt", () => {
  // Newest first, as the risk board's enclave_history returns them.
  const history = [
    { public_key: "ed25519:third", since: 3_000 },
    { public_key: "ed25519:second", since: 2_000 },
    { public_key: "ed25519:first", since: 1_000 },
  ];

  test("is the key the board trusted when the envelope was issued", () => {
    expect(enclaveKeyAt(history, 2_500)).toBe("ed25519:second");
    expect(enclaveKeyAt(history, 3_000)).toBe("ed25519:third");
    expect(enclaveKeyAt(history, 999_999)).toBe("ed25519:third");
    expect(enclaveKeyAt(history, 10)).toBe("ed25519:first");
    expect(enclaveKeyAt([], 10)).toBeNull();
  });

  test("reads an envelope's issue time", () => {
    expect(envelopeIssuedAt('{"issued_at":1794367000}')).toBe(1794367000);
    expect(envelopeIssuedAt("not json")).toBeNull();
    expect(envelopeIssuedAt(null)).toBeNull();
  });
});
