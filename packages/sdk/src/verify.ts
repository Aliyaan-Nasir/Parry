/**
 * Independent checks of what Parry publishes: a guardian decision (the model review, its
 * signature, and the enclave-signed envelope that carried it on chain) and the vault's proof of
 * reserves. Nothing here trusts the API: every check is recomputed from the published bytes.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { leafHash, reserveRoot, verifyReserveProof } from "@parryguard/core";
import { concatBytes, fromBase64, fromHex, parseEd25519PublicKey, toHex, utf8 } from "./encoding.js";
import type { Decision, Reserves } from "./types.js";

export const ENVELOPE_DOMAIN = "parry-guardian:v1:";

/** The enclave's `Review` record, in its Rust field order. */
export interface ReviewRecord {
  model: string;
  chatId: string;
  requestHash: string;
  responseHash: string;
  signedText: string;
  signature: string;
  signingAddress: string;
  signatureKind: string;
  verdict: string;
  reasoning: string;
}

/** The exact JSON the enclave hashes (`serde_json::to_string(&review)`). */
export function reviewJson(r: ReviewRecord): string {
  // JSON.stringify escapes strings exactly as serde_json does (\", \\, \b \f \n \r \t, other
  // control characters as lowercase \u00XX, everything else verbatim), and keeps key order.
  return JSON.stringify({
    model: r.model,
    chat_id: r.chatId,
    request_hash: r.requestHash,
    response_hash: r.responseHash,
    signed_text: r.signedText,
    signature: r.signature,
    signing_address: r.signingAddress,
    signature_kind: r.signatureKind,
    verdict: r.verdict,
    reasoning: r.reasoning,
  });
}

/** SHA-256 (hex) of the review record: the `review_hash` the account emits with the action. */
export const reviewHash = (r: ReviewRecord): string => toHex(sha256(utf8(reviewJson(r))));

/** SHA-256("parry-guardian:v1:" ++ envelope text): the digest the enclave signs. */
export const envelopeDigest = (envelope: string): Uint8Array => sha256(concatBytes(utf8(ENVELOPE_DOMAIN), utf8(envelope)));

/** The EIP-191 (personal_sign) address that signed `text`, lowercase `0x` hex. */
export function recoverEip191Address(text: string, signatureHex: string): string {
  const sig = fromHex(signatureHex);
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  const message = utf8(text);
  const digest = keccak_256(concatBytes(utf8(`\x19Ethereum Signed Message:\n${message.length}`), message));
  const v = sig[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery > 3) throw new Error("bad recovery id");
  const compact = concatBytes(Uint8Array.of(recovery), sig.subarray(0, 64));
  const pub = secp256k1.recoverPublicKey(compact, digest, { prehash: false });
  const point = secp256k1.Point.fromBytes(pub).toBytes(false);
  return `0x${toHex(keccak_256(point.subarray(1)).subarray(12))}`;
}

const HASH = /^[0-9a-f]{64}$/;

