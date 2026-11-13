# Parry API

The API (`apps/api`) serves the app, the SDK (`@parryguard/sdk`) and the MCP server (`@parryguard/mcp`).
The hosted testnet API is at `https://api.parry.market`; base path `/v1`.
JSON everywhere.
Amounts are decimal strings in the token's smallest unit (yoctoNEAR for `depositCapNear` and `minDepositNear`); numbers ending in `Usd` are dollars, numbers ending in `Near` are NEAR, and the other numbers are ratios, prices or counts.
Every response carries `network` (`testnet` or `mainnet`) where it matters.
Reads need no key.
Writes that change a person's settings need a sign-in (section "Auth").

## Overview

| Method | Path | What it returns |
| --- | --- | --- |
| GET | `/`, `/live`, `/health` | `{ name, network, docs }`, `{ ok }`, and `{ ok, network }` after a database round trip |
| GET | `/v1/stats` | `Stats` for the site's live strip |
| GET | `/v1/config` | `Config`: network, contract ids, the Rhea pool, the enclave's keys, the review model, explorer URLs |
| GET | `/v1/market` | `Market`: NEAR price, Tremor index, cascade pressure (`503` before the first market report) |
| GET | `/v1/accounts/{accountId}` | `AccountSummary`: a protected account, its mandate and positions (`404` if it is not a Parry account) |
| GET | `/v1/accounts/by-owner/{owner}` | `string[]`: the protected accounts of an owner (a NEAR account id, or the passkey key given at creation), oldest first |
| GET | `/v1/accounts/{accountId}/positions` | `Position[]`, highest score first |
| GET | `/v1/accounts/{accountId}/portfolio` | `Portfolio`: totals, vault shares and PnL |
| GET | `/v1/positions/{positionId}/history?hours=24` | `HistoryPoint[]`, oldest first; `hours` 1 to 168 |
| GET | `/v1/risk/{accountId}` | `RiskCheck` for any NEAR account's lending position (rate limited; `503` without a fresh NEAR price) |
| GET | `/v1/paid/risk/{accountId}` | the same `RiskCheck`, paid per call over x402 on NEAR (see "x402"); the account id and the price are checked before any payment is taken |
| POST | `/v1/simulate/{accountId}?strategy=repay-first&target=1.45` | `Simulation`: what the guardian would do, unsigned; `strategy` is `repay-first`, `keep-exposure` or `deleverage-only` (`503` without a fresh NEAR price) |
| GET | `/v1/guardian/decisions?account=&limit=25&cursor=` | `{ items: Decision[], next }`, newest first; `limit` at most 100; pass `next` (a `createdAt`) as `cursor` for the next page |
| GET | `/v1/guardian/decisions/{id}` | `Decision` (`404` if unknown) |
| GET | `/v1/guardian/decisions/{id}/verify` | `Verification` |
| GET | `/v1/alerts?account=&status=open` | `Alert[]`, newest first, at most 100; `account` is required (`400`), `status` is optional |
| POST | `/v1/alerts/{id}/ack` and `/v1/alerts/{id}/resolve` | `{ id, status }` for an alert of the signed-in account (auth) |
| POST | `/v1/auth/challenge` and `/v1/auth/verify` | a sign-in challenge and a session token (see "Auth") |
| GET | `/v1/settings/{accountId}` | `Settings` |
| PUT | `/v1/settings/{accountId}` | takes `SettingsUpdate`, returns `{ ok: true }` (auth as that account) |
| POST | `/v1/push/subscribe` | takes a Web Push subscription `{ endpoint, keys: { p256dh, auth } }`, returns `{ ok: true }` (auth) |
| GET | `/v1/vault` | `VaultState` |
| GET | `/v1/vault/history?days=7` | `VaultPoint[]`, oldest first; `days` 1 to 90 |
| GET | `/v1/vault/reserves` | `Reserves` with every leaf and its proof (`404` before the first vault report) |
| GET | `/v1/rates` | `Rates`: every asset Rhea lending lists, Hyperliquid's NEAR funding and the vault's staking against funding yield, each with its source |
| GET | `/v1/prices?tokens=` | `Prices`: NEAR, the liquid staking tokens, USDC and every Rhea asset with its 24 h change; `tokens` (ids or symbols, comma separated) narrows it; cached for a minute |
| GET | `/v1/replay` | `Replay`: the risk model, guardian and vault run through NEAR's largest historical crashes (`deployments/replay.json`, written by `pnpm replay`; `503` before it exists) |
| GET | `/v1/heatmap?network=testnet\|mainnet&asset=NEAR` | `Heatmap`: every Rhea lending borrower's liquidation price, bucketed, and the chained cascades (`400` for another asset) |
| GET | `/v1/verify/{id}` | `VerifyResult` for a decision id, a certificate hash or a NEAR transaction hash (`404` when it is none of them) |
| GET | `/v1/watch` | `WatchRow[]`: the signed-in account's watched accounts with live risk (auth) |
| PUT | `/v1/watch/{accountId}` | takes `{ thresholds: { score, health }, label? }`, returns the `WatchRow` (auth; at most 25 per account) |
| DELETE | `/v1/watch/{accountId}` | `{ ok: true }` (auth; `404` when not watched) |
| POST | `/v1/certificates` | takes `CertificateRequest`, returns `Certificate` (auth as the certified account; `422` when health is below the threshold, `503` until the enclave serves the certificate mode) |
| GET | `/v1/certificates?account=` and `/v1/certificates/{hash}` | `Certificate[]`, newest first, and one `Certificate` (`404` if unknown) |
| GET | `/v1/routes/savings?account=` | `RouteSavings`: what each rescue's route choice saved against the worst quote |
| GET | `/v1/vault/insurance` | `VaultInsurance`: the vault's insurance fund and its inflows and payouts |
| GET | `/v1/incidents?account=` | `Incident[]`, newest first, at most 50; `account` is required (`400`) |
| GET | `/v1/stream?events=&account=` | Server-Sent Events (see "Live updates") |
| GET | `/v1/fx` | `Fx`: USD rates for the display currencies (cached for an hour) |
| POST | `/v1/copilot` | takes `{ account, positionId?, question? }`, returns `CopilotAnswer` (rate limited) |
| GET | `/v1/quotes/rescue?amountNear=10` | `RouteComparison`; `amountNear` at least 0.1 |
| GET | `/v1/status` | `Status`: services, oracle freshness, gas-key lanes, treasury |
| GET | `/v1/treasury` | `{ account, balanceNear, postQuantumKey }`: the treasury account (null when unset), its balance and whether it holds an ML-DSA-65 key |
| POST | `/v1/relay/create-account` | takes `{ passkey }` (a P-256 key, `p256:<base58>` or 66 hex characters) or `{ nearAccount }`, returns `{ accountId, txHash }`: a gasless protected account |
| POST | `/v1/relay/owner` | takes `{ account, request, assertion }`, returns `{ txHash }`: relays a passkey-signed owner request with the gas its actions need (300 Tgas, 900 for `close_rhea`, at least 600 for `unwind`) |
| POST | `/v1/relay/delegate` | takes `{ payload }` or `{ signedDelegateAction }` (base64 borsh), returns `{ txHash }`: relays a NEP-366 signed delegate action to a Parry account, the vault, the factory or test USDC |
| GET | `/v1/shock` | testnet only (`404` on mainnet): `ShockState`, the active shock and the oracle's NEAR price with it applied |
| POST | `/v1/shock` | testnet only: takes `{ bps }` (signed basis points the oracle bounds; `0` clears), returns `{ txHash, shock: ShockView \| null }` |
| POST | `/v1/internal/score` | `{ scored }`: scores every position on demand; answers `404` unless the API runs with `PARRY_INTERNAL=1` (tests and single-process local runs), and needs no sign-in when enabled |
| POST | `/mcp` | the MCP server over Streamable HTTP, stateless and read-only; other methods answer `405` |

