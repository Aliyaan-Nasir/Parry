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
  /** Collateral (USD) of positions on protected accounts with a live mandate. */
  valueProtectedUsd?: number;
  /** Positions the monitor reads, protected or not. */
  positionsWatched?: number;
  /** The vault insurance fund's value (0 until the vault has one). */
  insuranceUsd?: number;
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
    /** The volatility regime, with thresholds calibrated on NEAR's crashes (docs/risk-model.md). */
    regime?: Regime;
    windows: { hours: number; sigma: number | null }[];
  };
  cascade: {
    pressure: number;
    atRiskUsd: number;
    correlatedOwners: number;
    /** "heatmap": every Rhea lending borrower on `network`; "positions": the positions Parry monitors. */
    source?: "heatmap" | "positions";
    network?: Network | null;
    accounts?: number;
  };
}

export type Regime = "calm" | "stressed" | "panic";

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
  /** Why the planner chose this step and skipped the earlier ones in the policy's order; null for decisions without one. */
  explanation?: RescueExplanation | null;
  createdAt: string;
}

export interface RescueExplanation {
  step: string;
  why: string;
  skipped: { step: string; reason: string }[];
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
  hedgedFraction?: number;
  /** Cumulative staking yield and funding (USD); null for points recorded before they were. */
  stakingYieldUsd?: number | null;
  fundingYieldUsd?: number | null;
  hedgeRatio?: number | null;
  insuranceUsd?: number | null;
  reservesRoot?: string | null;
  /** LiNEAR's staking yield plus the funding the short earns, a year. */
  basisApr?: number | null;
  /** 1 − share price / the best share price so far. */
  drawdown?: number | null;
  /** Hedge account value over the short's notional. */
  marginRatio?: number | null;
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

/** One Rhea lending asset in `GET /v1/rates`. APRs and utilization are fractions. */
export interface Rate {
  asset: string;
  tokenId: string;
  supplyApr: number;
  borrowApr: number;
  utilization: number;
  source: string;
}

export interface Rates {
  rhea: Rate[];
  hyperliquid: { fundingHourly: number | null; funding24hApr: number | null; source: string };
  vault: { stakingApr: number | null; fundingApr: number | null; netApr: number | null; insuranceShareBps: number | null; source: string };
  readAt: string;
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
  /** Each service's last 48 hours by the hour: its reports and how many were ok (an hour with no reports is absent). */
  uptime?: { name: string; ratio: number | null; hours: { hour: string; checks: number; ok: number }[] }[];
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

// ---------------------------------------------------------------------------------------------
// Crash replay, verification, watched accounts, certificates and the market views
// ---------------------------------------------------------------------------------------------

export interface ReplayCrash {
  id: string;
  name: string;
  start: string;
  end: string;
  dropPct: number;
  candles: { t: string; price: number; low?: number }[];
  position: {
    startHealth: number;
    warningHours: number | null;
    liquidatedAt: string | null;
    liquidatedWithParryAt?: string | null;
    predictedHoursAtWarning?: number | null;
    steps: { t: string; action: string; plan: string; healthBefore: number; healthAfter: number }[];
    healthWith: { t: string; h: number }[];
    healthWithout: { t: string; h: number }[];
  };
  vault: {
    navWith: { t: string; v: number }[];
    navUnhedged: { t: string; v: number }[];
    maxDrawdownPct: number;
    maxDrawdownUnhedgedPct?: number;
    marginMin: number;
    insurancePaidUsd: number;
  };
}

export interface Replay {
  source: string;
  sources?: Record<string, string>;
  generatedAt?: string;
  crashes: ReplayCrash[];
  summary: { medianWarningHours: number | null; liquidationsAvoided: number; crashes: number; [k: string]: unknown };
  calibration?: { regime: { stressed: number; panic: number; [k: string]: unknown }; [k: string]: unknown };
}

export interface VerifyResult {
  kind: "decision" | "certificate" | "transaction";
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  subject: Record<string, unknown>;
}

export interface WatchThresholds {
  score: number;
  health: number;
}

export interface WatchRow {
  account: string;
  label: string | null;
  thresholds: WatchThresholds;
  position: Position | null;
  /** The alerts the position raises now at these thresholds (empty when none). */
  alert: { kind: "risk" | "health"; severity: "info" | "warning" | "critical"; title: string; body: string }[];
}

/** The certificate JSON the enclave signs (internal/INTERFACES.md, section 4). */
export interface CertificateBody {
  kind: "parry-health-certificate";
  version: 1;
  account: string;
  reader: string;
  venue: string;
  threshold: number;
  block_height: number;
  block_hash: string;
  issued_at: number;
  expires_at: number;
  statement: string;
}

export interface Certificate {
  /** Hex SHA-256 of "parry-certificate:v1:" + the certificate JSON: the digest the enclave signed and the risk board's key. */
  hash: string;
  /** The exact certificate JSON text the enclave signed. */
  certificate: string;
  /** The enclave's ed25519 signature over the digest (standard base64). */
  signature: string;
  enclavePublicKey: string;
  anchorTx: string | null;
  createdAt: string;
}

export interface CertificateRequest {
  account: string;
  reader: string;
  threshold: number;
  ttlSecs: number;
  venue?: string;
  anchor?: boolean;
}

/** The risk board's `certificate(hash)` record. */
export interface CertificateAnchor {
  hash: string;
  reader: string;
  expires_at: number;
  at: number;
}

export interface RouteSavings {
  totalSavedUsd: number;
  rescues: {
    decision: string;
    chosen: { venue: "rhea" | "intents"; outUsd: number } | null;
    worst: { venue: "rhea" | "intents"; outUsd: number } | null;
    savedUsd: number;
    quotes: { venue: "rhea" | "intents"; outUsd: number | null; unavailable: string | null }[];
    at: string;
  }[];
}

export interface VaultInsurance {
  /** False while the deployed vault has no insurance fund (every value is then empty). */
  available: boolean;
  shareBps: number | null;
  linear: string;
  usdcE6: string;
  valueUsdE6: string;
  paidTotalE6: string;
  paidTodayE6: string;
  capPerDayBps: number | null;
  marginReservedUsdE6: string;
  events: { kind: "inflow" | "payout"; at: string; [k: string]: unknown }[];
  source: string;
}

export interface Heatmap {
  network: Network;
  price: number;
  buckets: { price: number; collateralUsd: number; debtUsd: number; accounts: number }[];
  cascades: { from: number; to: number; collateralUsd: number; accounts?: number; rounds?: number }[];
  readAt: string;
  accounts: number;
  source?: string;
}

export interface TokenPriceRow {
  id: string;
  symbol: string;
  priceUsd: number;
  /** Fraction over 24 hours, or null without a source for it. */
  change24h: number | null;
  source: string;
}

export interface Prices {
  tokens: TokenPriceRow[];
  readAt: string;
}

export interface Incident {
  id: string;
  account: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  alerts: Alert[];
  openedAt: string;
  closedAt: string | null;
}

export type StreamEvent = "alert" | "decision" | "position" | "price" | "vault" | "status";
