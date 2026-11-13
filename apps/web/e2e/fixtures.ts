// Fixtures for the end-to-end tests: realistic responses of every API route and chain view the app
// reads, shaped as docs/api.md and the API itself return them. They never leave the test browser.
//
// The guardian decisions, the reserves and the sealed policy are built with real cryptography from
// fixed test keys, so the app's in-browser checks (verifyDecision, verifyReserves) genuinely pass.

import { createHash } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { reserveProof, reserveRoot, type ReserveLeaf } from "@parryguard/core";
import { envelopeDigest, reviewHash, sealPolicy, toBase58, toBase64, toBase64Url, toHex } from "@parryguard/sdk";
import type {
  AccountSummary,
  Alert,
  Config,
  Decision,
  HistoryPoint,
  MandateView,
  Market,
  Position,
  Reserves,
  RouteComparison,
  Stats,
  VaultChainState,
  Verification,
} from "@parryguard/sdk";
import type { CopilotAnswer, Fx, Portfolio, Settings, ShockState, SimulationResult, StatusView, VaultHistoryPoint, VaultView } from "@/lib/api-types";

// ---------------------------------------------------------------------------------------------
// Keys and ids
// ---------------------------------------------------------------------------------------------

const sha256 = (data: string | Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());
const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

/** The protected account the fixtures describe (the local sandbox's critical position). */
export const ACCOUNT = "0uwgjhgwzd2k6j8qht2ywwzqn2f8p90h5qzyp5zfd85cgjswa1cnj0";
/** The NEAR wallet account that owns it. */
export const OWNER_WALLET = "alice.testnet";
/** A second protected account, the one a relayed passkey creation returns. */
export const PASSKEY_ACCOUNT = "0u7c5tmrq0y3v8kd2h6xw4pn9fa1jzbe5s0gq3ld7u2mk6vyc8tw4h";

/** The testnet contract ids the app uses without an RPC override (the SDK's NETWORKS). */
export const CONTRACTS = {
  factory: "accounts.parry.testnet",
  vault: "vault.parry.testnet",
  risk: "risk.parry.testnet",
  oracle: "oracle.parry.testnet",
  lending: "lending.parry.testnet",
  dex: "ref-finance-101.testnet",
  signer: "v1.signer-prod.testnet",
  usdc: "usdc.parry.testnet",
  wnear: "wrap.testnet",
  linear: "linear-protocol.testnet",
} as const;

export const POSITION_ID = `${ACCOUNT}:rhea:main`;
export const PERP_POSITION_ID = `${ACCOUNT}:hyperliquid:NEAR`;
export const POSITION_LABEL = "Rhea wNEAR/USDC";

/** The guardian enclave's test signing key (ed25519). */
const ENCLAVE_SECRET = sha256("parry-e2e:enclave");
export const ENCLAVE_PUBLIC_KEY = `ed25519:${toBase58(ed25519.getPublicKey(ENCLAVE_SECRET))}`;

/** The enclave's test sealing key (X25519): tests can open what the app sealed with the secret. */
export const SEALING_SECRET = sha256("parry-e2e:sealing");
export const SEALING_PUBLIC_KEY = toHex(x25519.getPublicKey(SEALING_SECRET));

/** The review model's test signing key (secp256k1, EIP-191) and its address. */
const MODEL_SECRET = sha256("parry-e2e:model");
export const MODEL_ADDRESS = `0x${toHex(keccak_256(secp256k1.getPublicKey(MODEL_SECRET, false).subarray(1)).subarray(12))}`;
export const REVIEW_MODEL = "z-ai/glm-5.3-flash";

/** A passkey for the seeded passkey account: a real compressed P-256 key. */
export const PASSKEY_SECRET = sha256("parry-e2e:passkey");
export const PASSKEY = {
  credentialId: toBase64Url(sha256("parry-e2e:credential").subarray(0, 16)),
  publicKey: toHex(p256.getPublicKey(PASSKEY_SECRET, true)),
};

/** The Web Push VAPID public key the settings route announces (base64url, uncompressed P-256). */
export const VAPID_PUBLIC_KEY = toBase64Url(p256.getPublicKey(sha256("parry-e2e:vapid"), false));

/** A base58 NEAR transaction hash, fixed per label. */
export const txHash = (label: string) => toBase58(sha256(`parry-e2e:tx:${label}`));
const evmAddress = (label: string) => `0x${toHex(sha256(`parry-e2e:addr:${label}`).subarray(0, 20))}`;

export const HL_ADDRESS = evmAddress("account-hyperliquid");
export const EVM_ADDRESS = evmAddress("account-evm");
export const VAULT_HEDGE_ADDRESS = evmAddress("vault-hedge");

// ---------------------------------------------------------------------------------------------
// Market and positions
// ---------------------------------------------------------------------------------------------

export const NEAR_PRICE = 2.86121509;

const iso = (ms: number) => new Date(ms).toISOString();

export function market(now: number): Market {
  return {
    near: { priceUsd: NEAR_PRICE, hlMid: 2.874, updatedAt: iso(now - 4_000) },
    tremor: {
      sigmaHourly: 0.0118,
      annual: 1.1044,
      level: "high",
      windows: [
        { hours: 1, sigma: 0.0131 },
        { hours: 4, sigma: 0.0109 },
        { hours: 12, sigma: 0.0098 },
      ],
    },
    cascade: { pressure: 0.184, atRiskUsd: 52_300.4, correlatedOwners: 2 },
  };
}

