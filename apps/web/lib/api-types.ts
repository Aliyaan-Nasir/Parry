// Types of the Parry API routes the SDK has no typed method for yet (docs/api.md and the API's
// own extras), and the fields the API adds to the SDK's documented shapes.

import type { Position, RouteComparison, SimulationStep, Simulation, VaultState, Status } from "@parry/sdk";

export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "SGD", "HKD", "AED", "INR", "CNY"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** GET /v1/fx: USD based rates for the display currencies. */
export interface Fx {
  base: "USD";
  rates: Partial<Record<Currency, number>>;
  updatedAt: string;
  source?: string;
}

/** POST /v1/copilot: a NEAR AI Cloud verifiable model explains a position. */
export interface CopilotAnswer {
  answer: string;
  model: string;
  chatId: string;
  verified: boolean;
  signingAddress: string | null;
  verifyUrl: string;
}

/** POST /v1/auth/challenge. */
export interface AuthChallenge {
  nonce: string;
  message: string;
  recipient: string;
}

export type AuthProof =
  | { accountId: string; nonce: string; nep413: { publicKey: string; signature: string } }
  | { accountId: string; nonce: string; passkey: { authenticator_data: string; client_data_json: string; signature: string } };

export interface Thresholds {
  score: number;
  health: number;
  cascade: number;
}

/** GET /v1/settings/{accountId}. */
export interface Settings {
  account: string;
  thresholds: Thresholds;
  displayCurrency: Currency;
  telegram: { linked: boolean; deepLink: string | null; available?: boolean };
  email: { address: string | null; digest: "off" | "daily" };
  push: boolean;
  /** The API's VAPID public key for Web Push, or null when push is not configured. */
  vapidPublicKey?: string | null;
}

export interface SettingsUpdate {
  thresholds?: Thresholds;
  displayCurrency?: Currency;
  email?: string | null;
  digest?: "off" | "daily";
  linkTelegram?: boolean;
}

/** GET /v1/accounts/{accountId}/portfolio. */
export interface Portfolio {
  account: string;
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;
  vault: { shares: string; valueUsd: number };
  pnl24hUsd: number | null;
  positions: Position[];
}

/** The oracle's `shock_of` view (prices e8 as strings). */
export interface ShockView {
  bps: number;
  by: string;
  at: number;
  expires_at: number;
  shocked_price: string;
  fed_price: string;
}

/** GET /v1/shock (testnet). */
export interface ShockState {
  shock: ShockView | null;
  price: { price: string; conf: string; expo: number; publish_time: number } | null;
}

/** POST /v1/shock (testnet). */
export interface ShockResult {
  txHash: string;
  shock: ShockView | null;
}

/** The simulation as the API returns it: the documented fields plus whether a mandate is set. */
export type SimulationResult = Simulation & { mandate?: boolean; reached?: boolean; steps: SimulationStep[]; routes: RouteComparison | null };

/** The vault as the API returns it: no reserves summary before the first report. */
export type VaultView = Omit<VaultState, "reserves"> & {
  reserves: VaultState["reserves"] | null;
};

/** One point of the vault history, with the hedged fraction the API adds. */
export interface VaultHistoryPoint {
  t: string;
  sharePriceUsd: number;
  navUsd: number;
  riskScore: number;
  hedgedFraction?: number;
}

/** Status as the API returns it: lanes and treasury can be partly unknown on a local node. */
export type StatusView = Omit<Status, "lanes" | "treasury" | "indexer"> & {
  indexer: { lastBlock: number; lagBlocks: number | null };
  lanes: { service: string; account: string | null; key: string | null; nonces: number; inFlight?: number }[];
  treasury: Status["treasury"] | null;
};