## Types

```ts
type Tier = "safe" | "caution" | "danger" | "critical";
type Venue = "rhea" | "hyperliquid" | "aave";

interface Stats {
  network: "testnet" | "mainnet";
  positionsProtected: number;  // Parry accounts with a position that set a mandate
  rescues: number;             // executed guardian decisions
  vaultTvlUsd: number;
  vaultRiskScore: number | null;
  valueProtectedUsd: number;   // collateral of positions on protected accounts with a live mandate
  positionsWatched: number;    // positions the monitor reads, protected or not
  insuranceUsd: number;        // the vault insurance fund's value; 0 until the vault has one
  updatedAt: string;
}

interface Config {
  network: "testnet" | "mainnet";
  contracts: Record<"factory" | "vault" | "risk" | "oracle" | "lending" | "dex" | "signer" | "usdc" | "wnear" | "linear", string | null>; // null when not deployed
  dexPool: number | null;      // the Rhea pool rescues swap on
  enclave: { publicKey: string; sealingPublicKey: string | null; wasmSha256: string };
  reviewModel: string;
  explorers: { near: string; hyperliquid: string; intents: string; evm: string };
}

interface Market {
  near: { priceUsd: number; hlMid: number | null; updatedAt: string };
  tremor: {
    sigmaHourly: number; annual: number; level: "calm" | "elevated" | "high" | "extreme";
    regime: "calm" | "stressed" | "panic";   // thresholds calibrated on NEAR's crashes (docs/risk-model.md, section 2)
    windows: { hours: number; weight: number; sigma: number | null; samples: number }[];
  };
  cascade: {
    pressure: number; atRiskUsd: number; correlatedOwners: number;
    source: "heatmap" | "positions";   // heatmap: every mainnet Rhea lending borrower; positions: the positions Parry monitors, until the heatmap has data
    network?: "mainnet" | null; accounts?: number; cascadeTo?: number | null; soldUsd?: number | null; sigmaHourly?: number;
  };
}

interface MarketReport {        // the risk service's latest market report
  price: number;               // NEAR in USD
  tremor: Market["tremor"];
  cascade: Market["cascade"];
}

interface Position {
  id: string;            // "<account>:<venue>:<name>"
  account: string;
  venue: Venue;
  label: string;         // "Rhea wNEAR/USDC", "Hyperliquid NEAR perp", "Aave on Base Sepolia"
  collateralUsd: number;
  debtUsd: number;
  health: number | null; // null without debt
  liqPrice: number | null;
  distance: number;      // 0..1
  score: number;         // 0..100
  tier: Tier;
  probability24h: number;
  ttlHours: number | null;
  valueAtRisk99: number;
  updatedAt: string;
}

interface AccountSummary {
  account: string;
  owner: { kind: "passkey" | "near"; id: string };
  mandate: MandateView | null;        // the contract's `mandate()` view (types in `@parryguard/sdk`)
  positions: Position[];
  hyperliquidAddress: string | null;  // the account's Chain Signatures address on Hyperliquid
  evmAddress: string | null;          // and on EVM chains
  stats: { guardianActions: number; deleverages: number };
}

interface Portfolio {
  account: string;
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;                  // collateral - debt + vault shares
  vault: { shares: string; valueUsd: number };
  pnl24hUsd: number | null;           // Rhea collateral at today's against yesterday's NEAR price; null without a price a day old
  positions: Position[];
}

interface HistoryPoint { t: string; health: number | null; score: number; price: number }

interface RiskCheck {
  account: string;
  checkedAt: string;
  position: Position | null;    // id "<account>:rhea:main"; null when the account has no lending position
  market: MarketReport | null;  // null before the first market report
  model: "docs/risk-model.md";
}

interface Simulation {
  account: string;
  triggered: boolean;
  reason: string;
  mandate?: boolean;            // whether the account has a mandate; absent without a lending position
  steps: {
    kind: "repay" | "add_collateral" | "deleverage";
    amount: string;             // whole units: USD for repay, NEAR for add_collateral and deleverage
    minOut?: string;            // deleverage only: the least USD the swap must return
    healthBefore: number;
    healthAfter: number | null; // null once no debt is left
  }[];
  reached?: boolean;            // whether the steps reach the target; absent without a lending position
  routes: RouteComparison | null; // the quote for the first deleverage step
}

interface Decision {
  id: string;            // the envelope hash
  account: string;
  venue: Venue;
  action: string;        // repay | add_collateral | deleverage | hl_reduce | hl_hedge | evm_approve | evm_repay
  plan: string;
  trigger: { score: number; tier: Tier; healthBps: number };
  outcome: "executed" | "refused" | "rolled_back" | "rejected_by_review" | "failed"; // failed: the EVM transaction reverted or its signature did not recover
  detail: string | null; // why it was refused, rolled back or failed
  review: {
    model: string; chatId: string; reviewHash: string; requestHash: string; responseHash: string;
    verdict: "approve" | "reject"; reasoning: string; signingAddress: string; signedText: string; signature: string; signatureKind: string;
  };
  envelope: string | null;           // the exact envelope JSON text the enclave signed
  envelopeSignature: string | null;  // the enclave's ed25519 signature over it (base64)
  txs: {
    action: string | null; record: string | null;
    hyperliquid: string | null;  // Hyperliquid's answer to the signed order (JSON text)
    evm: string | null;          // the EVM transaction (Base Sepolia on testnet)
    evmVerify: string | null;    // the NEAR transaction in which the MPC network verified it
    evmVerified: "verified" | "failed" | null;
  };
  healthBefore: number | null;
  healthAfter: number | null;
  routes: RouteComparison | null;
  explanation: { step: string; why: string; skipped: { step: string; reason: string }[] } | null; // why the planner chose this step and skipped the earlier ones in the policy's order
  createdAt: string;
}

interface Verification {
  id: string;
  // In order: "Review hash" (the review record hashes to the envelope's review hash), "Signature covers this exchange",
  // "Model TEE signature" (recovers to the signing address), "Model key attested in TEE hardware" (only with a NEAR AI key on the API),
  // "Enclave signature on the envelope" (when the envelope is signed), "Review hash on chain" (when there is an action transaction).
  checks: { name: string; ok: boolean; detail: string }[];
  verifyUrl: string;   // https://cloud.near.ai/verify
  attestation: string; // "checked" when the API verified the model's TDX and GPU attestation with NEAR AI's inference SDK, else why not
  ok: boolean;         // every check passed
}

interface Alert {
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

type Currency = "USD" | "EUR" | "GBP" | "JPY" | "CHF" | "CAD" | "AUD" | "SGD" | "HKD" | "AED" | "INR" | "CNY";

interface Settings {
  account: string;
  thresholds: { score: number; health: number; cascade: number }; // defaults 50, 1.25, 0.5
  displayCurrency: Currency;
  telegram: { linked: boolean; deepLink: string | null; available: boolean }; // available: the API has a Telegram bot
  email: { address: string | null; digest: "off" | "daily" };
  push: boolean;
  vapidPublicKey: string | null; // for Web Push; null when push is not configured
}

interface SettingsUpdate {     // every field optional; only the given ones change
  thresholds?: Settings["thresholds"];
  displayCurrency?: Currency;
  email?: string | null;       // null clears it
  digest?: "off" | "daily";
  linkTelegram?: boolean;      // true issues a fresh deep link
}

interface VaultState {
  network: string;
  paused: boolean;
  riskScore: number | null;
  reportAt: string | null;
  sharePriceUsd: number;
  navUsd: number;
  totalShares: string;
  queuedShares: string;
  stakedLinear: string;
  linearRate: number;
  nearPriceUsd: number;
  hedge: {
    targetNear: number; currentNear: number; entry: number; mark: number; liquidation: number; leverage: number; maxLeverage: number;
    hedgeRatio: number; needsMargin: boolean; accountValueUsd: number; fundingUsd: number;
    address: string | null;    // the vault's Chain Signatures address on Hyperliquid
    lastOrder: { tx: string; side: "buy" | "sell"; size: string; price: string; status: string; at: string } | null;   // the latest signed hedge order: the NEAR transaction that signed it and Hyperliquid's status
    marginRoute: { amountUsd: number; outUsd: number | null; unavailable: string | null; at: string } | null;         // the latest dry-run 1Click quote topping up the hedge margin (USDC on NEAR to USDC on HyperCore)
  };
  yield: { stakingApr: number | null; fundingUsd: number; hedgePnlUsd: number };
  reserves: { root: string; leaves: number; totalUsd: number; liabilitiesUsd: number; ratioBps: number } | null;
  depositCapNear: string;
  minDepositNear: string;
  queueLength: number;
}

interface VaultPoint {
  t: string; sharePriceUsd: number; navUsd: number; riskScore: number; hedgedFraction: number;
  // null for points recorded before each was kept
  stakingYieldUsd: number | null;   // LiNEAR's staking yield so far
  fundingYieldUsd: number | null;   // funding the short earned so far
  hedgeRatio: number | null;
  insuranceUsd: number | null;      // the insurance fund (null while the vault has none)
  reservesRoot: string | null;
  basisApr: number | null;          // LiNEAR's staking yield plus Hyperliquid's 24 h funding on the short, a year
  drawdown: number | null;          // 1 − share price / the best share price so far
  marginRatio: number | null;       // hedge account value / the short's notional
}

interface Reserves {
  root: string;
  ratioBps: number;
  reportAt: string;
  leaves: { asset: string; venue: string; amount: string; usdE6: string; proof: string[] }[];
}

interface Rates {
  rhea: { asset: string; tokenId: string; supplyApr: number; borrowApr: number; utilization: number; source: string }[]; // fractions; every asset the lending contract lists (`get_assets_paged_detailed`)
  hyperliquid: { fundingHourly: number | null; funding24hApr: number | null; source: string }; // positive: longs pay shorts
  vault: { stakingApr: number | null; fundingApr: number | null; netApr: number | null; insuranceShareBps: number | null; source: string };
  readAt: string;
}

interface Prices {
  tokens: { id: string; symbol: string; priceUsd: number; change24h: number | null; source: string }[]; // change24h is a fraction, null without a market for it
  readAt: string;
}

interface Replay {
  source: string;                      // the exact candle URL
  sources: Record<string, string>;     // candles, funding, staking, model
  params: { guardian: object; vault: object; crashWindowHours: number; leadHours: number; tailHours: number };
  crashes: {
    id: string; name: string; start: string; end: string; trough: string; dropPct: number;
    candles: { t: string; price: number; low: number }[];   // hourly closes and lows, 24 h before the peak to 24 h after the trough
    position: {
      startHealth: number;             // 1.30 at the peak
      warningHours: number | null;     // the model's first danger score to the liquidation without Parry
      warnedAt: string | null; predictedHoursAtWarning: number | null;
      liquidatedAt: string | null;     // without Parry: the first hourly low under health 1
      liquidatedWithParryAt: string | null;
      minHealthWith: number; reserveSpentUsd: number; collateralSoldNear: number;
      steps: { t: string; action: string; plan: string; healthBefore: number; healthAfter: number }[];
      healthWith: { t: string; h: number }[]; healthWithout: { t: string; h: number }[];
    };
    vault: {
      navWith: { t: string; v: number }[]; navUnhedged: { t: string; v: number }[];
      maxDrawdownPct: number; maxDrawdownUnhedgedPct: number; marginMin: number;
      insuranceFundUsd: number; insurancePaidUsd: number; insurancePaid: { negativeFundingUsd: number; marginTopUpUsd: number };
      fundingUsd: number; rebalances: number;
    };
  }[];
  summary: { crashes: number; medianWarningHours: number | null; minWarningHours: number | null; liquidationsWithout: number; liquidationsAvoided: number; [k: string]: unknown };
  calibration: { regime: { stressed: number; panic: number; panicHitRate: number; panicFalseRate: number; [k: string]: unknown }; tremorPercentiles: Record<string, number> };
}

interface Heatmap {
  network: "testnet" | "mainnet";
  lending: string;
  price: number;                       // NEAR: the latest market report's price (the one /v1/market shows), else mainnet lending's
  buckets: { price: number; collateralUsd: number; debtUsd: number; accounts: number }[]; // non-empty buckets 2 % of the price wide below today's price; `price` is the bucket's top
  cascades: { from: number; to: number; collateralUsd: number; soldUsd: number; accounts: number; rounds: number }[]; // chained: the liquidations' sales reach further buckets
  pressure: { atRiskUsd: number; soldUsd: number; pressure: number; to: number; accounts: number }; // what a 2σ daily fall sets off; the same figure as /v1/market's cascade
  underwater: { accounts: number; collateralUsd: number; debtUsd: number }; // already under health 1 today: not bucketed, not cascaded
  accounts: number;                    // borrowers stored
  sweep: { totalAccounts: number; nextIndex: number; lastFullSweepAt: string | null } | null;
  readAt: string;
  source: string;
}

interface VerifyResult {
  kind: "decision" | "certificate" | "transaction";
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  subject: Record<string, unknown>;    // the decision, the certificate body, or the transaction and what it links to
}

interface WatchRow {
  account: string;
  label: string | null;
  thresholds: { score: number; health: number };
  position: Position | null;           // its riskiest position, null when it has none
  alert: { kind: "risk" | "health"; severity: "info" | "warning" | "critical"; title: string; body: string }[]; // what it raises now at these thresholds
}

interface CertificateRequest { account: string; reader: string; threshold: number; ttlSecs: number; venue?: Venue; anchor?: boolean } // threshold above 1, ttlSecs 60 to 2592000

interface Certificate {
  hash: string;              // hex SHA-256 of "parry-certificate:v1:" + certificate: the digest the enclave signed
  certificate: string;       // the exact JSON the enclave signed: { kind, version, account, reader, venue, threshold, block_height, block_hash, issued_at, expires_at, statement }
  signature: string;         // ed25519 over the digest (base64)
  enclavePublicKey: string;
  anchorTx: string | null;   // the risk board transaction that anchored it
  createdAt: string;
}

interface RouteSavings {
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

interface VaultInsurance {     // the vault's insurance() view in camelCase; empty values while it has none
  available: boolean;
  shareBps: number | null; linear: string; usdcE6: string; valueUsdE6: string; paidTotalE6: string; paidTodayE6: string; capPerDayBps: number | null; marginReservedUsdE6: string;
  events: { kind: "inflow" | "payout"; at: string | null; tx: string; [field: string]: unknown }[];
  source: string;
}

interface Incident {
  id: string;
  account: string;
  title: string;             // one alert's own title, or how many positions the move touched
  body: string;
  severity: "info" | "warning" | "critical";
  alerts: Alert[];
  openedAt: string;
  closedAt: string | null;   // once every alert in it is resolved
}

interface Fx {
  base: "USD";
  rates: Record<Currency, number>;
  updatedAt: string;
  source: "open.er-api.com";
}

interface CopilotAnswer {      // a NEAR AI Cloud verifiable model explains the account's positions
  answer: string;
  model: string;
  chatId: string;
  verified: boolean;           // the model's signature covers exactly this exchange
  signingAddress: string | null;
  verifyUrl: string;
}

interface RouteComparison {
  amountNear: number;
  rhea: { outUsd: number; priceImpact: number; poolId: number } | null;
  intents: { outUsd: number; confidential: boolean; dry: true } | { unavailable: string };
  chosen: "rhea" | "intents";
  reason: string;        // why that route; on testnet the account settles on the Rhea pool and the 1Click quote is for comparison
}

interface ShockView {    // the oracle's `shock_of` view; prices are strings in the feed's exponent (e8), times in unix seconds
  bps: number; by: string; at: number; expires_at: number; shocked_price: string; fed_price: string;
}

interface ShockState {
  shock: ShockView | null;
  price: { price: string; conf: string; expo: number; publish_time: number } | null; // the oracle's `get_price_unsafe`
}

interface Status {
  network: string;
  services: { name: string; ok: boolean; detail: string; checkedAt: string }[]; // ok is false once a check is over 5 minutes old
  oracle: { publishTime: string; ageSeconds: number; fresh: boolean } | null;    // fresh: published within 120 s
  indexer: { lastBlock: number; lagBlocks: number | null };
  lanes: { service: "monitor" | "keeper" | "relayer"; account: string | null; key: string | null; nonces: number }[]; // nonces: the gas key's nonce lanes, 0 when unknown
  treasury: {
    account: string; balanceNear: number; low: boolean;
    postQuantumKey: boolean;   // the treasury signs with an ML-DSA-65 (FIPS 204) key
    wallets: { name: string; account: string; balanceNear: number; target: number }[];   // includes each gas key's prepaid balance
  } | null;
}
```

