/**
 * Checks a guardian decision end to end: the model's signature over the exact exchange, that the
 * signer is a key attested inside NEAR AI Cloud's TEE hardware (NVIDIA GPU and Intel TDX evidence,
 * verified with NEAR AI's inference SDK), the review hash the account emitted on chain, the
 * enclave's signature on the envelope, and which enclave build that key belongs to. Everything
 * but the attestation uses public data; fetching attestation reports needs a NEAR AI key
 * (free and not billed), so without one that check says it was not run here.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { findModelAttestationsForSignature, InferenceClient } from "@nearai/inference-sdk";
import { contract } from "@parry/services/lib/config";
import { eventsOf, rpc, view } from "@parry/services/lib/near";
import type { FinalExecutionOutcome } from "near-kit";
import type { DecisionRow } from "./views";

type Check = { name: string; ok: boolean; detail: string };

const attested = new Map<string, { at: number; check: Check }>();

/**
 * Whether `signingAddress` is a model key that passes NEAR AI Cloud's attestation now: the SDK
 * fetches the model's reports with a fresh nonce, verifies the Gateway, each report's Intel TDX
 * quote and its NVIDIA GPU evidence, and the signer must be one of the verified keys.
 */
export async function modelAttestation(model: string, signingAddress: string, apiKey = process.env.NEARAI_API_KEY): Promise<Check | null> {
  if (!apiKey) return null;
  const key = `${model}|${signingAddress.toLowerCase()}`;
  const hit = attested.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.check;
  const name = "Model key attested in TEE hardware";
  let check: Check;
  try {
    const client = new InferenceClient({ apiKey });
    const result = await client.verify(model);
    const matches = findModelAttestationsForSignature({ attestations: result.models, signature: { kind: "provider_tee", signer: { signingAlgo: "ecdsa", signingAddress } } });
    const gpu = [...new Set(matches.map((m) => String(m.gpuEvidence)))].join(", ");
    check = matches.length
      ? { name, ok: true, detail: `${signingAddress} is in ${matches.length} verified report(s) for ${model}: Intel TDX quote verified, NVIDIA GPU evidence ${gpu}` }
      : { name, ok: false, detail: `${signingAddress} is not among the ${result.models.length} verified keys serving ${model} now` };
  } catch (e) {
    check = { name, ok: false, detail: `attestation did not verify: ${(e as Error).message.slice(0, 200)}` };
  }
  attested.set(key, { at: Date.now(), check });
  return check;
}

/** The review record's hash, with fields in the order the enclave serializes them. */
export function reviewHash(r: Record<string, string>): string {
  const ordered = {
    model: r.model,
    chat_id: r.chat_id,
    request_hash: r.request_hash,
    response_hash: r.response_hash,
    signed_text: r.signed_text,
    signature: r.signature,
    signing_address: r.signing_address,
    signature_kind: r.signature_kind,
    verdict: r.verdict,
    reasoning: r.reasoning,
  };
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(ordered))));
}

/** The address that signed `text` with EIP-191 personal_sign. */
export function recoverEip191(text: string, signatureHex: string): string {
  const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  const msg = utf8ToBytes(`\x19Ethereum Signed Message:\n${utf8ToBytes(text).length}${text}`);
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const s = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(v);
  const pub = s.recoverPublicKey(keccak_256(msg)).toBytes(false);
  return `0x${bytesToHex(keccak_256(pub.subarray(1)).slice(12))}`;
}

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BS58.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from(out);
}

export async function verifyDecisionRecord(d: DecisionRow) {
  const checks: Check[] = [];
  const r = d.review;
  const hash = reviewHash(r);
  checks.push({ name: "Review hash", ok: !d.envelope || JSON.parse(d.envelope).review_hash === hash, detail: `SHA-256 of the review record is ${hash}` });
  checks.push({ name: "Signature covers this exchange", ok: !!r.signed_text?.endsWith(`${r.request_hash}:${r.response_hash}`), detail: r.signed_text ?? "" });
  let recovered = "";
  try {
    recovered = recoverEip191(r.signed_text ?? "", r.signature ?? "");
  } catch (e) {
    recovered = `error: ${(e as Error).message}`;
  }
  checks.push({ name: "Model TEE signature", ok: recovered.toLowerCase() === (r.signing_address ?? "").toLowerCase(), detail: `recovers to ${recovered}` });
  const attestation = r.model && r.signing_address ? await modelAttestation(r.model, r.signing_address) : null;
  if (attestation) checks.push(attestation);

  const enclave = await view<{ public_key: string; wasm_sha256: string }>(contract("risk"), "get_enclave").catch(() => null);
  if (d.envelope && d.envelope_signature && enclave) {
    const digest = sha256(utf8ToBytes(`parry-guardian:v1:${d.envelope}`));
    const ok = ed25519.verify(Buffer.from(d.envelope_signature, "base64"), digest, bs58(enclave.public_key.replace(/^ed25519:/, "")));
    checks.push({ name: "Enclave signature on the envelope", ok, detail: `key ${enclave.public_key}, bound to the enclave build ${enclave.wasm_sha256}` });
  }
  if (d.txs.action) {
    const sender = process.env.GUARDIAN_ACCOUNT_ID ?? "";
    const o = await rpc<FinalExecutionOutcome>("EXPERIMENTAL_tx_status", { tx_hash: d.txs.action, sender_account_id: sender, wait_until: "NONE" }).catch(() => null);
    const acted = o ? eventsOf(o).find((e) => e.event === "guardian_acted") : undefined;
    const onChain = (acted?.data as { review_hash?: string } | undefined)?.review_hash;
    checks.push({ name: "Review hash on chain", ok: onChain === hash, detail: onChain ? `the account emitted ${onChain} in ${d.txs.action}` : "the action transaction was not found" });
  }
  return {
    id: d.id,
    checks,
    verifyUrl: "https://cloud.near.ai/verify",
    attestation: attestation ? "checked" : "not checked here: the API has no NEAR AI key; check the signing address at cloud.near.ai/verify",
    ok: checks.every((c) => c.ok),
  };
}
