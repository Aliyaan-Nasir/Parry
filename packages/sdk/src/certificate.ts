/**
 * Health certificates: the enclave reads a position at a final block and signs only a statement
 * that its health is at least a threshold, for one reader, until an expiry; never the amounts.
 * `verifyCertificate` re-checks one from its bytes: the hash, the enclave's signature with the key
 * the risk board trusted when it was issued, the expiry, the reader, and the on-chain anchor.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64, parseEd25519PublicKey, toHex, utf8 } from "./encoding.js";
import type { Certificate, CertificateAnchor, CertificateBody } from "./types.js";
import { enclaveKeyAt, type CheckStatus } from "./verify.js";

export const CERTIFICATE_DOMAIN = "parry-certificate:v1:";

/** SHA-256("parry-certificate:v1:" ++ certificate JSON): what the enclave signs, and the certificate's hash. */
export const certificateDigest = (certificateJson: string): Uint8Array => sha256(concatBytes(utf8(CERTIFICATE_DOMAIN), utf8(certificateJson)));

export interface CertificateCheck {
  name: "hash" | "statement" | "signature" | "expiry" | "reader" | "anchor";
  status: CheckStatus;
  detail: string;
}

export interface CertificateVerification {
  hash: string;
  /** No check failed, and the hash, statement, signature and expiry passed. */
  ok: boolean;
  checks: CertificateCheck[];
  certificate: CertificateBody | null;
  /** The enclave key the check used (in force at `issued_at`). */
  enclavePublicKey: string | null;
}

export interface VerifyCertificateOptions {
  /** The risk board's enclave key history (`enclave_history`): the key in force at `issued_at` is used. */
  enclaveHistory?: readonly { public_key: string; since: number }[] | null;
  /** A key to use instead of the history. */
  enclavePublicKey?: string | null;
  /** Unix seconds; defaults to now. */
  now?: number;
  /** The reader presenting it: the certificate must name this reader. */
  reader?: string;
  /** The risk board's `certificate(hash)` record; null when the board has none; omit to skip. */
  anchor?: CertificateAnchor | null;
}

export function verifyCertificate(cert: Pick<Certificate, "hash" | "certificate" | "signature"> & { anchorTx?: string | null }, opts: VerifyCertificateOptions = {}): CertificateVerification {
  const checks: CertificateCheck[] = [];
  const add = (name: CertificateCheck["name"], status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const digest = certificateDigest(cert.certificate);
  const hash = toHex(digest);
  add("hash", hash === cert.hash.toLowerCase() ? "pass" : "fail", hash === cert.hash.toLowerCase() ? `SHA-256 of the domain and certificate is ${hash}` : `the certificate hashes to ${hash}, not ${cert.hash}`);

  let body: CertificateBody | null = null;
  try {
    body = JSON.parse(cert.certificate) as CertificateBody;
  } catch {
    body = null;
  }
  const wellFormed = !!body && body.kind === "parry-health-certificate" && body.version === 1 && typeof body.threshold === "number" && typeof body.expires_at === "number" && typeof body.issued_at === "number";
  if (!wellFormed) add("statement", "fail", "not a version 1 Parry health certificate");
  else if (body!.statement !== `health is at least ${body!.threshold}`) add("statement", "fail", `the statement "${body!.statement}" does not match the threshold ${body!.threshold}`);
  else add("statement", "pass", `${body!.account} on ${body!.venue}: ${body!.statement} at block ${body!.block_height}`);

  const key = opts.enclavePublicKey ?? (body && opts.enclaveHistory?.length ? enclaveKeyAt(opts.enclaveHistory, body.issued_at) : null);
  if (!key) add("signature", "skip", "no enclave key given");
  else {
    try {
      const ok = ed25519.verify(fromBase64(cert.signature), digest, parseEd25519PublicKey(key));
      add("signature", ok ? "pass" : "fail", ok ? `signed by ${key}, the enclave key in force when it was issued` : `not signed by ${key}`);
    } catch (e) {
      add("signature", "fail", `bad signature: ${(e as Error).message}`);
    }
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!wellFormed) add("expiry", "fail", "no expiry");
  else if (body!.issued_at > now + 60) add("expiry", "fail", `issued in the future (${new Date(body!.issued_at * 1000).toISOString()})`);
  else add("expiry", now < body!.expires_at ? "pass" : "fail", `${now < body!.expires_at ? "valid until" : "expired at"} ${new Date(body!.expires_at * 1000).toISOString()}`);

  if (opts.reader === undefined) add("reader", "skip", body ? `issued for ${body.reader}` : "no reader given");
  else add("reader", body?.reader === opts.reader ? "pass" : "fail", body?.reader === opts.reader ? `issued for ${opts.reader}` : `issued for ${body?.reader ?? "nobody"}, not ${opts.reader}`);

  if (opts.anchor === undefined) add("anchor", "skip", cert.anchorTx ? `anchored in ${cert.anchorTx}; the board was not read` : "not read");
  else if (opts.anchor === null) add("anchor", cert.anchorTx ? "fail" : "skip", cert.anchorTx ? "the risk board has no anchor for this hash" : "not anchored on the risk board");
  else {
    const a = opts.anchor;
    const ok = a.hash.toLowerCase() === hash && (!body || (a.reader === body.reader && a.expires_at === body.expires_at));
    add("anchor", ok ? "pass" : "fail", ok ? `the risk board anchored it at ${new Date(a.at * 1000).toISOString()}` : "the board's anchor names another reader or expiry");
  }

  const failed = checks.some((c) => c.status === "fail");
  const core = ["hash", "statement", "signature", "expiry"].every((n) => checks.find((c) => c.name === n)?.status === "pass");
  return { hash, ok: !failed && core, checks, certificate: body, enclavePublicKey: key };
}
