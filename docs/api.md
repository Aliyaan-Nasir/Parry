# Parry API

The API (`apps/api`) serves the app, the SDK (`@parry/sdk`) and the MCP server (`@parry/mcp`).
Base path `/v1`. JSON everywhere. Amounts are decimal strings in the token's smallest unit unless the field name ends in `Usd` (a number in dollars) or is a ratio.
Every response carries `network` (`testnet` or `mainnet`) where it matters.
Reads need no key. Writes that change a person's settings need a sign-in (section "Auth").

## Overview

| Method | Path | What it returns |
| --- | --- | --- |
| GET | `/v1/stats` | `{ network, positionsProtected, rescues, vaultTvlUsd, vaultRiskScore, updatedAt }` for the site's live strip |
| GET | `/v1/config` | `Config`: network, contract ids, the enclave's keys, the review model, explorer URLs |
| GET | `/v1/market` | `Market`: NEAR price, Tremor index, cascade pressure, marks |
| GET | `/v1/accounts/{accountId}` | `AccountSummary`: a protected account, its mandate and positions |
| GET | `/v1/accounts/{accountId}/positions` | `Position[]` |
| GET | `/v1/accounts/{accountId}/portfolio` | `Portfolio`: totals and PnL |
| GET | `/v1/positions/{positionId}/history?hours=24` | `HistoryPoint[]` |
| GET | `/v1/risk/{accountId}` | `RiskCheck` for any NEAR account's lending position (rate limited) |
| GET | `/v1/paid/risk/{accountId}` | the same `RiskCheck`, paid per call over x402 on NEAR (see "x402") |
| POST | `/v1/simulate/{accountId}` | `Simulation`: what the guardian would do now, unsigned |
| GET | `/v1/guardian/decisions?account=&limit=&cursor=` | `{ items: Decision[], next }` |
| GET | `/v1/guardian/decisions/{id}` | `Decision` |
| GET | `/v1/guardian/decisions/{id}/verify` | `Verification` |
| GET | `/v1/alerts?account=&status=open` | `Alert[]` |
| POST | `/v1/alerts/{id}/ack` and `/v1/alerts/{id}/resolve` | `Alert` (auth) |
| GET, PUT | `/v1/settings/{accountId}` | `Settings` (auth for PUT) |
| POST | `/v1/push/subscribe` | registers a Web Push subscription (auth) |
| GET | `/v1/vault` | `VaultState` |
| GET | `/v1/vault/history?days=7` | `VaultPoint[]` |
| GET | `/v1/vault/reserves` | `Reserves` with every leaf and its proof |
| GET | `/v1/rates` | `Rate[]`: Rhea supply and borrow rates and the vault's yield |
| GET | `/v1/quotes/rescue?amountNear=` | `RouteComparison` |
| GET | `/v1/status` | `Status`: services, oracle freshness, gas-key lanes, treasury |
| POST | `/v1/relay/create-account` | `{ accountId, txHash }`: a gasless protected account |
| POST | `/v1/relay/owner` | `{ txHash }`: relays a passkey-signed owner request |
| POST | `/v1/relay/delegate` | `{ txHash }`: relays a NEP-366 signed delegate action |
| POST | `/v1/shock` | testnet only: `{ txHash, shock }` |
| POST, GET | `/mcp` | the MCP server over Streamable HTTP |

## Types

