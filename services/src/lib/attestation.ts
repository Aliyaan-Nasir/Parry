/**
 * Gathers the evidence the enclave's `attest` mode checks for the review model's keys: NEAR AI's
 * attestation report for a nonce taken from a recent NEAR block, NVIDIA's signed verdict on each
 * node's GPU evidence, Intel's signed collateral for each TDX quote, and the certificates of
 * NVIDIA's signing keys. None of it is trusted here: the enclave verifies every signature
 * against Intel's root and NVIDIA's pinned intermediates, and the nonce against the chain.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { rpc } from "./near";

const NEARAI = "https://cloud-api.near.ai/v1";
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_KEYS = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
const INTEL_PCS = "https://api.trustedservices.intel.com";
const INTEL_ROOT_CRL = "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der";

/** The nonce the enclave expects for `blockHash` (`enclave/src/attest.rs` `nonce_for`). */
export function nonceFor(blockHash: string): string {
  return bytesToHex(sha256(utf8ToBytes(`parry-attest:v1:${blockHash}`)));
}

/** The PEM chain a TDX quote carries in its certification data (type 5). */
export function pckChain(quoteHex: string): string {
  const text = Buffer.from(quoteHex, "hex").toString("latin1");
  const start = text.indexOf("-----BEGIN CERTIFICATE-----");
  const endMark = "-----END CERTIFICATE-----";
  const end = text.lastIndexOf(endMark);
  if (start < 0 || end < start) throw new Error("the quote carries no PCK certificate chain");
  return text.slice(start, end + endMark.length);
}

/** The FMSPC (6 bytes, upper hex) after the OID 1.2.840.113741.1.13.1.4 in a PCK certificate. */
export function fmspcOf(certDer: Uint8Array): string {
  const oid = [0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf8, 0x4d, 0x01, 0x0d, 0x01, 0x04];
  for (let i = 0; i + oid.length + 8 <= certDer.length; i++) {
    if (oid.every((b, k) => certDer[i + k] === b) && certDer[i + oid.length] === 0x04 && certDer[i + oid.length + 1] === 0x06) {
      return Buffer.from(certDer.subarray(i + oid.length + 2, i + oid.length + 8)).toString("hex").toUpperCase();
    }
  }
  throw new Error("no FMSPC in the PCK certificate");
}

/** `{"<field>":{...},"signature":"<hex>"}` split into the exact signed text and its signature. */
export function signedBody(body: string, field: string): { text: string; signature: string } {
  const m = body.trim().match(new RegExp(`^\\{"${field}":([\\s\\S]*),"signature":"([0-9a-fA-F]+)"\\}$`));
  if (!m) throw new Error(`Intel's ${field} response has an unexpected shape`);
  return { text: m[1]!, signature: m[2]!.toLowerCase() };
}

async function get(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url.split("?")[0]}: HTTP ${r.status}`);
  return r;
}

/** Intel's collateral for a quote, in `dcap-qvl`'s `QuoteCollateralV3` JSON shape (bytes as hex). */
export async function intelCollateral(quoteHex: string) {
  const chain = pckChain(quoteHex);
  const leafB64 = chain.split("-----BEGIN CERTIFICATE-----")[1]!.split("-----END CERTIFICATE-----")[0]!.replace(/\s+/g, "");
  const leaf = Buffer.from(leafB64, "base64");
  const fmspc = fmspcOf(leaf);
  const ca = leaf.includes(Buffer.from("Intel SGX PCK Platform CA")) ? "platform" : "processor";
  const header = (r: Response, ...names: string[]) => {
    for (const n of names) {
      const v = r.headers.get(n);
      if (v) return decodeURIComponent(v);
    }
    throw new Error(`Intel's response has no ${names[0]} header`);
  };
  const crl = await get(`${INTEL_PCS}/sgx/certification/v4/pckcrl?ca=${ca}&encoding=der`);
  const tcb = await get(`${INTEL_PCS}/tdx/certification/v4/tcb?fmspc=${fmspc}`);
  const qe = await get(`${INTEL_PCS}/tdx/certification/v4/qe/identity`);
  const root = await get(INTEL_ROOT_CRL);
  const tcbSigned = signedBody(await tcb.text(), "tcbInfo");
  const qeSigned = signedBody(await qe.text(), "enclaveIdentity");
  return {
    pck_crl_issuer_chain: header(crl, "sgx-pck-crl-issuer-chain"),
    root_ca_crl: Buffer.from(await root.arrayBuffer()).toString("hex"),
    pck_crl: Buffer.from(await crl.arrayBuffer()).toString("hex"),
    tcb_info_issuer_chain: header(tcb, "tcb-info-issuer-chain", "sgx-tcb-info-issuer-chain"),
    tcb_info: tcbSigned.text,
    tcb_info_signature: tcbSigned.signature,
    qe_identity_issuer_chain: header(qe, "sgx-enclave-identity-issuer-chain"),
    qe_identity: qeSigned.text,
    qe_identity_signature: qeSigned.signature,
    pck_certificate_chain: chain,
  };
}

/** The `kid` a JWT names in its header. */
function kidOf(jwt: string): string | null {
  try {
    return (JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as { kid?: string }).kid ?? null;
  } catch {
    return null;
  }
}

/** The enclave's `attest` input for `model`: a fresh nonce, every distinct key NEAR AI serves it with, and their evidence. */
export async function attestationEvidence(model: string, apiKey: string) {
  const block = await rpc<{ header: { hash: string } }>("block", { finality: "final" });
  const blockHash = block.header.hash;
  const nonce = nonceFor(blockHash);
  const report = (await (await get(`${NEARAI}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { authorization: `Bearer ${apiKey}` })).json()) as {
    model_attestations?: { model_name?: string; signing_address: string; intel_quote: string; nvidia_payload: string }[];
  };
  const seen = new Set<string>();
  const nodes = [];
  const kids = new Set<string>();
  for (const n of report.model_attestations ?? []) {
    if (n.model_name && n.model_name !== model) continue;
    const address = n.signing_address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    const r = await fetch(NRAS, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: n.nvidia_payload, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`NVIDIA attestation: HTTP ${r.status}`);
    const nras = (await r.json()) as [[string, string], Record<string, string>];
    for (const jwt of [nras[0]?.[1], ...Object.values(nras[1] ?? {})]) {
      const kid = jwt ? kidOf(jwt) : null;
      if (kid) kids.add(kid);
    }
    nodes.push({ signing_address: address, intel_quote: n.intel_quote, collateral: await intelCollateral(n.intel_quote), nras });
  }
  if (nodes.length === 0) throw new Error(`NEAR AI lists no node for ${model}`);
  const jwks = (await (await get(NRAS_KEYS)).json()) as { keys: { kid: string; x5c?: string[] }[] };
  const nvidiaCerts: Record<string, string[]> = {};
  for (const k of jwks.keys) if (kids.has(k.kid) && k.x5c && k.x5c.length >= 2) nvidiaCerts[k.kid] = k.x5c.slice(0, 2);
  return { block_hash: blockHash, model, nodes, nvidia_certs: nvidiaCerts };
}
