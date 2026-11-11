/**
 * Types of the Parry API (docs/api.md) and of the contracts' JSON views.
 * Contract types keep the contracts' snake_case field names; amounts are decimal strings.
 */

import type { Network } from "./networks.js";

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export type Tier = "safe" | "caution" | "danger" | "critical";
export type Venue = "rhea" | "hyperliquid" | "aave";

export interface Stats {
  network: Network;
  positionsProtected: number;
  rescues: number;
  vaultTvlUsd: number;
  vaultRiskScore: number;
  updatedAt: string;
}

export interface Config {
  network: Network;
  contracts: {
    factory: string;
    vault: string;
    risk: string;
    oracle: string | null;
    lending: string;
    dex: string;
    signer: string;
    usdc: string;
    wnear: string;
    linear: string;
  };
  enclave: { publicKey: string; sealingPublicKey: string | null; wasmSha256: string };
  reviewModel: string;
  explorers: { near: string; hyperliquid: string; intents: string; evm: string };
}

export interface Market {
  near: { priceUsd: number; hlMid: number | null; updatedAt: string };
  tremor: {
    sigmaHourly: number;
    annual: number;
    level: "calm" | "elevated" | "high" | "extreme";
    windows: { hours: number; sigma: number | null }[];
  };
  cascade: { pressure: number; atRiskUsd: number; correlatedOwners: number };
}

export interface Position {
  /** `<account>:<venue>:<name>` */
  id: string;
  account: string;
  venue: Venue;
  label: string;
  collateralUsd: number;
  debtUsd: number;
  /** null without debt */
  health: number | null;
  liqPrice: number | null;
  /** 0..1 */
  distance: number;
  /** 0..100 */
  score: number;
  tier: Tier;
  probability24h: number;
  ttlHours: number | null;
  valueAtRisk99: number;
  updatedAt: string;
}

export interface AccountSummary {
  account: string;
  owner: { kind: "passkey" | "near"; id: string };
  /** The contract's `mandate()` view. */
  mandate: MandateView | null;
  positions: Position[];
  /** The account's Chain Signatures address on Hyperliquid. */
  hyperliquidAddress: string;
  /** And on EVM chains. */
  evmAddress: string;
  stats: { guardianActions: number; deleverages: number };
}

export interface HistoryPoint {
  t: string;
  health: number | null;
  score: number;
  price: number;
}

export interface RiskCheck {
  account: string;
  checkedAt: string;
  /** null when the account has no lending position */
  position: Position | null;
  /** The risk engine's latest market report, null before the first one. */
  market: MarketReport | null;
  model: "docs/risk-model.md";
}

/** The risk engine's market report: the NEAR price it scored at, its Tremor index and cascade pressure. */
export interface MarketReport {
  /** NEAR in USD. */
  price: number;
  tremor: Market["tremor"];
  cascade: Market["cascade"];
}

export interface SimulationStep {
  kind: "repay" | "add_collateral" | "deleverage" | "hl_reduce";
  amount: string;
  minOut?: string;
  healthBefore: number;
  healthAfter: number;
}

export interface Simulation {
  account: string;
  triggered: boolean;
  reason: string;
  steps: SimulationStep[];
  routes: RouteComparison | null;
}

export interface DecisionReview {
  model: string;
  chatId: string;
  reviewHash: string;
  verdict: "approve" | "reject";
  reasoning: string;
  signingAddress: string;
  signedText: string;
  signature: string;
  signatureKind: string;
  /** SHA-256 (hex) of the request body sent to the model. Derived from `signedText` when absent. */
  requestHash?: string;
  /** SHA-256 (hex) of the model's response body. Derived from `signedText` when absent. */
  responseHash?: string;
}

export interface Decision {
  /** The envelope hash. */
  id: string;
  account: string;
  venue: Venue;
  /** repay | add_collateral | deleverage | hl_reduce | hl_hedge | evm_approve | evm_repay */
  action: string;
  plan: string;
  trigger: { score: number; tier: Tier; healthBps: number };
  outcome: "executed" | "refused" | "rolled_back" | "rejected_by_review" | "pending";
  review: DecisionReview;
  /** The exact envelope JSON text the enclave signed. */
  envelope: string | null;
  /** The enclave's ed25519 signature over the envelope (standard base64), when published. */
  envelopeSignature?: string | null;
  txs: {
    action: string | null;
    record: string | null;
    hyperliquid: string | null;
    evm: string | null;
    /** The NEAR transaction in which the MPC network verified the EVM transaction. */
    evmVerify?: string | null;
    evmVerified?: "verified" | "failed" | null;
  };
  healthBefore: number | null;
  healthAfter: number | null;
  routes: RouteComparison | null;
  createdAt: string;
}