export function positions(now: number): Position[] {
  return [
    {
      id: POSITION_ID,
      account: ACCOUNT,
      venue: "rhea",
      label: POSITION_LABEL,
      collateralUsd: 286.121509,
      debtUsd: 195,
      health: 1.0454439751923077,
      liqPrice: 2.736842105263158,
      distance: 0.04346858968119105,
      score: 85,
      tier: "critical",
      probability24h: 0.9724,
      ttlHours: 3.4,
      valueAtRisk99: 295.7795576677084,
      updatedAt: iso(now - 6_000),
    },
    {
      id: PERP_POSITION_ID,
      account: ACCOUNT,
      venue: "hyperliquid",
      label: "Hyperliquid NEAR perp",
      collateralUsd: 120.5,
      debtUsd: 0,
      health: 1.42,
      liqPrice: 1.659,
      distance: 0.42,
      score: 6,
      tier: "safe",
      probability24h: 0.0041,
      ttlHours: null,
      valueAtRisk99: 31.4,
      updatedAt: iso(now - 6_000),
    },
  ];
}

/** A smooth, fixed path: the Rhea position sliding toward liquidation over the last day. */
export function history(positionId: string, hours: number, now: number): HistoryPoint[] {
  const known = positionId === POSITION_ID || positionId === PERP_POSITION_ID;
  if (!known) return [];
  const stepMin = hours <= 6 ? 2 : hours <= 24 ? 5 : 30;
  const n = Math.floor((hours * 60) / stepMin);
  const end = Math.floor(now / 60_000) * 60_000;
  const out: HistoryPoint[] = [];
  for (let i = n; i >= 0; i--) {
    const t = end - i * stepMin * 60_000;
    const x = 1 - i / n; // 0 at the start of the range, 1 now
    const wave = Math.sin(i / 7) * 0.012 + Math.sin(i / 23) * 0.02;
    const price = 3.42 - 0.56 * x ** 1.6 + wave * 0.6;
    if (positionId === POSITION_ID) {
      const health = (price / NEAR_PRICE) * 1.0454;
      const score = Math.max(2, Math.min(85, Math.round(100 * (1.32 - health) * 3.1)));
      out.push({ t: iso(t), health: Math.round(health * 10_000) / 10_000, score, price: Math.round(price * 1e6) / 1e6 });
    } else {
      out.push({ t: iso(t), health: Math.round((1 + (1 - 1.659 / price)) * 10_000) / 10_000, score: 6, price: Math.round(price * 1e6) / 1e6 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mandate (the contract's view) and the sealed policy
// ---------------------------------------------------------------------------------------------

/** The policy sealed into the fixture mandate (open it with SEALING_SECRET). */
export const SEALED_POLICY = { triggerScore: 60, triggerHealth: 1.15, targetHealth: 1.45, strategy: "repay-first" } as const;

let sealedCache: string | null = null;
function sealedPolicy(): string {
  sealedCache ??= toBase64(sealPolicy({ ...SEALED_POLICY }, { account: ACCOUNT, sealingPublicKey: SEALING_PUBLIC_KEY }));
  return sealedCache;
}

export function mandateView(now: number): MandateView {
  const s = Math.floor(now / 1000);
  return {
    mandate: {
      guardian_key: ENCLAVE_PUBLIC_KEY,
      powers: ["repay", "add_collateral", "deleverage"],
      limits: [
        { token: CONTRACTS.usdc, reserve: "100000000", daily: "60000000" },
        { token: CONTRACTS.wnear, reserve: "20000000000000000000000000", daily: "10000000000000000000000000" },
      ],
      max_actions_per_day: 10,
      min_health_after_bps: 10500,
      max_slippage_bps: 200,
      hl: null,
      evm: null,
      sealed: sealedPolicy(),
      expires_at: s + 30 * 86_400,
    },
    set_at: s - 2 * 86_400,
    paused_until: 0,
    expired: false,
    spent: [[CONTRACTS.usdc, "54404724"]],
    moved_today: [[CONTRACTS.usdc, "54404724"]],
    actions_today: 1,
  };
}

export function accountSummary(now: number, opts: { ownerKind?: "near" | "passkey"; empty?: boolean } = {}): AccountSummary {
  return {
    account: ACCOUNT,
    owner: opts.ownerKind === "passkey" ? { kind: "passkey", id: PASSKEY.publicKey } : { kind: "near", id: OWNER_WALLET },
    mandate: opts.empty ? null : mandateView(now),
    positions: opts.empty ? [] : positions(now),
    hyperliquidAddress: HL_ADDRESS,
    evmAddress: EVM_ADDRESS,
    stats: opts.empty ? { guardianActions: 0, deleverages: 0 } : { guardianActions: 2, deleverages: 0 },
  };
}

export function portfolio(now: number, empty = false): Portfolio {
  const ps = empty ? [] : positions(now);
  const collateral = ps.reduce((t, p) => t + p.collateralUsd, 0);
  const debt = ps.reduce((t, p) => t + p.debtUsd, 0);
  const vaultUsd = empty ? 0 : 1531.95;
  return {
    account: ACCOUNT,
    collateralUsd: collateral,
    debtUsd: debt,
    equityUsd: collateral - debt + vaultUsd,
    vault: { shares: empty ? "0" : "1500000000000000000000000000", valueUsd: vaultUsd },
    pnl24hUsd: empty ? null : -61.2,
    positions: ps,
  };
}

// ---------------------------------------------------------------------------------------------
// Guardian decisions (real signatures)
// ---------------------------------------------------------------------------------------------

function signEip191(text: string): string {
  const message = utf8(text);
  const digest = keccak_256(new Uint8Array([...utf8(`\x19Ethereum Signed Message:\n${message.length}`), ...message]));
  const sig = secp256k1.sign(digest, MODEL_SECRET, { prehash: false, format: "recovered" });
  // noble's "recovered" form is recovery || r || s; EIP-191 signatures are r || s || v.
  return `0x${toHex(sig.subarray(1))}${(27 + sig[0]!).toString(16)}`;
}

type DecisionSeed = {
  label: string;
  minutesAgo: number;
  action: string;
  plan: string;
  trigger: Decision["trigger"];
  outcome: Decision["outcome"];
  verdict: "approve" | "reject";
  reasoning: string;
  /** The envelope's action, when the review approved the plan. */
  envelopeAction?: Record<string, unknown>;
  /** Publish the enclave's envelope signature with the decision. */
  signEnvelope?: boolean;
  nonce: number;
  txs: Decision["txs"];
  healthBefore: number | null;
  healthAfter: number | null;
  routes: RouteComparison | null;
};

function buildDecision(seed: DecisionSeed, now: number): Decision {
  const createdAt = now - seed.minutesAgo * 60_000;
  const request = JSON.stringify({ model: REVIEW_MODEL, purpose: "guardian-review", plan: seed.plan, trigger: seed.trigger });
  const response = JSON.stringify({ verdict: seed.verdict, reasoning: seed.reasoning });
  const requestHash = sha256Hex(request);
  const responseHash = sha256Hex(response);
  const signedText = `${REVIEW_MODEL}:${requestHash}:${responseHash}`;
  const signature = signEip191(signedText);
  const chatId = `chatcmpl-${sha256Hex(`parry-e2e:chat:${seed.label}`).slice(0, 24)}`;
  const record = {
    model: REVIEW_MODEL,
    chatId,
    requestHash,
    responseHash,
    signedText,
    signature,
    signingAddress: MODEL_ADDRESS,
    signatureKind: "ecdsa",
    verdict: seed.verdict,
    reasoning: seed.reasoning,
  };
  const hash = reviewHash(record);
  let envelope: string | null = null;
  let envelopeSignature: string | null = null;
  if (seed.envelopeAction) {
    envelope = JSON.stringify({
      account: ACCOUNT,
      network: "testnet",
      nonce: seed.nonce,
      issued_at: Math.floor(createdAt / 1000) - 3,
      review_hash: hash,
      trigger: { score: seed.trigger.score, tier: seed.trigger.tier, health_bps: seed.trigger.healthBps },
      action: seed.envelopeAction,
    });
    if (seed.signEnvelope) envelopeSignature = toBase64(ed25519.sign(envelopeDigest(envelope), ENCLAVE_SECRET));
  }
  return {
    id: envelope ? sha256Hex(envelope) : hash,
    account: ACCOUNT,
    venue: (seed.action.startsWith("hl_") ? "hyperliquid" : seed.action.startsWith("evm_") ? "evm" : "rhea") as Decision["venue"],
    action: seed.action,
    plan: seed.plan,
    trigger: seed.trigger,
    outcome: seed.outcome,
    review: { model: REVIEW_MODEL, chatId, reviewHash: hash, requestHash, responseHash, verdict: seed.verdict, reasoning: seed.reasoning, signingAddress: MODEL_ADDRESS, signedText, signature, signatureKind: "ecdsa" },
    envelope,
    envelopeSignature,
    txs: seed.txs,
    healthBefore: seed.healthBefore,
    healthAfter: seed.healthAfter,
    routes: seed.routes,
    createdAt: iso(createdAt),
  };
}

export function routeComparison(amountNear: number): RouteComparison {
  const value = amountNear * NEAR_PRICE;
  return {
    amountNear,
    rhea: { outUsd: Math.round(value * 0.9961 * 1e6) / 1e6, priceImpact: 0.0039, poolId: 0 },
    intents: { outUsd: Math.round(value * 0.9978 * 1e6) / 1e6, confidential: false, dry: true },
    chosen: "rhea",
    reason: "testnet: the account settles on the Rhea pool; the 1Click quote is shown for comparison",
  };
}

let decisionCache: { at: number; list: Decision[] } | null = null;

/** Newest first: an executed repay whose every check passes, an EVM repay verified by the MPC network, a rejected deleverage, a Hyperliquid reduce. */
export function decisions(now: number): Decision[] {
  // Signing is deterministic per timestamp; reuse within the same second.
  if (decisionCache && Math.abs(decisionCache.at - now) < 1000) return decisionCache.list;
  const list = [
    buildDecision(
      {
        label: "repay",
        minutesAgo: 14,
        action: "repay",
        plan: "Repay 54.40 USDC from the reserve to lift health from 1.04 to 1.45 (repay first).",
        trigger: { score: 85, tier: "critical", healthBps: 10432 },
        outcome: "executed",
        verdict: "approve",
        reasoning: "Health is 1.04 with a 97% chance of liquidation within a day. Repaying 54.40 USDC is within the daily cap and leaves health at 1.45. The action moves no funds out of the account.",
        envelopeAction: { repay: { token: CONTRACTS.usdc, amount: "54404724" } },
        signEnvelope: true,
        nonce: 7,
        txs: { action: txHash("repay-action"), record: txHash("repay-record"), hyperliquid: null, evm: null },
        healthBefore: 1.0432,
        healthAfter: 1.45,
        routes: null,
      },
      now,
    ),
    buildDecision(
      {
        label: "evm-repay",
        minutesAgo: 41,
        action: "evm_repay",
        plan: "Repay 120 USDC of the Aave loan on Base Sepolia from the account's own EVM address, signed by Chain Signatures.",
        trigger: { score: 64, tier: "danger", healthBps: 11120 },
        outcome: "executed",
        verdict: "approve",
        reasoning: "The Aave health factor is 1.11 and falling. Repaying 120 USDC is under the guard's cap per action and goes only to the mandate's pool.",
        envelopeAction: { evm_repay: { amount: "120000000" } },
        signEnvelope: true,
        nonce: 6,
        txs: {
          action: txHash("evm-action"),
          record: txHash("evm-record"),
          hyperliquid: null,
          evm: `0x${sha256Hex("parry-e2e:evm-repay")}`,
          evmVerify: txHash("evm-verify"),
          evmVerified: "verified",
        },
        healthBefore: 1.112,
        healthAfter: 1.38,
        routes: null,
      },
      now,
    ),
    buildDecision(
      {
        label: "deleverage",
        minutesAgo: 96,
        action: "deleverage",
        plan: "Sell 22.4 wNEAR for at least 62.18 USDC on the Rhea pool and repay, in one step.",
        trigger: { score: 58, tier: "danger", healthBps: 10812 },
        outcome: "rejected_by_review",
        verdict: "reject",
        reasoning: "The plan sells collateral while the reserve still holds enough USDC to repay. Repaying first keeps the position's exposure, so the deleverage is not needed yet.",
        nonce: 5,
        txs: { action: null, record: txHash("deleverage-record"), hyperliquid: null, evm: null },
        healthBefore: 1.0812,
        healthAfter: null,
        routes: routeComparison(22.4),
      },
      now,
    ),
    buildDecision(
      {
        label: "hl-reduce",
        minutesAgo: 60 * 26,
        action: "hl_reduce",
        plan: "Close 25% of the Hyperliquid NEAR perp with a reduce-only order inside the 1% band.",
        trigger: { score: 52, tier: "danger", healthBps: 11240 },
        outcome: "executed",
        verdict: "approve",
        reasoning: "The perp is 12% from its liquidation price in an extreme Tremor reading. Reducing a quarter of it is within the size cap and the price band.",
        envelopeAction: { hl_reduce: { order: { asset_index: 4, is_buy: false, price: "2.95", size: "40", reduce_only: true, tif: "Ioc" }, nonce: 1794200000000 } },
        signEnvelope: false,
        nonce: 4,
        txs: { action: txHash("hl-action"), record: txHash("hl-record"), hyperliquid: `0x${sha256Hex("parry-e2e:hl-order")}`, evm: null },
        healthBefore: 1.124,
        healthAfter: 1.42,
        routes: null,
      },
      now,
    ),
  ];
  decisionCache = { at: now, list };
  return list;
}

/** A decision whose review was altered after signing: its review hash check fails. */
export function tamperedDecision(now: number): Decision {
  const d = decisions(now)[0]!;
  return { ...d, id: `${d.id.slice(0, 63)}0`, review: { ...d.review, reasoning: `${d.review.reasoning} Edited.` } };
}

/** The API's own verification of a decision (`/verify`). */
export function verification(d: Decision): Verification {
  const executed = d.envelope !== null;
  return {
    id: d.id,
    checks: [
      { name: "review signature recovers to the signing address", ok: true, detail: `EIP-191 signature recovers to ${MODEL_ADDRESS}` },
      { name: "the signing address is attested by NEAR AI Cloud", ok: true, detail: `${REVIEW_MODEL} runs in a TEE with this address` },
      { name: "review hash on chain matches", ok: executed, detail: executed ? "the account's guardian_executed event carries this review hash" : "no action on chain: the review rejected the plan" },
      { name: "envelope signed by the enclave key", ok: executed, detail: executed ? `signed by ${ENCLAVE_PUBLIC_KEY}` : "no envelope" },
      { name: "enclave key bound to the published wasm", ok: true, detail: "the risk board's key was registered for the published build" },
    ],
    verifyUrl: "https://cloud.near.ai/verify",
  };
}

// ---------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------

export function alerts(now: number): Alert[] {
  const at = (min: number) => iso(now - min * 60_000);
  return [
    {
      id: "4",
      account: ACCOUNT,
      kind: "health",
      severity: "critical",
      title: "Rhea wNEAR/USDC: health 1.05",
      body: "Health is below your threshold of 1.25. Liquidation starts at 1.00.",
      status: "open",
      createdAt: at(21),
      updatedAt: at(1),
    },
    {
      id: "3",
      account: ACCOUNT,
      kind: "risk",
      severity: "critical",
      title: "Rhea wNEAR/USDC: risk 85 (critical)",
      body: "The risk score crossed your threshold of 50. Median time to liquidation: about 3 hours.",
      status: "open",
      createdAt: at(22),
      updatedAt: at(1),
    },
    {
      id: "2",
      account: ACCOUNT,
      kind: "cascade",
      severity: "warning",
      title: "Cascade pressure on NEAR: 18%",
      body: "A 2σ fall would liquidate $52.3K of collateral across monitored positions.",
      status: "acknowledged",
      createdAt: at(95),
      updatedAt: at(40),
    },
    {
      id: "1",
      account: ACCOUNT,
      kind: "guardian",
      severity: "info",
      title: "The guardian repaid 54.40 USDC",
      body: "Health went from 1.04 to 1.45. The AI review approved the plan before it ran.",
      status: "resolved",
      createdAt: at(14),
      updatedAt: at(13),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Vault and reserves
// ---------------------------------------------------------------------------------------------

export const RESERVE_LEAVES: ReserveLeaf[] = [
  { asset: "LINEAR", venue: "near", amount: "14377400000000000000000000000", usdE6: "44600000000" },
  { asset: "USDC", venue: "near", amount: "1250000000", usdE6: "1250000000" },
  { asset: "USDC", venue: "hyperliquid", amount: "3100400000", usdE6: "3100400000" },
  { asset: "NEAR-PERP", venue: "hyperliquid", amount: "15020000000", usdE6: "0" },
];
export const RESERVES_ROOT = reserveRoot(RESERVE_LEAVES);

export function reserves(now: number): Reserves {
  return { root: RESERVES_ROOT, ratioBps: 10145, reportAt: iso(now - 240_000), leaves: RESERVE_LEAVES.map((l) => ({ ...l, proof: reserveProof(RESERVE_LEAVES, l) })) };
}

export function vault(now: number, empty = false): VaultView {
  if (empty) {
    return {
      network: "testnet",
      paused: false,
      riskScore: 0,
      reportAt: null,
      sharePriceUsd: 1,
      navUsd: 0,
      totalShares: "0",
      queuedShares: "0",
      stakedLinear: "0",
      linearRate: 1.0842,
      nearPriceUsd: NEAR_PRICE,
      hedge: { targetNear: 0, currentNear: 0, entry: 0, mark: 0, liquidation: 0, leverage: 0, maxLeverage: 3, hedgeRatio: 0.9, needsMargin: false, address: null, accountValueUsd: 0, fundingUsd: 0, lastOrder: null, marginRoute: null },
      yield: { stakingApr: null, fundingUsd: 0, hedgePnlUsd: 0 },
      reserves: null,
      depositCapNear: "500000000000000000000000000000",
      minDepositNear: "1000000000000000000000000",
      queueLength: 0,
    };
  }
  return {
    network: "testnet",
    paused: false,
    riskScore: 22,
    reportAt: iso(now - 240_000),
    sharePriceUsd: 1.0213,
    navUsd: 48_250.4,
    totalShares: "47244600000000000000000000000",
    queuedShares: "1200000000000000000000000000",
    stakedLinear: "14377400000000000000000000000",
    linearRate: 1.0842,
    nearPriceUsd: NEAR_PRICE,
    hedge: {
      targetNear: 15_183,
      currentNear: 15_020,
      entry: 3.12,
      mark: 2.874,
      liquidation: 4.02,
      leverage: 1.8,
      maxLeverage: 3,
      hedgeRatio: 0.9,
      needsMargin: false,
      address: VAULT_HEDGE_ADDRESS,
      accountValueUsd: 24_100,
      fundingUsd: 182.4,
      lastOrder: { tx: txHash("hedge-order"), side: "sell", size: "163.0", price: "2.8597", status: "filled", at: iso(now - 300_000) },
      marginRoute: null,
    },
    yield: { stakingApr: 0.0712, fundingUsd: 182.4, hedgePnlUsd: 3_936.2 },
    reserves: { root: RESERVES_ROOT, leaves: RESERVE_LEAVES.length, totalUsd: 48_950.4, liabilitiesUsd: 48_250.4, ratioBps: 10145 },
    depositCapNear: "500000000000000000000000000000",
    minDepositNear: "1000000000000000000000000",
    queueLength: 2,
  };
}

export function vaultHistory(days: number, now: number): VaultHistoryPoint[] {
  const end = Math.floor(now / 3_600_000) * 3_600_000;
  const n = days * 24;
  const out: VaultHistoryPoint[] = [];
  for (let i = n; i >= 0; i--) {
    const x = 1 - i / n;
    const sharePriceUsd = Math.round((1.015 + 0.0063 * x + Math.sin(i / 5) * 0.0004) * 1e6) / 1e6;
    out.push({
      t: iso(end - i * 3_600_000),
      sharePriceUsd,
      navUsd: Math.round((41_200 + 7_050 * x + Math.sin(i / 9) * 120) * 100) / 100,
      riskScore: Math.round(20 + Math.sin(i / 11) * 4),
      hedgedFraction: Math.round((0.89 + Math.sin(i / 13) * 0.01) * 10_000) / 10_000,
    });
  }
  return out;
}

/** `vault_state()` on the vault contract, matching the API's vault figures. */
export function vaultChainState(now: number): VaultChainState {
  return {
    network: "testnet",
    paused: false,
    manual_paused: false,
    risk_paused: false,
    risk_score: 22,
    report_at: Math.floor(now / 1000) - 240,
    report_age_secs: 240,
    staked_linear: "14377400000000000000000000000",
    linear_rate_e24: "1084200000000000000000000",
    near_price_e8: "286121509",
    nav_e6: "48250400000",
    share_price_e6: "1021300",
    total_shares: "47244600000000000000000000000",
    active_shares: "46044600000000000000000000000",
    queued_shares: "1200000000000000000000000000",
    hedge: {
      target_e8: "1518300000000",
      current_e8: "1502000000000",
      entry_e8: "312000000",
      mark_e8: "287400000",
      liquidation_e8: "402000000",
      account_value_e6: "24100000000",
      margin_baseline_e6: "20000000000",
      unrealized_e6: "3694920000",
      funding_e6: "182400000",
      equity_e6: "4100000000",
      leverage_x100: 180,
      effective_max_leverage_x100: 300,
      hedge_ratio_bps: 9000,
      needs_margin: false,
    },
    reserves: { root: RESERVES_ROOT, leaves: RESERVE_LEAVES.length, total_usd_e6: "48950400000", liabilities_usd_e6: "48250400000", ratio_bps: 10145, at: Math.floor(now / 1000) - 240 },
    buffer_usdc: "1250000000",
    settled_pnl_e6: "0",
    loss_backing_linear: "0",
    pending_deposit_near: "0",
    deposit_cap: "500000000000000000000000000000",
    min_deposit: "1000000000000000000000000",
    queue_length: 2,
  };
}

// ---------------------------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------------------------

export function config(): Config & { dexPool: number } {
  return {
    network: "testnet",
    contracts: { ...CONTRACTS },
    dexPool: 2939,
    enclave: { publicKey: ENCLAVE_PUBLIC_KEY, sealingPublicKey: SEALING_PUBLIC_KEY, wasmSha256: sha256Hex("parry-e2e:enclave-wasm") },
    reviewModel: REVIEW_MODEL,
    explorers: { near: "https://testnet.nearblocks.io", hyperliquid: "https://app.hyperliquid-testnet.xyz/explorer", intents: "https://explorer.near-intents.org", evm: "https://sepolia.basescan.org" },
  };
}

export function stats(now: number): Stats {
  return { network: "testnet", positionsProtected: 128, positionsWatched: 3252, valueProtectedUsd: 184_310.5, insuranceUsd: 7.73, rescues: 17, vaultTvlUsd: 48_250.4, vaultRiskScore: 22, updatedAt: iso(now) };
}

export function simulation(): SimulationResult {
  return {
    account: ACCOUNT,
    triggered: true,
    reason: "health 1.045 is below the 1.45 target",
    mandate: true,
    steps: [
      { kind: "repay", amount: "30", healthBefore: 1.0454, healthAfter: 1.2346 },
      { kind: "deleverage", amount: "22.4", minOut: "62.18", healthBefore: 1.2346, healthAfter: 1.4512 },
    ],
    reached: true,
    routes: routeComparison(22.4),
  };
}

export function rates(now = Date.now()) {
  return {
    rhea: [
      { asset: "wNEAR", tokenId: CONTRACTS.wnear, supplyApr: 0.0214, borrowApr: 0.0481, utilization: 0.44, source: `${CONTRACTS.lending} get_assets_paged_detailed` },
      { asset: "USDC", tokenId: CONTRACTS.usdc, supplyApr: 0.0612, borrowApr: 0.0893, utilization: 0.71, source: `${CONTRACTS.lending} get_assets_paged_detailed` },
    ],
    hyperliquid: { fundingHourly: 0.0000125, funding24hApr: 0.1095, source: "https://api.hyperliquid-testnet.xyz/info metaAndAssetCtxs and fundingHistory (NEAR)" },
    vault: { stakingApr: 0.0446, fundingApr: 0.0612, netApr: 0.0951, insuranceShareBps: 1000, source: `${CONTRACTS.vault} yield_breakdown` },
    readAt: iso(now - 40_000),
  };
}

export function status(now: number): StatusView {
  const at = (s: number) => iso(now - s * 1000);
  return {
    network: "testnet",
    services: [
      { name: "alerts", ok: true, detail: "14 delivered since start; push on, Telegram on", checkedAt: at(4) },
      { name: "guardian", ok: true, detail: "3 decisions, 0 skipped", checkedAt: at(9) },
      { name: "indexer", ok: true, detail: "following testnet through FastNEAR", checkedAt: at(6) },
      { name: "keeper", ok: true, detail: "vault-report: signed 4 min ago; rebalance: within band; withdrawals: 2 queued", checkedAt: at(12) },
      { name: "monitor", ok: true, detail: `reading ${CONTRACTS.lending}`, checkedAt: at(3) },
      { name: "relayer", ok: true, detail: "/owner ok", checkedAt: at(40) },
      { name: "risk", ok: true, detail: "2 positions scored", checkedAt: at(3) },
      { name: "risk-publisher", ok: true, detail: `last report ${txHash("risk-report")}`, checkedAt: at(18) },
      { name: "topup", ok: false, detail: "relayer.parry.testnet is below half its target", checkedAt: at(70) },
    ],
    oracle: { publishTime: at(6), ageSeconds: 6, fresh: true },
    indexer: { lastBlock: 221_455_120, lagBlocks: 3 },
    lanes: [
      { service: "monitor", account: "monitor.parry.testnet", key: "ed25519:8XkVnUcdg4G5Wbbx2N9b8ZgXk7Q1L3iDqHq8Ft2kE5Vy", nonces: 4 },
      { service: "keeper", account: "keeper.parry.testnet", key: "ed25519:5mT3qK9hY2dW7nR4vB8cX1zL6pF9sG3jH2kN7wQ4eR8t", nonces: 4 },
      { service: "relayer", account: "relayer.parry.testnet", key: "ed25519:3qSCZjoqvSGWrKcSBgqHS25wBpUYMMyk6Jfg7BK6mh9G", nonces: 8 },
    ],
    treasury: {
      account: "treasury.parry.testnet",
      balanceNear: 182.4,
      low: false,
      postQuantumKey: true,
      wallets: [
        { name: "guardian", account: "guardian.parry.testnet", balanceNear: 9.2, target: 10 },
        { name: "keeper", account: "keeper.parry.testnet", balanceNear: 14.8, target: 10 },
        { name: "monitor", account: "monitor.parry.testnet", balanceNear: 8.05, target: 5 },
        { name: "relayer", account: "relayer.parry.testnet", balanceNear: 3.1, target: 20 },
        { name: "monitor gas key", account: "monitor.parry.testnet", balanceNear: 1.84, target: 2 },
        { name: "keeper gas key", account: "keeper.parry.testnet", balanceNear: 1.2, target: 2 },
        { name: "relayer gas key", account: "relayer.parry.testnet", balanceNear: 4.6, target: 5 },
      ],
    },
  };
}

export function settings(account: string): Settings {
  return {
    account,
    thresholds: { score: 50, health: 1.25, cascade: 0.5 },
    displayCurrency: "USD",
    telegram: { linked: false, deepLink: null, available: true },
    email: { address: null, digest: "off" },
    push: false,
    vapidPublicKey: VAPID_PUBLIC_KEY,
  };
}

export function fx(now: number): Fx & { source: string } {
  return {
    base: "USD",
    rates: { USD: 1, EUR: 0.892449, GBP: 0.744696, JPY: 158.023471, CHF: 0.81965, CAD: 1.411275, AUD: 1.448015, SGD: 1.279506, HKD: 7.84232, AED: 3.6725, INR: 93.929192, CNY: 6.686583 },
    updatedAt: iso(now - 6 * 3_600_000),
    source: "open.er-api.com",
  };
}

export function copilot(): CopilotAnswer {
  return {
    answer:
      "This position is about 4% above its liquidation price of $2.74, so a small fall in NEAR would liquidate it. With volatility high, the chance of that within a day is about 97%. Repaying around 54 USDC or adding collateral would bring health back to 1.45; your guardian's mandate allows it to repay on its own.",
    model: REVIEW_MODEL,
    chatId: `chatcmpl-${sha256Hex("parry-e2e:copilot").slice(0, 24)}`,
    verified: true,
    signingAddress: MODEL_ADDRESS,
    verifyUrl: "https://cloud.near.ai/verify",
  };
}

/** The test oracle's shock (prices e8), active for 25 more minutes. */
export function shock(now: number, bps: number | null = -2000): ShockState {
  const s = Math.floor(now / 1000);
  const fed = 286_121_509;
  const shocked = bps === null ? fed : Math.floor((fed * (10_000 + bps)) / 10_000);
  return {
    shock: bps === null ? null : { bps, by: "relayer.parry.testnet", at: s - 300, expires_at: s + 1_500, shocked_price: String(shocked), fed_price: String(fed) },
    price: { price: String(shocked), conf: "1054652", expo: -8, publish_time: s - 5 },
  };
}

export function riskCheck(now: number) {
  return { account: ACCOUNT, network: "testnet" as const, checkedAt: iso(now), position: positions(now)[0]!, market: market(now), model: "docs/risk-model.md" as const };
}

// ---------------------------------------------------------------------------------------------
// Replay, heatmap, prices, insurance, certificates, savings, incidents, watched accounts
// ---------------------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

export function replay() {
  const start = Date.parse("2022-05-09T00:00:00.000Z");
  const t = (h: number) => iso(start + h * HOUR_MS);
  const crash = (id: string, name: string, drop: number, avoided: boolean) => ({
    id,
    name,
    start: t(0),
    end: t(72),
    dropPct: drop,
    candles: Array.from({ length: 73 }, (_, h) => ({ t: t(h), price: 5 * (1 - (drop / 100) * Math.min(1, h / 60)) })),
    position: {
      startHealth: 1.6,
      warningHours: 24,
      liquidatedAt: t(50),
      liquidatedWithParryAt: avoided ? null : t(66),
      predictedHoursAtWarning: 22,
      steps: [
        { t: t(26), action: "repay", plan: "Repay 80 USDC from the reserve (score 68, health 1.14).", healthBefore: 1.14, healthAfter: 1.45 },
        { t: t(44), action: "deleverage", plan: "Sell 40 NEAR for 120 USDC and repay (score 73, health 1.2).", healthBefore: 1.2, healthAfter: 1.45 },
      ],
      healthWith: Array.from({ length: 73 }, (_, h) => ({ t: t(h), h: Math.max(1.1, 1.6 - h * 0.006) })),
      healthWithout: Array.from({ length: 73 }, (_, h) => ({ t: t(h), h: 1.6 - h * 0.012 })),
    },
    vault: {
      navWith: Array.from({ length: 73 }, (_, h) => ({ t: t(h), v: 1 - h * 0.0003 })),
      navUnhedged: Array.from({ length: 73 }, (_, h) => ({ t: t(h), v: 1 - (drop / 100) * Math.min(1, h / 60) })),
      maxDrawdownPct: 2.7,
      maxDrawdownUnhedgedPct: drop,
      marginMin: 0.5,
      insurancePaidUsd: 5.48,
    },
  });
  return {
    source: "https://data-api.binance.vision/api/v3/klines?symbol=NEARUSDT&interval=1h",
    sources: { candles: "Binance spot, hourly NEARUSDT", funding: "Binance USD-M funding", staking: "LiNEAR ft_price: 4.46 % a year", model: "packages/core" },
    generatedAt: iso(start + 400 * 24 * HOUR_MS),
    crashes: [crash("2022-05", "9 May 2022 to 12 May 2022", 51.7, false), crash("2021-05", "21 May 2021 to 23 May 2021", 45.6, true)],
    summary: { crashes: 2, medianWarningHours: 24.5, minWarningHours: 7, liquidationsWithout: 2, liquidationsAvoided: 1, medianVaultDrawdownPct: 2.7, medianUnhedgedDrawdownPct: 48.6 },
  };
}

export function heatmap(now: number, network = "testnet") {
  const price = 3.62;
  return {
    network,
    lending: CONTRACTS.lending,
    price,
    buckets: [0.97, 0.9, 0.82, 0.71, 0.6, 0.52].map((f, i) => ({ price: price * f, collateralUsd: [1200, 40_000, 8000, 450_000, 2_600_000, 30_000][i]!, debtUsd: [800, 26_000, 5000, 300_000, 1_700_000, 20_000][i]!, accounts: [2, 9, 3, 41, 77, 5][i]! })),
    cascades: [{ from: price * 0.6, to: price * 0.585, collateralUsd: 2_583_064, accounts: 77, rounds: 2 }],
    pressure: { atRiskUsd: 41_200, pressure: 0.00025, to: price * 0.92, accounts: 11 },
    sweep: { totalAccounts: 73_008, nextIndex: 15_000, lastFullSweepAt: null },
    readAt: iso(now - 60_000),
    accounts: 137,
    source: `${CONTRACTS.lending} get_accounts_paged; market depth 1500000 USD per 2 %`,
  };
}

export function prices(now: number) {
  const row = (id: string, symbol: string, priceUsd: number, change24h: number) => ({ id, symbol, priceUsd, change24h, source: "aggregate-oracle.near" });
  return { tokens: [row("wrap.near", "NEAR", 3.62, -0.021), row("linear-protocol.near", "LINEAR", 5.19, -0.019), row("meta-pool.near", "STNEAR", 5.5, -0.02), row("usdc", "USDC", 0.9998, 0)], readAt: iso(now - 20_000) };
}

export function insurance(now: number) {
  return {
    available: true,
    shareBps: 1000,
    linear: "1200000000000000000000000",
    usdcE6: "1500000",
    valueUsdE6: "7731000",
    paidTotalE6: "2930000",
    paidTodayE6: "0",
    capPerDayBps: 50,
    marginReservedUsdE6: "0",
    events: [
      { kind: "inflow", at: iso(now - 6 * HOUR_MS), amountE6: "410000" },
      { kind: "payout", at: iso(now - 30 * HOUR_MS), reason: "negative_funding", amountE6: "2930000" },
    ],
    source: `${CONTRACTS.vault} insurance()`,
  };
}

/** A health certificate signed with the fixture enclave key, for `reader`, with real hashing. */
export function certificate(now: number, reader = "lender.testnet", threshold = 1.3) {
  const issued = Math.floor(now / 1000) - 600;
  const body = { kind: "parry-health-certificate", version: 1, account: ACCOUNT, reader, venue: "rhea", threshold, block_height: 221_455_000, block_hash: "8iPzcDmfqTy9NJuB3TJm2sFxvFmQ1nGxu7kT3KcRZ2fV", issued_at: issued, expires_at: issued + 86_400, statement: `health is at least ${threshold}` };
  const text = JSON.stringify(body);
  const digest = sha256(`parry-certificate:v1:${text}`);
  return { hash: toHex(digest), certificate: text, signature: toBase64(ed25519.sign(digest, ENCLAVE_SECRET)), enclavePublicKey: ENCLAVE_PUBLIC_KEY, anchorTx: txHash(`certificate:${reader}`), createdAt: iso(issued * 1000) };
}

export function savings(now: number) {
  return {
    totalSavedUsd: 3.12,
    rescues: [
      { decision: "d1", chosen: { venue: "rhea", outUsd: 120.4 }, worst: { venue: "intents", outUsd: 117.28 }, savedUsd: 3.12, quotes: [], at: iso(now - 3 * HOUR_MS) },
    ],
  };
}

export function incidents(now: number) {
  const list = alerts(now);
  return [
    {
      id: "inc-1",
      account: ACCOUNT,
      title: "Health falling on Rhea",
      body: "Three alerts in 15 minutes: the score crossed 60, then health went under 1.2.",
      severity: "critical",
      alerts: list.slice(0, 2),
      openedAt: iso(now - 2 * HOUR_MS),
      closedAt: null,
    },
  ];
}