## Errors and quotas

Every error is `{ error: string }` with its status: `400` for a malformed account id, a missing or non-numeric parameter, an invalid setting or a body that is not JSON, `401` without a valid sign-in, `402` for an unpaid call, `404` for something that does not exist, `422` when the enclave refuses a certificate, `429` past a daily quota, `503` while a dependency has no data, and `500` for anything else.
A quota per address keys on the right-most `X-Forwarded-For` entry, the one the reverse proxy in front of the API appends.
`/v1/risk` allows 200 free checks per address per day (`FREE_RISK_CHECKS_PER_DAY`), then answers `429` pointing to the paid route.
`/v1/copilot` allows 30 questions per account per day (`COPILOT_PER_DAY`) and answers `503` when the API has no NEAR AI key.
The relayed routes answer a spent budget with `429` and any other refusal with `400`.
`/v1/relay/create-account` allows 3 accounts per address and 50 in all per day (`RELAYER_ACCOUNTS_PER_IP`, `RELAYER_DAILY_ACCOUNTS`).
`/v1/relay/owner` and `/v1/relay/delegate` each allow 60 relays per account per day (`RELAYER_OWNER_PER_DAY`, `RELAYER_DELEGATE_PER_DAY`).
`POST /v1/shock` allows 20 shocks per address per day (`SHOCKS_PER_IP`), and the oracle takes one shock per minute from the relayer.