export interface DecisionPage {
  items: Decision[];
  next: string | null;
}

export interface Verification {
  id: string;
  checks: { name: string; ok: boolean; detail: string }[];
  verifyUrl: string;
  /** "checked" when the API verified the model's Intel TDX and NVIDIA GPU attestation with NEAR AI's inference SDK. */
  attestation?: string;
  ok?: boolean;
}

export interface Alert {
  id: string;
  account: string;
  kind: "risk" | "health" | "cascade" | "guardian" | "vault";
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
  updatedAt: string;
}

export interface VaultState {
  network: string;
  paused: boolean;
  riskScore: number;
  reportAt: string | null;
  sharePriceUsd: number;
  navUsd: number;
  totalShares: string;
  queuedShares: string;
  stakedLinear: string;
  linearRate: number;
  nearPriceUsd: number;
  hedge: {
    targetNear: number;
    currentNear: number;
    entry: number;
    mark: number;
    liquidation: number;
    leverage: number;
    maxLeverage: number;
    hedgeRatio: number;
    needsMargin: boolean;
    accountValueUsd: number;
    fundingUsd: number;
    /** The vault's Chain Signatures address on Hyperliquid. */
    address: string | null;
    /** The latest signed hedge order: the NEAR transaction that signed it and Hyperliquid's answer. */
    lastOrder: { tx: string; side: "buy" | "sell"; size: string; price: string; status: string; at: string } | null;
    /** When the hedge needs margin: the dry-run 1Click route from USDC on NEAR to USDC on HyperCore. */
    marginRoute: { amountUsd: number; outUsd: number | null; unavailable: string | null; at: string } | null;
  };
  yield: { stakingApr: number | null; fundingUsd: number; hedgePnlUsd: number };
  reserves: { root: string; leaves: number; totalUsd: number; liabilitiesUsd: number; ratioBps: number };
  depositCapNear: string;
  minDepositNear: string;
  queueLength: number;
}

/** One point of `GET /v1/vault/history`. */
export interface VaultPoint {
  t: string;
  sharePriceUsd: number;
  navUsd: number;
  riskScore: number;
}

export interface ReserveLeafWithProof {
  asset: string;
  venue: string;
  amount: string;
  usdE6: string;
  proof: string[];
}

export interface Reserves {
  root: string;
  ratioBps: number;
  reportAt: string;
  leaves: ReserveLeafWithProof[];
}

/** One row of `GET /v1/rates`. */
export interface Rate {
  /** "wNEAR", "USDC", or "Parry Earn (EARN)" for the vault's yield. */
  asset: string;
  supplyApr: number;
  /** 0 for the vault. */
  borrowApr: number;
  /** "Rhea lending", or the vault. */
  source: string;
}

export interface RouteComparison {
  amountNear: number;
  rhea: { outUsd: number; priceImpact: number; poolId: number } | null;
  intents: { outUsd: number; confidential: boolean; dry: true } | { unavailable: string };
  chosen: "rhea" | "intents";
  /** Why that route: on testnet the account settles only on the Rhea pool, whatever the quotes say (absent on older records). */
  reason?: string;
}

export interface Status {
  network: string;
  services: { name: string; ok: boolean; detail: string; checkedAt: string }[];
  oracle: { publishTime: string; ageSeconds: number; fresh: boolean } | null;
  indexer: { lastBlock: number; lagBlocks: number };
  /** Each service's gas key: its nonce lanes, 0 when unknown. */
  lanes: { service: string; account: string | null; key: string | null; nonces: number }[];
  treasury: {
    account: string;
    balanceNear: number;
    low: boolean;
    /** The treasury signs with a post-quantum ML-DSA-65 (FIPS 204) key. */
    postQuantumKey: boolean;
    wallets: { name: string; account: string; balanceNear: number; target: number }[];
  } | null;
}

