/** A mocked Parry: the real SDK client over a mocked API, with chain reads and sends stubbed. */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { reserveProof, reserveRoot, type ReserveLeaf } from "@parry/core";
import {
  certificateDigest,
  createParry,
  verifyCertificate,
  envelopeDigest,
  reviewHash,
  toBase58,
  toBase64,
  type ContractCall,
  type Decision,
  type Network,
  type Parry,
  type Reserves,
} from "@parry/sdk";

export const API = "https://api.parry.example";
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

export const enclaveSecret = sha256(utf8ToBytes("enclave signing seed"));
export const enclaveKey = `ed25519:${toBase58(ed25519.getPublicKey(enclaveSecret))}`;
export const sealingSecret = sha256(utf8ToBytes("enclave sealing seed"));
export const sealingPublicKey = bytesToHex(x25519.getPublicKey(sealingSecret));

export function genuineDecision(): Decision {
  const model = "z-ai/glm-5.3-flash";
  const requestHash = bytesToHex(sha256(utf8ToBytes("request")));
  const responseHash = bytesToHex(sha256(utf8ToBytes("response")));
  const signedText = `${model}:${requestHash}:${responseHash}`;
  const msg = utf8ToBytes(signedText);
  const digest = keccak_256(concat(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const modelSecret = sha256(utf8ToBytes("model"));
  const rec = secp256k1.sign(digest, modelSecret, { prehash: false, format: "recovered" });
  const signature = `0x${bytesToHex(concat(rec.subarray(1), Uint8Array.of(rec[0]! + 27)))}`;
  const signingAddress = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(modelSecret, false).subarray(1)).subarray(12))}`;
  const reasoning = "Health is 0.83; the repay is proportionate.";
  const hash = reviewHash({ model, chatId: "chat-1", requestHash, responseHash, signedText, signature, signingAddress, signatureKind: "provider_tee", verdict: "approve", reasoning });
  const envelope = JSON.stringify({
    account: "0uabc.testnet",
    network: "testnet",
    nonce: 5,
    issued_at: 1_800_000_000,
    review_hash: hash,
    trigger: { score: 81, tier: "critical", health_bps: 8300 },
    action: { repay: { token: "usdc.parry.testnet", amount: "60000000" } },
  });
  return {
    id: bytesToHex(sha256(utf8ToBytes(envelope))),
    account: "0uabc.testnet",
    venue: "rhea",
    action: "repay",
    plan: "Repay 60 USDC.",
    trigger: { score: 81, tier: "critical", healthBps: 8300 },
    outcome: "executed",
    review: { model, chatId: "chat-1", reviewHash: hash, verdict: "approve", reasoning, signingAddress, signedText, signature, signatureKind: "provider_tee" },
    envelope,
    envelopeSignature: toBase64(ed25519.sign(envelopeDigest(envelope), enclaveSecret)),
    txs: { action: "tx-a", record: "tx-r", hyperliquid: null, evm: null },
    healthBefore: 0.83,
    healthAfter: 1.45,
    routes: null,
    createdAt: "2026-11-10T00:00:00Z",
  };
}

const leaves: ReserveLeaf[] = [
  { asset: "LiNEAR", venue: "near", amount: "1000000000000000000000000000", usdE6: "3200000000" },
  { asset: "USDC", venue: "hyperliquid", amount: "500000000", usdE6: "500000000" },
  { asset: "USDC", venue: "near", amount: "25000000", usdE6: "25000000" },
];
export const reserves: Reserves = { root: reserveRoot(leaves), ratioBps: 10_400, reportAt: "2026-11-10T00:00:00Z", leaves: leaves.map((l) => ({ ...l, proof: reserveProof(leaves, l) })) };

const position = {
  id: "0uabc.testnet:rhea:main",
  account: "0uabc.testnet",
  venue: "rhea",
  label: "Rhea wNEAR/USDC",
  collateralUsd: 320,
  debtUsd: 150,
  health: 1.18,
  liqPrice: 2.7,
  distance: 0.16,
  score: 64,
  tier: "danger",
  probability24h: 0.08,
  ttlHours: 30,
  valueAtRisk99: 41,
  updatedAt: "2026-11-10T00:00:00Z",
};
const market = {
  near: { priceUsd: 3.2, hlMid: 3.21, updatedAt: "2026-11-10T00:00:00Z" },
  tremor: { sigmaHourly: 0.012, annual: 1.1, level: "high", windows: [{ hours: 1, sigma: 0.01 }] },
  cascade: { pressure: 0.2, atRiskUsd: 12000, correlatedOwners: 1 },
};
const vault = {
  network: "testnet",
  paused: false,
  riskScore: 18,
  reportAt: "2026-11-10T00:00:00Z",
  sharePriceUsd: 1.02,
  navUsd: 3725,
  totalShares: "3650000000000000000000000000",
  queuedShares: "0",
  stakedLinear: "1000000000000000000000000000",
  linearRate: 1.08,
  nearPriceUsd: 3.2,
  hedge: { targetNear: 972, currentNear: 960, entry: 3.3, mark: 3.2, liquidation: 6.1, leverage: 1.9, maxLeverage: 3, hedgeRatio: 0.9, needsMargin: false, address: "0xabc" },
  yield: { stakingApr: 0.09, fundingUsd: 4.2, hedgePnlUsd: 96 },
  reserves: { root: reserves.root, leaves: 3, totalUsd: 3725, liabilitiesUsd: 3580, ratioBps: 10_400 },
  depositCapNear: "100000000000000000000000000000",
  minDepositNear: "100000000000000000000000",
  queueLength: 0,
};

const certBody = JSON.stringify({
  kind: "parry-health-certificate",
  version: 1,
  account: "0uagent.testnet",
  reader: "lender.testnet",
  venue: "rhea",
  threshold: 1.3,
  block_height: 10,
  block_hash: "11111111111111111111111111111111",
  issued_at: Math.floor(Date.now() / 1000) - 100,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  statement: "health is at least 1.3",
});
export const certificate = {
  hash: bytesToHex(certificateDigest(certBody)),
  certificate: certBody,
  signature: toBase64(ed25519.sign(certificateDigest(certBody), enclaveSecret)),
  enclavePublicKey: enclaveKey,
  anchorTx: null,
  createdAt: "2026-11-10T00:00:00Z",
};

export const routes: Record<string, unknown> = {
  "GET /v1/rates": {
    rhea: [{ asset: "wNEAR", tokenId: "wrap.testnet", supplyApr: 0.01, borrowApr: 0.03, utilization: 0.4, source: "lending.parry.testnet get_assets_paged_detailed" }],
    hyperliquid: { fundingHourly: 0.0000125, funding24hApr: 0.1095, source: "hyperliquid" },
    vault: { stakingApr: 0.05, fundingApr: 0.02, netApr: 0.07, insuranceShareBps: null, source: "vault" },
    readAt: "2026-11-10T00:00:00Z",
  },
  "GET /v1/replay": {
    source: "https://data-api.binance.vision/api/v3/klines?symbol=NEARUSDT&interval=1h",
    crashes: [
      {
        id: "crash-2022-05-09",
        name: "9 May 2022 to 12 May 2022",
        start: "2022-05-09T00:00:00Z",
        end: "2022-05-12T00:00:00Z",
        dropPct: 51.7,
        candles: [{ t: "2022-05-09T00:00:00Z", price: 10 }],
        position: { startHealth: 1.3, warningHours: 44, liquidatedAt: "2022-05-11T06:00:00Z", liquidatedWithParryAt: null, steps: [], healthWith: [], healthWithout: [] },
        vault: { navWith: [], navUnhedged: [], maxDrawdownPct: 3.8, maxDrawdownUnhedgedPct: 51.7, marginMin: 0.5, insurancePaidUsd: 5 },
      },
    ],
    summary: { medianWarningHours: 44, liquidationsAvoided: 1, crashes: 1 },
  },
  "GET /v1/heatmap": { network: "testnet", price: 3.6, buckets: [{ price: 2.8, collateralUsd: 5, debtUsd: 3, accounts: 1 }], cascades: [], readAt: "2026-11-10T00:00:00Z", accounts: 1 },
  "GET /v1/prices": { tokens: [{ id: "wrap.near", symbol: "wNEAR", priceUsd: 3.6, change24h: 0.01, source: "aggregate-oracle.near" }], readAt: "2026-11-10T00:00:00Z" },
  "GET /v1/incidents": [{ id: "1", account: "0uabc.testnet", title: "2 positions affected", body: "", severity: "critical", alerts: [], openedAt: "2026-11-10T00:00:00Z", closedAt: null }],
  "GET /v1/routes/savings": { totalSavedUsd: 1.5, rescues: [] },
  [`GET /v1/verify/${"ab".repeat(32)}`]: { kind: "certificate", ok: true, checks: [{ name: "hash", ok: true, detail: "" }], subject: {} },
  "POST /v1/auth/challenge": { nonce: "cd".repeat(32), message: "Sign in to Parry as 0uagent.testnet.", recipient: "parry" },
  "POST /v1/auth/verify": { token: "agent-token" },
  "GET /v1/watch": [{ account: "bob.testnet", label: null, thresholds: { score: 50, health: 1.2 }, position: null, alert: [] }],
  "PUT /v1/watch/bob.testnet": { account: "bob.testnet", label: "Bob", thresholds: { score: 50, health: 1.2 }, position: null, alert: [] },
  "DELETE /v1/watch/bob.testnet": { ok: true },
  "POST /v1/certificates": certificate,
  "GET /v1/accounts/0uabc.testnet": {
    account: "0uabc.testnet",
    owner: { kind: "near", id: "alice.testnet" },
    mandate: null,
    positions: [position],
    hyperliquidAddress: "0x01",
    evmAddress: "0x02",
    stats: { guardianActions: 1, deleverages: 0 },
  },
  "GET /v1/risk/alice.testnet": { account: "alice.testnet", checkedAt: "2026-11-10T00:00:00Z", position, market, model: "docs/risk-model.md" },
  "GET /v1/market": market,
  "GET /v1/quotes/rescue": { amountNear: 10, rhea: { outUsd: 24.6, priceImpact: 0.004, poolId: 3 }, intents: { outUsd: 24.7, confidential: false, dry: true }, chosen: "intents", reason: "1Click returns more" },
  "GET /v1/status": {
    network: "testnet",
    services: [{ name: "monitor", ok: true, detail: "", checkedAt: "2026-11-10T00:00:00Z" }, { name: "keeper", ok: true, detail: "", checkedAt: "2026-11-10T00:00:00Z" }],
    oracle: { ageSeconds: 12 },
    indexer: { lagBlocks: 3 },
    lanes: [{ wallet: "keeper.parry.testnet", lanes: 8 }],
    treasury: { account: "treasury.parry.testnet", balanceNear: 12 },
  },
  "GET /v1/vault": vault,
  "GET /v1/vault/reserves": reserves,
  "POST /v1/simulate/0uabc.testnet": {
    account: "0uabc.testnet",
    triggered: true,
    reason: "score 64 is above the trigger",
    steps: [{ kind: "repay", amount: "40000000", healthBefore: 1.18, healthAfter: 1.45 }],
    routes: null,
  },
  "POST /v1/relay/create-account": { accountId: "0uagent.testnet", txHash: "tx-create" },
};

export interface FakeParry {
  parry: Parry;
  sent: ContractCall[];
  apiCalls: string[];
}

export function fakeParry(network: Network = "testnet"): FakeParry {
  const sent: ContractCall[] = [];
  const apiCalls: string[] = [];
  const decision = genuineDecision();
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    apiCalls.push(`${key}${url.search}${init?.headers && (init.headers as Record<string, string>).authorization ? ` as ${(init.headers as Record<string, string>).authorization}` : ""}`);
    if (key === "GET /v1/guardian/decisions") return Response.json({ items: [decision], next: null });
    if (key === `GET /v1/guardian/decisions/${decision.id}`) return Response.json(decision);
    if (key in routes) return Response.json(routes[key]);
    return Response.json({ error: `no route ${key}` }, { status: 404 });
  };
  const base = createParry({ network, apiUrl: API, fetch });
  const parry: Parry = {
    ...base,
    protectedAccountId: async () => (network === "testnet" ? "0uagent.testnet" : "0uagent.near"),
    enclave: async () => ({
      key: { index: 0, public_key: enclaveKey, wasm_sha256: "00".repeat(32), since: 1, note: "" },
      sealingKey: { public_key: sealingPublicKey, run_id: 1, at: 1, key_index: 0 },
    }),
    vaultState: async () => ({ reserves: { root: reserves.root } }) as Awaited<ReturnType<Parry["vaultState"]>>,
    paidRiskCheck: async (account, opts) => {
      apiCalls.push(`PAID ${account} max ${String(opts.maxAmount)} by ${opts.payer.accountId}`);
      return {
        result: { account, checkedAt: "2026-11-10T00:00:00Z", position, market, model: "docs/risk-model.md" },
        payment: { success: true, transaction: "paid-tx", network: "near:testnet", payer: opts.payer.accountId },
        requirement: { scheme: "exact", network: "near:testnet", asset: "usdc.parry.testnet", amount: "10000", payTo: "api.parry.testnet", resource: `/v1/paid/risk/${account}`, description: "risk check" },
      } as unknown as Awaited<ReturnType<Parry["paidRiskCheck"]>>;
    },
    verifyCertificate: async (_c, opts = {}) => verifyCertificate(certificate, { enclavePublicKey: enclaveKey, ...opts }),
    sendCall: async (call) => {
      sent.push(call);
      return { txHash: `tx-${sent.length}`, value: call.methodName === "request_withdraw" ? sent.length : null };
    },
  };
  return { parry, sent, apiCalls };
}
