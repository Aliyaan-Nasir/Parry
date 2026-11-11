/**
 * Health certificates: the enclave's `certificate` mode reads a position at the current final
 * block and signs, only when health is at least the threshold, a statement for one reader until an
 * expiry (never the amounts). This flow runs it through OutLayer, optionally anchors it on the risk
 * board (an enclave-signed report of kind `certificate`), and stores it. internal/INTERFACES.md
 * sections 3 and 4 hold the shapes.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { contract } from "./config";
import type { Sql } from "./db";
import { enclaveModes, runEnclave, type EnclaveRun } from "./enclave";
import { senderFromEnv, txHash, type Sender } from "./near";

export const CERTIFICATE_DOMAIN = "parry-certificate:v1:";
export const certificateHash = (json: string): string => bytesToHex(sha256(utf8ToBytes(`${CERTIFICATE_DOMAIN}${json}`)));

export interface CertificateInput {
  account: string;
  reader: string;
  threshold: number;
  ttlSecs: number;
  venue: string;
  anchor: boolean;
}

/** The enclave's certificate output: signed, or refused (health below the threshold). */
export type CertificateOutput =
  | { certificate_json: string; signature: string; public_key: string; report_json: string; report_signature: string }
  | { refused: string };

export interface CertificateRow {
  hash: string;
  account: string;
  reader: string;
  certificate: string;
  signature: string;
  enclave_public_key: string;
  anchor_tx: string | null;
  created_at: Date;
}

export const certificateView = (r: CertificateRow) => ({
  hash: r.hash,
  certificate: r.certificate,
  signature: r.signature,
  enclavePublicKey: r.enclave_public_key,
  anchorTx: r.anchor_tx,
  createdAt: r.created_at.toISOString(),
});

export class CertificateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const VENUES = ["rhea", "hyperliquid", "aave"] as const;

/** Checks a request; throws a 400 with what is wrong. */
export function checkInput(b: Partial<CertificateInput>): CertificateInput {
  const account = /^[a-z0-9._-]{2,64}$/;
  if (typeof b.account !== "string" || !account.test(b.account)) throw new CertificateError("account must be a NEAR account id", 400);
  if (typeof b.reader !== "string" || !account.test(b.reader)) throw new CertificateError("reader must be a NEAR account id (who will read the certificate)", 400);
  if (typeof b.threshold !== "number" || !(b.threshold > 1) || b.threshold > 10) throw new CertificateError("threshold is a health above 1, at most 10", 400);
  if (typeof b.ttlSecs !== "number" || !Number.isInteger(b.ttlSecs) || b.ttlSecs < 60 || b.ttlSecs > 30 * 86_400) throw new CertificateError("ttlSecs is 60 to 2592000 seconds", 400);
  const venue = b.venue ?? "rhea";
  if (!(VENUES as readonly string[]).includes(venue)) throw new CertificateError(`venue is one of ${VENUES.join(", ")}`, 400);
  return { account: b.account, reader: b.reader, threshold: b.threshold, ttlSecs: b.ttlSecs, venue, anchor: b.anchor === true };
}

export interface IssueDeps {
  run?: (fields: Record<string, unknown>) => Promise<EnclaveRun<CertificateOutput>>;
  anchorer?: Sender | null;
  modes?: () => string[];
}

/** Runs the enclave's certificate mode, anchors it when asked (and a wallet is set), and stores it. */
export async function issueCertificate(sql: Sql, input: CertificateInput, issuedBy: string, deps: IssueDeps = {}) {
  if (!(deps.modes ?? enclaveModes)().includes("certificate")) {
    throw new CertificateError("health certificates need the enclave build with the certificate mode, which is not deployed on this network yet", 503);
  }
  const run = deps.run ?? ((fields) => runEnclave<CertificateOutput>("certificate", [], fields));
  // A run that cannot start or fails (no enclave caller configured, OutLayer down) is a dependency failure.
  const r = await run({ account: input.account, reader: input.reader, threshold: input.threshold, ttl_secs: input.ttlSecs, venue: input.venue }).catch((e: unknown) => {
    throw new CertificateError(`the enclave run failed: ${(e as Error).message ?? String(e)}`, 503);
  });
  if ("refused" in r.output) throw new CertificateError(`the enclave refused: ${r.output.refused}`, 422);
  const out = r.output;
  const hash = certificateHash(out.certificate_json);
  const body = JSON.parse(out.certificate_json) as { expires_at: number };
  let anchorTx: string | null = null;
  if (input.anchor) {
    const wallet = deps.anchorer === undefined ? (senderFromEnv("CERTIFICATE") ?? senderFromEnv("RELAYER")) : deps.anchorer;
    if (!wallet) throw new CertificateError("anchoring needs a wallet on the API (CERTIFICATE_ACCOUNT_ID and CERTIFICATE_PRIVATE_KEY)", 503);
    const o = await wallet.call({ receiverId: contract("risk"), methodName: "submit", args: { report_json: out.report_json, signature: out.report_signature }, tgas: 50 });
    anchorTx = txHash(o);
  }
  const [row] = await sql<CertificateRow[]>`INSERT INTO certificates (hash, account, reader, certificate, signature, enclave_public_key, anchor_tx, outlayer_tx, issued_by, expires_at)
    VALUES (${hash}, ${input.account}, ${input.reader}, ${out.certificate_json}, ${out.signature}, ${out.public_key}, ${anchorTx}, ${r.tx}, ${issuedBy}, ${new Date(body.expires_at * 1000)})
    ON CONFLICT (hash) DO UPDATE SET anchor_tx = COALESCE(excluded.anchor_tx, certificates.anchor_tx) RETURNING *`;
  return certificateView(row!);
}