// ---------------------------------------------------------------------------------------------
// Contracts (JSON as the contracts read and return it)
// ---------------------------------------------------------------------------------------------

/** The protective powers a mandate can grant. There is no power that moves funds out. */
export type Power = "repay" | "add_collateral" | "deleverage" | "hl_reduce" | "hl_hedge" | "evm_repay";
export const POWERS: ReadonlyArray<Power> = ["repay", "add_collateral", "deleverage", "hl_reduce", "hl_hedge", "evm_repay"];

export interface TokenLimit {
  token: string;
  /** Total the guardian may spend over the mandate's life, token units. */
  reserve: string;
  /** Most the guardian may move per UTC day, token units. */
  daily: string;
}

export interface HlGuard {
  asset: string;
  asset_index: number;
  max_size_e8: string;
  band_bps: number;
  hedge_is_buy: boolean;
}

export interface EvmGuard {
  chain_id: number;
  pool: string;
  asset: string;
  address: string;
  max_amount: string;
}

export interface Mandate {
  guardian_key: string;
  powers: Power[];
  limits: TokenLimit[];
  max_actions_per_day: number;
  min_health_after_bps: number;
  max_slippage_bps: number;
  hl: HlGuard | null;
  evm: EvmGuard | null;
  /** Standard base64 of the sealed policy. */
  sealed: string | null;
  /** Unix seconds. */
  expires_at: number;
}

/** `mandate()` on a protected account. */
export interface MandateView {
  mandate: Mandate;
  set_at: number;
  paused_until: number;
  expired: boolean;
  spent: [string, string][];
  moved_today: [string, string][];
  actions_today: number;
}

export interface HlOrder {
  asset_index: number;
  is_buy: boolean;
  price: string;
  size: string;
  reduce_only: boolean;
  /** "Gtc", "Ioc" or "Alo" */
  tif: string;
}

export type Owner = { passkey: { key: number[] } } | { near: { account_id: string } };

export interface Nonces {
  /** Last owner request nonce used (passkey owners). */
  owner: number;
  /** Last guardian envelope nonce used. */
  guardian: number;
}

/** `get_enclave()` on the risk board. */
export interface EnclaveKey {
  index: number;
  /** `ed25519:<base58>` */
  public_key: string;
  wasm_sha256: string;
  since: number;
  note: string;
}

/** `sealing_key()` on the risk board. */
export interface SealingKey {
  /** X25519 public key, 64 hex characters. */
  public_key: string;
  run_id: number;
  at: number;
  key_index: number;
}

export interface EnclaveInfo {
  key: EnclaveKey;
  sealingKey: SealingKey | null;
}

/** `vault_state()` on the vault contract (USD e6, prices e8, NEAR rates e24). */
export interface VaultChainState {
  network: string;
  paused: boolean;
  manual_paused: boolean;
  risk_paused: boolean;
  risk_score: number | null;
  report_at: number | null;
  report_age_secs: number | null;
  staked_linear: string;
  linear_rate_e24: string;
  near_price_e8: string;
  nav_e6: string;
  share_price_e6: string;
  total_shares: string;
  active_shares: string;
  queued_shares: string;
  hedge: {
    target_e8: string;
    current_e8: string;
    entry_e8: string;
    mark_e8: string;
    liquidation_e8: string;
    account_value_e6: string;
    margin_baseline_e6: string;
    unrealized_e6: string;
    funding_e6: string;
    equity_e6: string;
    leverage_x100: number;
    effective_max_leverage_x100: number;
    hedge_ratio_bps: number;
    needs_margin: boolean;
  };
  reserves: {
    root: string;
    leaves: number;
    total_usd_e6: string;
    liabilities_usd_e6: string;
    ratio_bps: number;
    at: number;
  } | null;
  buffer_usdc: string;
  settled_pnl_e6: string;
  loss_backing_linear: string;
  pending_deposit_near: string;
  deposit_cap: string;
  min_deposit: string;
  queue_length: number;
}

/** A WebAuthn assertion as `owner_execute` reads it. */
export interface PasskeyAssertion {
  /** base64url without padding */
  authenticator_data: string;
  /** The exact clientDataJSON text the authenticator signed. */
  client_data_json: string;
  /** r || s, 64 bytes, hex, low-s. */
  signature: string;
}