/** The request and response hashes at the end of a model signature's text (`[model:]req:resp`). */
export function signedTextHashes(text: string): { requestHash: string; responseHash: string } | null {
  const parts = text.split(":");
  if (parts.length < 2) return null;
  const responseHash = parts[parts.length - 1]!;
  const requestHash = parts[parts.length - 2]!;
  return HASH.test(requestHash) && HASH.test(responseHash) ? { requestHash, responseHash } : null;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface DecisionCheck {
  name:
    | "review_hash"
    | "signed_exchange"
    | "model_signature"
    | "envelope_signature"
    | "envelope_review_hash"
    | "decision_id"
    | "decision_record_signature"
    | "decision_record"
    | "reasoning_hash"
    | "facts";
  status: CheckStatus;
  detail: string;
}

export interface DecisionVerification {
  id: string;
  /**
   * True when no check failed and the model's signature checks passed (and, on the owner's full
   * record, the review hash recomputed).
   */
  ok: boolean;
  /**
   * "public": the record anyone may read, so the checks that need the owner's private text (the
   * review hash over the reasoning, the reasoning hash, the facts) are skipped and say so.
   * "owner": the full record, every check ran.
   */
  scope: "public" | "owner";
  checks: DecisionCheck[];
}

/** The risk board's record of a decision (`decision(id).report`, or the signed `decisionJson`). */
export interface DecisionRecord {
  id: string;
  account: string;
  action: string;
  plan: string;
  envelope_hash?: string;
  at?: number;
  review: { review_hash: string; reasoning_hash?: string; verdict?: string; model?: string };
}

/** The domain the enclave signs risk-board reports under. */
export const RISK_DOMAIN = "parry-risk:v1:";

/** SHA-256("parry-risk:v1:" ++ report text): the digest the enclave signs for the risk board. */
export const reportDigest = (report: string): Uint8Array => sha256(concatBytes(utf8(RISK_DOMAIN), utf8(report)));

/** The record's `at` (unix seconds), or null when it does not parse. */
export function decisionRecordAt(decisionJson: string | null | undefined): number | null {
  try {
    const t = (JSON.parse(decisionJson ?? "") as { at?: unknown }).at;
    return typeof t === "number" ? t : null;
  } catch {
    return null;
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/**
 * Verifies a guardian decision:
 * 1. the review hash recomputed from the review fields equals `reviewHash`;
 * 2. the model's signed text ends with `requestHash:responseHash`;
 * 3. EIP-191 recovery of the model's signature equals `signingAddress`;
 * 4. the envelope's ed25519 signature verifies with the enclave key (when published);
 * 5. the envelope's `review_hash` equals the review hash;
 * 6. the decision id is the SHA-256 of the envelope.
 */
/**
 * The enclave key that was in force when an envelope was issued: the newest key in the board's
 * history (any order) trusted at or before `issuedAt` (unix seconds), else the oldest.
 */
export function enclaveKeyAt(history: readonly { public_key: string; since: number }[], issuedAt: number): string | null {
  const sorted = [...history].sort((a, b) => a.since - b.since);
  const inForce = sorted.filter((k) => k.since <= issuedAt).pop();
  return (inForce ?? sorted[0])?.public_key ?? null;
}

/** An envelope's `issued_at` (unix seconds), or null when it does not parse. */
export function envelopeIssuedAt(envelope: string | null | undefined): number | null {
  try {
    const t = (JSON.parse(envelope ?? "") as { issued_at?: unknown }).issued_at;
    return typeof t === "number" ? t : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a guardian decision. On the public record (anyone's view) it checks what is public:
 * the model's signature over the exchange, the enclave's signatures over the envelope and over
 * the public risk-board record, that they agree with each other and with the board's copy on
 * chain (`onChainRecord`), and the decision id. On the owner's full record it also recomputes the
 * review hash over the reasoning, the reasoning hash the board recorded, and the facts the review
 * saw against the plan and the envelope. Every check that could not run says why.
 *
 * `recordPublicKey` is the enclave key in force when the record was signed (defaults to
 * `enclavePublicKey`).
 */
export function verifyDecision(
  decision: Decision,
  opts: { enclavePublicKey?: string | null; recordPublicKey?: string | null; onChainRecord?: DecisionRecord | null },
): DecisionVerification {
  const checks: DecisionCheck[] = [];
  const add = (name: DecisionCheck["name"], status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const r = decision.review;
  const full = typeof r.reasoning === "string";

  const fromText = signedTextHashes(r.signedText);
  const requestHash = r.requestHash ?? fromText?.requestHash;
  const responseHash = r.responseHash ?? fromText?.responseHash;
  const derived = r.requestHash === undefined || r.responseHash === undefined;

  // 1. Review hash (over the whole review, the reasoning included: the owner's record only).
  let computed: string | null = null;
  if (!full) {
    add("review_hash", "skip", "the review's reasoning is private to the account's owner, so its hash is not recomputed here; the envelope and the chain carry the hash, checked below");
  } else if (requestHash === undefined || responseHash === undefined) {
    add("review_hash", "fail", "the review has no request and response hashes and its signed text does not end with them");
  } else {
    computed = reviewHash({ ...r, reasoning: r.reasoning!, requestHash, responseHash });
    if (computed === r.reviewHash.toLowerCase()) add("review_hash", "pass", `SHA-256 of the review record is ${computed}`);
    else add("review_hash", "fail", `SHA-256 of the review record is ${computed}, the decision says ${r.reviewHash}`);
  }

  // 2. The signature covers this exchange.
  if (requestHash !== undefined && responseHash !== undefined && r.signedText.endsWith(`${requestHash}:${responseHash}`)) {
    add("signed_exchange", "pass", derived ? "request and response hashes read from the signed text" : "the signed text ends with request_hash:response_hash");
  } else {
    add("signed_exchange", "fail", "the signed text does not end with request_hash:response_hash");
  }

  // 3. Model signature.
  try {
    const address = recoverEip191Address(r.signedText, r.signature);
    if (address === r.signingAddress.toLowerCase()) add("model_signature", "pass", `EIP-191 signature recovers to ${address}`);
    else add("model_signature", "fail", `EIP-191 signature recovers to ${address}, not ${r.signingAddress}`);
  } catch (e) {
    add("model_signature", "fail", `signature does not recover: ${(e as Error).message}`);
  }

  // 4. Envelope signature.
  const envelope = decision.envelope;
  if (!envelope) add("envelope_signature", "skip", "no envelope (the review rejected the plan or it is pending)");
  else if (!decision.envelopeSignature) add("envelope_signature", "skip", "the envelope signature is not published with this decision");
  else if (!opts.enclavePublicKey) add("envelope_signature", "skip", "no enclave public key given");
  else {
    try {
      const ok = ed25519.verify(fromBase64(decision.envelopeSignature), envelopeDigest(envelope), parseEd25519PublicKey(opts.enclavePublicKey));
      add("envelope_signature", ok ? "pass" : "fail", ok ? `signed by ${opts.enclavePublicKey}` : `not signed by ${opts.enclavePublicKey}`);
    } catch (e) {
      add("envelope_signature", "fail", `bad envelope signature: ${(e as Error).message}`);
    }
  }

  // 5. The envelope carries this review.
  if (!envelope) add("envelope_review_hash", "skip", "no envelope");
  else {
    let inEnvelope: unknown;
    try {
      inEnvelope = (JSON.parse(envelope) as { review_hash?: unknown }).review_hash;
    } catch {
      inEnvelope = undefined;
    }
    const want = computed ?? r.reviewHash.toLowerCase();
    if (inEnvelope === want) add("envelope_review_hash", "pass", "the envelope's review_hash is the review's hash");
    else add("envelope_review_hash", "fail", `the envelope's review_hash is ${String(inEnvelope)}, the review hashes to ${want}`);
  }

  // 6. The decision id is the envelope hash.
  if (!envelope) add("decision_id", "skip", "no envelope");
  else {
    const h = toHex(sha256(utf8(envelope)));
    if (h === decision.id.toLowerCase()) add("decision_id", "pass", "the id is the SHA-256 of the envelope");
    else add("decision_id", "fail", `the envelope hashes to ${h}, the id is ${decision.id}`);
  }

  // 7. The enclave's signature over the public risk-board record.
  let signedRecord: DecisionRecord | null = null;
  const recordKey = opts.recordPublicKey ?? opts.enclavePublicKey ?? null;
  if (!decision.decisionJson || !decision.decisionSignature) {
    add(
      "decision_record_signature",
      "skip",
      decision.txs?.record
        ? "the signed record is not published with this decision (a record an earlier enclave build signed names the owner's plan, so it goes only to the owner; the risk board's copy is checked below)"
        : "no risk-board record (the review rejected the plan or it is pending)",
    );
  } else if (!recordKey) add("decision_record_signature", "skip", "no enclave public key given");
  else {
    try {
      signedRecord = JSON.parse(decision.decisionJson) as DecisionRecord;
      const ok = ed25519.verify(fromBase64(decision.decisionSignature), reportDigest(decision.decisionJson), parseEd25519PublicKey(recordKey));
      add("decision_record_signature", ok ? "pass" : "fail", ok ? `the risk-board record is signed by ${recordKey}` : `the risk-board record is not signed by ${recordKey}`);
    } catch (e) {
      add("decision_record_signature", "fail", `bad record or signature: ${(e as Error).message}`);
    }
  }

  // 8. The record (signed, or the board's copy on chain) names this decision and this review.
  const record = signedRecord ?? opts.onChainRecord ?? null;
  const stated = computed ?? r.reviewHash.toLowerCase();
  if (!record) add("decision_record", "skip", opts.onChainRecord === undefined ? "the risk board's record was not read" : "the risk board has no record of this decision");
  else {
    const where = signedRecord ? "the signed record" : "the risk board's record";
    const wrong: string[] = [];
    if (record.id !== decision.id) wrong.push(`id ${record.id}`);
    if (record.account !== decision.account) wrong.push(`account ${record.account}`);
    if (record.action !== decision.action) wrong.push(`action ${record.action}`);
    if (record.review.review_hash !== stated) wrong.push(`review hash ${record.review.review_hash}`);
    if (signedRecord && opts.onChainRecord && !sameJson(boardShape(signedRecord), opts.onChainRecord)) wrong.push("the board's copy on chain differs from the signed record");
    if (decision.publicPlan && isPublicRecordPlan(record.plan) && record.plan !== decision.publicPlan) wrong.push("its plan is not this decision's public plan");
    if (wrong.length) add("decision_record", "fail", `${where} differs: ${wrong.join("; ")}`);
    else add("decision_record", "pass", `${where} names this decision, account, action and review hash${signedRecord && opts.onChainRecord ? ", and the board's copy on chain is the same" : ""}`);
  }

  // 9. The reasoning hashes to what the board recorded (owner's record only).
  const recorded = record?.review.reasoning_hash;
  if (!full) add("reasoning_hash", "skip", "the review's reasoning is private to the account's owner");
  else if (!recorded) add("reasoning_hash", "skip", "no recorded reasoning hash to compare with");
  else {
    const h = toHex(sha256(utf8(r.reasoning!)));
    add("reasoning_hash", h === recorded ? "pass" : "fail", h === recorded ? "the reasoning hashes to the recorded reasoning_hash" : `the reasoning hashes to ${h}, the record says ${recorded}`);
  }

  // 10. The facts the review saw agree with the plan and the envelope (owner's record only).
  const facts = decision.facts;
  if (!facts) add("facts", "skip", full ? "no facts were kept with this decision" : "the facts the review saw (the sealed target and trigger among them) are private to the account's owner");
  else {
    const wrong: string[] = [];
    if (facts.account !== decision.account) wrong.push("account");
    if (typeof facts.plan === "string" && facts.plan !== decision.plan && !decision.plan.startsWith(facts.plan)) wrong.push("plan");
    if (envelope && facts.proposed_action !== undefined) {
      try {
        if (!sameJson(facts.proposed_action, (JSON.parse(envelope) as { action?: unknown }).action)) wrong.push("proposed action");
      } catch {
        wrong.push("envelope");
      }
    }
    add("facts", wrong.length ? "fail" : "pass", wrong.length ? `the facts differ from the decision: ${wrong.join(", ")}` : "the facts the review saw name this account, plan and envelope action");
  }

  const failed = checks.some((c) => c.status === "fail");
  const needed = full ? ["review_hash", "signed_exchange", "model_signature"] : ["signed_exchange", "model_signature"];
  const reviewPassed = needed.every((n) => checks.find((c) => c.name === n)?.status === "pass");
  return { id: decision.id, ok: !failed && reviewPassed, scope: full ? "owner" : "public", checks };
}

/** A record plan with nothing of the owner's policy in it (records from earlier builds carry the full plan). */
const isPublicRecordPlan = (plan: string) => !/\b(target|trigger|order|health|chose)\b/i.test(plan);

export interface ReservesVerification {
  /** Every leaf proof verifies and the leaves recompute the published root. */
  ok: boolean;
  root: string;
  /** The root recomputed from all published leaves. */
  recomputedRoot: string;
  rootMatches: boolean;
  /** When `onChainRoot` was given: whether it equals the published root. */
  onChainMatches: boolean | null;
  leaves: { asset: string; venue: string; amount: string; usdE6: string; hash: string; proofOk: boolean }[];
  totalUsdE6: string;
}

/**
 * The signed record as the risk board stores it: the board reads the report through its `kind`
 * tag and keeps the rest, so the tag is not in its copy. A record of any other kind never matches.
 */
function boardShape(signed: object): object {
  const { kind, ...rest } = signed as { kind?: unknown };
  return kind === undefined || kind === "decision" ? rest : { kind, ...rest };
}

/** Checks every reserve leaf's Merkle proof against the published root (and the chain's root). */
export function verifyReserves(reserves: Reserves, opts: { onChainRoot?: string | null } = {}): ReservesVerification {
  const root = reserves.root.toLowerCase();
  const leaves = reserves.leaves.map((l) => {
    const leaf = { asset: l.asset, venue: l.venue, amount: l.amount, usdE6: l.usdE6 };
    return { ...leaf, hash: leafHash(leaf), proofOk: verifyReserveProof(leaf, l.proof, root) };
  });
  const recomputedRoot = reserveRoot(reserves.leaves.map((l) => ({ asset: l.asset, venue: l.venue, amount: l.amount, usdE6: l.usdE6 })));
  const rootMatches = recomputedRoot === root;
  const onChainMatches = opts.onChainRoot ? opts.onChainRoot.toLowerCase() === root : null;
  const totalUsdE6 = reserves.leaves.reduce((s, l) => s + BigInt(l.usdE6), 0n).toString();
  return {
    ok: rootMatches && leaves.every((l) => l.proofOk) && onChainMatches !== false,
    root,
    recomputedRoot,
    rootMatches,
    onChainMatches,
    leaves,
    totalUsdE6,
  };
}