```ts
type Tier = "safe" | "caution" | "danger" | "critical";
type Venue = "rhea" | "hyperliquid" | "aave";

interface Config {
  network: "testnet" | "mainnet";
  contracts: { factory: string; vault: string; risk: string; oracle: string | null; lending: string; dex: string; signer: string; usdc: string; wnear: string; linear: string };
  enclave: { publicKey: string; sealingPublicKey: string | null; wasmSha256: string };
  reviewModel: string;
  explorers: { near: string; hyperliquid: string; intents: string; evm: string };
}

interface Market {
  near: { priceUsd: number; hlMid: number | null; updatedAt: string };
  tremor: { sigmaHourly: number; annual: number; level: "calm" | "elevated" | "high" | "extreme"; windows: { hours: number; sigma: number | null }[] };
  cascade: { pressure: number; atRiskUsd: number; correlatedOwners: number };
}

interface Position {
  id: string;            // "<account>:<venue>:<name>"
  account: string;
  venue: Venue;
  label: string;         // "Rhea wNEAR/USDC", "Hyperliquid NEAR perp", "Aave on Sepolia"
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
  mandate: MandateView | null; // the contract's `mandate()` view
  positions: Position[];
  hyperliquidAddress: string;  // the account's Chain Signatures address on Hyperliquid
  evmAddress: string;          // and on EVM chains
  stats: { guardianActions: number; deleverages: number };
}

interface HistoryPoint { t: string; health: number | null; score: number; price: number }

interface RiskCheck {
  account: string;
  checkedAt: string;
  position: Position | null; // null when the account has no lending position
  market: Market;
  model: "docs/risk-model.md";
}

interface Simulation {
  account: string;
  triggered: boolean;
  reason: string;
  steps: { kind: "repay" | "add_collateral" | "deleverage" | "hl_reduce"; amount: string; minOut?: string; healthBefore: number; healthAfter: number }[];
  routes: RouteComparison | null;
}

interface Decision {
  id: string;            // the envelope hash
  account: string;
  venue: Venue;
  action: string;        // repay | add_collateral | deleverage | hl_reduce | hl_hedge | evm_approve | evm_repay
  plan: string;
  trigger: { score: number; tier: Tier; healthBps: number };
  outcome: "executed" | "refused" | "rolled_back" | "rejected_by_review" | "pending";
  review: { model: string; chatId: string; reviewHash: string; verdict: "approve" | "reject"; reasoning: string; signingAddress: string; signedText: string; signature: string; signatureKind: string };
  envelope: string | null;
  txs: { action: string | null; record: string | null; hyperliquid: string | null; evm: string | null };
  healthBefore: number | null;
  healthAfter: number | null;
  routes: RouteComparison | null;
  createdAt: string;
}

interface Verification {
  id: string;
  checks: { name: string; ok: boolean; detail: string }[]; // review signature recovers to the signing address; the address is attested (NEAR AI verification); review hash on chain matches; envelope signed by the enclave key; enclave key bound to the published wasm
  verifyUrl: string; // https://cloud.near.ai/verify
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

interface Settings {
  account: string;
  thresholds: { score: number; health: number; cascade: number };
  displayCurrency: "USD" | "EUR" | "GBP" | "JPY" | "CHF" | "CAD" | "AUD" | "SGD" | "HKD" | "AED" | "INR" | "CNY";
  telegram: { linked: boolean; deepLink: string | null };
  email: { address: string | null; digest: "off" | "daily" };
  push: boolean;
}

interface VaultState {
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
  hedge: { targetNear: number; currentNear: number; entry: number; mark: number; liquidation: number; leverage: number; maxLeverage: number; hedgeRatio: number; needsMargin: boolean; address: string };
  yield: { stakingApr: number | null; fundingUsd: number; hedgePnlUsd: number };
  reserves: { root: string; leaves: number; totalUsd: number; liabilitiesUsd: number; ratioBps: number };
  depositCapNear: string;
  minDepositNear: string;
  queueLength: number;
}

interface Reserves {
  root: string;
  ratioBps: number;
  reportAt: string;
  leaves: { asset: string; venue: string; amount: string; usdE6: string; proof: string[] }[];
}

interface RouteComparison {
  amountNear: number;
  rhea: { outUsd: number; priceImpact: number; poolId: number } | null;
  intents: { outUsd: number; confidential: boolean; dry: true } | { unavailable: string };
  chosen: "rhea" | "intents";
}

interface Status {
  network: string;
  services: { name: string; ok: boolean; detail: string; checkedAt: string }[];
  oracle: { publishTime: string; ageSeconds: number; fresh: boolean } | null;
  indexer: { lastBlock: number; lagBlocks: number };
  lanes: { service: string; account: string; key: string; nonces: number; inFlight: number }[];
  treasury: { account: string; balanceNear: number; low: boolean; wallets: { name: string; account: string; balanceNear: number; target: number }[] };
}
```

## Auth

Settings, alert actions and push subscriptions need a short-lived session token: `POST /v1/auth/challenge { accountId }` returns a nonce and a message; the person signs it with their NEAR wallet (NEP-413, recipient `parry`) or their passkey (a WebAuthn assertion over the message); `POST /v1/auth/verify` checks it against the protected account's owner on chain and returns `{ token }` for `Authorization: Bearer <token>`.

## x402

`GET /v1/paid/risk/{accountId}` without payment answers `402` with `{ x402Version: 2, accepts: [{ scheme: "exact", network: "near:testnet", asset: "<usdc>", amount: "10000", payTo: "<api account>", resource, description, maxTimeoutSeconds: 120 }] }`.
The client signs a NEP-366 delegate action for `ft_transfer` of `amount` to `payTo` and repeats the request with `X-PAYMENT: base64(JSON { x402Version: 2, scheme: "exact", network, payload: { signedDelegateAction: "<base64 borsh>" } })`.
The API verifies the delegate (receiver, method, amount, recipient, freshness), submits it through the relayer, and returns the `RiskCheck` with `X-PAYMENT-RESPONSE: base64(JSON { success: true, transaction, network })`.
On testnet the asset is Parry's test USDC (free from its faucet).
