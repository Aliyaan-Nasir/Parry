# Parry API

The API (`apps/api`) serves the app, the SDK (`@parry/sdk`) and the MCP server (`@parry/mcp`).
Base path `/v1`.
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
| GET | `/v1/rates` | `Rate[]`: Rhea supply and borrow rates and the vault's yield |
| GET | `/v1/fx` | `Fx`: USD rates for the display currencies (cached for an hour) |
| POST | `/v1/copilot` | takes `{ account, positionId?, question? }`, returns `CopilotAnswer` (rate limited) |
| GET | `/v1/quotes/rescue?amountNear=10` | `RouteComparison`; `amountNear` at least 0.1 |
| GET | `/v1/status` | `Status`: services, oracle freshness, gas-key lanes, treasury |
| GET | `/v1/treasury` | `{ account, balanceNear, postQuantumKey }`: the treasury account (null when unset), its balance and whether it holds an ML-DSA-65 key |
| POST | `/v1/relay/create-account` | takes `{ passkey }` (a P-256 key, `p256:<base58>` or 66 hex characters) or `{ nearAccount }`, returns `{ accountId, txHash }`: a gasless protected account |
| POST | `/v1/relay/owner` | takes `{ account, request, assertion }`, returns `{ txHash }`: relays a passkey-signed owner request |
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
  tremor: { sigmaHourly: number; annual: number; level: "calm" | "elevated" | "high" | "extreme"; windows: { hours: number; weight: number; sigma: number | null; samples: number }[] };
  cascade: { pressure: number; atRiskUsd: number; correlatedOwners: number };
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
  mandate: MandateView | null;        // the contract's `mandate()` view (types in `@parry/sdk`)
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

interface VaultPoint { t: string; sharePriceUsd: number; navUsd: number; riskScore: number; hedgedFraction: number }

interface Reserves {
  root: string;
  ratioBps: number;
  reportAt: string;
  leaves: { asset: string; venue: string; amount: string; usdE6: string; proof: string[] }[];
}

interface Rate {
  asset: string;         // "wNEAR", "USDC", "Parry Earn (EARN)"
  supplyApr: number;
  borrowApr: number;     // 0 for the vault
  source: string;        // "Rhea lending" or the vault
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

## Errors and limits

Every error is `{ error: string }` with its status: `400` for a malformed account id, a missing or non-numeric parameter, an invalid setting or a body that is not JSON, `401` without a valid sign-in, `402` for an unpaid call, `404` for something that does not exist, `429` past a daily limit, `503` while a dependency has no data, and `500` for anything else.
A limit per address keys on the right-most `X-Forwarded-For` entry, the one the reverse proxy in front of the API appends.
`/v1/risk` allows 200 free checks per address per day (`FREE_RISK_CHECKS_PER_DAY`), then answers `429` pointing to the paid route.
`/v1/copilot` allows 30 questions per account per day (`COPILOT_PER_DAY`) and answers `503` when the API has no NEAR AI key.
The relayed routes answer a spent budget with `429` and any other refusal with `400`.
`/v1/relay/create-account` allows 3 accounts per address and 50 in all per day (`RELAYER_ACCOUNTS_PER_IP`, `RELAYER_DAILY_ACCOUNTS`).
`/v1/relay/owner` and `/v1/relay/delegate` each allow 60 relays per account per day (`RELAYER_OWNER_PER_DAY`, `RELAYER_DELEGATE_PER_DAY`).
`POST /v1/shock` allows 20 shocks per address per day (`SHOCKS_PER_IP`), and the oracle takes one shock per minute from the relayer.

## Auth

Settings, alert actions and push subscriptions need a short-lived session token.
`POST /v1/auth/challenge { accountId }` returns `{ nonce, message, recipient: "parry" }`, valid for 5 minutes and usable once.
The person signs the message with their NEAR wallet (NEP-413 with the nonce and recipient `parry`, from a full-access key of the owning account) or their passkey (a WebAuthn assertion whose challenge is the base64url SHA-256 of the message).
`POST /v1/auth/verify` takes `{ accountId, nonce, nep413: { publicKey, signature } }` or `{ accountId, nonce, passkey: { authenticator_data, client_data_json, signature } }`, checks it against the protected account's owner on chain, and returns `{ token }` for `Authorization: Bearer <token>`, valid for 12 hours.
A proof that does not check out answers `401`.

## x402

`GET /v1/paid/risk/{accountId}` without payment answers `402` with `{ x402Version: 2, error: "payment required", accepts: [{ scheme: "exact", network: "near:testnet", asset: "<usdc>", amount: "10000", payTo: "<api account>", resource, description, maxTimeoutSeconds: 120 }] }`.
The client signs a NEP-366 delegate action holding one `ft_transfer` of `amount` to `payTo` (1 yoctoNEAR attached, at most 50 Tgas, from a full-access key) and repeats the request with `X-PAYMENT: base64(JSON { x402Version: 2, scheme: "exact", network, payload: { signedDelegateAction: "<base64 borsh>" } })`.
The API verifies the delegate (signature, asset, method, amount, recipient, gas, an unused nonce, and expiry within 240 blocks), submits it through the relayer, and once the transfer settled returns the `RiskCheck` with `X-PAYMENT-RESPONSE: base64(JSON { success: true, transaction, network })`.
A payment that fails a check answers `402` with the same body and `error` set to the reason.
On testnet the asset is Parry's test USDC (free from its faucet).