## Auth

Settings, alert actions, push subscriptions, watched accounts and issuing certificates need a short-lived session token.
`POST /v1/auth/challenge { accountId }` returns `{ nonce, message, recipient: "parry" }`, valid for 5 minutes and usable once.
The person signs the message with their NEAR wallet (NEP-413 with the nonce and recipient `parry`, from a full-access key of the owning account) or their passkey (a WebAuthn assertion whose challenge is the base64url SHA-256 of the message).
`POST /v1/auth/verify` takes `{ accountId, nonce, nep413: { publicKey, signature } }` or `{ accountId, nonce, passkey: { authenticator_data, client_data_json, signature } }`, checks it against the protected account's owner on chain, and returns `{ token }` for `Authorization: Bearer <token>`, valid for 12 hours.
A proof that does not check out answers `401`.

The SDK signs in with a NEAR owner's full-access key in one call (`parry.signIn(accountId, privateKey)`).

## Sources

Every number read live says where it came from.
Rhea rates and assets come from the lending contract's `get_assets_paged_detailed` on the API's network.
Prices are the Pyth feeds mainnet Rhea lending prices with (`get_all_token_pyth_infos`), read from `aggregate-oracle.near` the way Rhea reads them (`get_price_no_older_than`, within its 60 second bound), times the token's own rate view for liquid staking tokens (`ft_price`, `get_st_near_price`, `get_nearx_price`).
The 24 hour change is Binance's public 24 hour ticker for the feed's market (NEAR, BTC, ETH, ZEC, USDC); a liquid staking token takes NEAR's change, and a token without such a market has `null`.
Hyperliquid funding is its info API (`metaAndAssetCtxs` for the live rate, `fundingHistory` for the last 24 hours).
The heatmap pages every Rhea lending account read-only (`get_accounts_paged`, 100 at a time, a pause between calls) on testnet and on mainnet (`contract.main.burrow.near`), in the risk service, about 3000 accounts every 2 minutes per network; it keeps borrowers in Postgres and drops the accounts a whole sweep did not see.
Its cascades size each liquidation by Rhea's own rule (only back to health 1, docs/risk-model.md section 5) and assume a market depth of `CASCADE_DEPTH_2PCT_USD` (1.5 million USD moves NEAR 2 %), a configured figure, and the source field says so.

