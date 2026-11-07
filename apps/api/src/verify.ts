/**
 * Checks a guardian decision end to end, from public data only: the model's signature over the
 * exact exchange, the review hash the account emitted on chain, the enclave's signature on the
 * envelope, and which enclave build that key belongs to.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { contract } from "@parry/services/lib/config";
import { eventsOf, rpc, view } from "@parry/services/lib/near";
import type { FinalExecutionOutcome } from "near-kit";
import type { DecisionRow } from "./views";

type Check = { name: string; ok: boolean; detail: string };

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
  checks.push({ name: "Model TEE signature", ok: recovered.toLowerCase() === (r.signing_address ?? "").toLowerCase(), detail: `recovers to ${recovered}; the model's attestation for this address is checked at cloud.near.ai/verify` });

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
  return { id: d.id, checks, verifyUrl: "https://cloud.near.ai/verify", ok: checks.every((c) => c.ok) };
}