## Verification

`GET /v1/verify/{id}` re-checks what Parry recorded, from public data.
A decision id gets the checks of `/v1/guardian/decisions/{id}/verify`.
A certificate hash gets the hash, the statement, the enclave signature with the key the risk board trusted at `issued_at` (`enclave_history`), the expiry, and the board's anchor when the board has the `certificate` view.
A NEAR transaction hash is read from FastNEAR's transactions API: a risk board `submit` has its report's enclave signature checked against the key in force at the report's `at`, and a `guardian_execute` has its envelope signature checked against the key in force at `issued_at`, its review hash matched to the account's `guardian_acted` event, and the stored decision's checks added.

## Live updates

`GET /v1/stream` answers `text/event-stream`.
`events` (comma separated) picks among `alert`, `decision`, `position`, `price`, `vault` and `status` (all by default; another name is a `400`), and `account` keeps only that account's alerts, decisions and positions.
Each message's `event` is the name and its `data` is one item as the matching GET returns it: an `Alert`, a `Decision`, a `Position`, one `Prices` token (NEAR from the oracle sample, with the change against the sample a day before), the `VaultState`, or one `Status` service.
One poller per API process reads Postgres every 2 seconds for what changed (and the vault's chain state once per vault report), only while a client is connected, and fans each item out to every client, so the cost does not grow with the number of clients.
A comment line (`: heartbeat`) arrives every 15 seconds, and `retry: 5000` asks the browser to reconnect after 5 seconds.
Only changes after the connection are sent: read the GET routes first.
The SDK's `parry.subscribe({ events, account, onEvent })` uses an EventSource where there is one and polls the GET routes every 10 seconds otherwise.

## x402

`GET /v1/paid/risk/{accountId}` without payment answers `402` with `{ x402Version: 2, error: "payment required", accepts: [{ scheme: "exact", network: "near:testnet", asset: "<usdc>", amount: "10000", payTo: "<api account>", resource, description, maxTimeoutSeconds: 120 }] }`.
The client signs a NEP-366 delegate action holding one `ft_transfer` of `amount` to `payTo` (1 yoctoNEAR attached, at most 50 Tgas, from a full-access key) and repeats the request with `X-PAYMENT: base64(JSON { x402Version: 2, scheme: "exact", network, payload: { signedDelegateAction: "<base64 borsh>" } })`.
The API verifies the delegate (signature, asset, method, amount, recipient, gas, an unused nonce, and expiry within 240 blocks), submits it through the relayer, and once the transfer settled returns the `RiskCheck` with `X-PAYMENT-RESPONSE: base64(JSON { success: true, transaction, network })`.
A payment that fails a check answers `402` with the same body and `error` set to the reason.
On testnet the asset is Parry's test USDC (free from its faucet).
