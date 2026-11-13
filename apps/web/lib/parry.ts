// The Parry client for the app: one @parryguard/sdk client for API reads, relays and builders, and the
// same client (or, against a local node, one with that deployment's contract ids) for chain reads.

import { createParry, type ContractIds, type PasskeyAssertion, type Parry } from "@parryguard/sdk";
import type {
  AuthChallenge,
  AuthProof,
  CopilotAnswer,
  Fx,
  Portfolio,
  Settings,
  SettingsUpdate,
  ShockResult,
  ShockState,
  SimulationResult,
  StatusView,
  VaultHistoryPoint,
  VaultView,
} from "./api-types";
import { apiUrl, nearRpcUrl, network } from "./env";

let client: Parry | null = null;

/** The client for API reads, relays and builders that need no contract id. */
export function parry(): Parry {
  client ??= createParry({ network, ...(apiUrl ? { apiUrl } : {}), ...(nearRpcUrl ? { rpcUrl: nearRpcUrl } : {}) });
  return client;
}

let chainClient: Promise<Parry> | null = null;

/**
 * The client for chain reads and for calls that name contracts (tokens, vault, risk board). A
 * public build uses its network's published ids; against a local node (NEXT_PUBLIC_NEAR_RPC_URL)
 * the ids come from that deployment's API.
 */
export function chain(): Promise<Parry> {
  if (!nearRpcUrl) return Promise.resolve(parry());
  chainClient ??= parry()
    .config()
    .then((config) => {
      const contracts = Object.fromEntries(
        Object.entries(config.contracts).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
      ) as Partial<ContractIds>;
      return createParry({ network, ...(apiUrl ? { apiUrl } : {}), rpcUrl: nearRpcUrl ?? undefined, contracts });
    })
    .catch((e: unknown) => {
      chainClient = null;
      throw e;
    });
  return chainClient;
}

const seg = (s: string) => encodeURIComponent(s);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** API routes the SDK has no typed method for, read through the SDK's API client. */
export const api = {
  fx: () => parry().api.request<Fx>("/v1/fx"),
  portfolio: (account: string) => parry().api.request<Portfolio>(`/v1/accounts/${seg(account)}/portfolio`),
  accountsByOwner: (owner: string) => parry().api.request<string[]>(`/v1/accounts/by-owner/${seg(owner)}`),
  simulate: (account: string) => parry().simulate(account) as Promise<SimulationResult>,
  vault: () => parry().vault() as unknown as Promise<VaultView>,
  vaultHistory: (days: number) => parry().vaultHistory(days) as unknown as Promise<VaultHistoryPoint[]>,
  status: () => parry().status() as unknown as Promise<StatusView>,
  copilot: (body: { account: string; positionId?: string; question?: string }) =>
    parry().api.request<CopilotAnswer>("/v1/copilot", { method: "POST", body }),
  challenge: (accountId: string) => parry().api.request<AuthChallenge>("/v1/auth/challenge", { method: "POST", body: { accountId } }),
  verify: (proof: AuthProof) => parry().api.request<{ token: string }>("/v1/auth/verify", { method: "POST", body: proof }),
  settings: (account: string) => parry().api.request<Settings>(`/v1/settings/${seg(account)}`),
  saveSettings: (account: string, update: SettingsUpdate, token: string) =>
    parry().api.request<{ ok: boolean }>(`/v1/settings/${seg(account)}`, { method: "PUT", body: update, headers: bearer(token) }),
  ackAlert: (id: string, token: string) => parry().api.request<{ id: string; status: string }>(`/v1/alerts/${seg(id)}/ack`, { method: "POST", body: {}, headers: bearer(token) }),
  resolveAlert: (id: string, token: string) =>
    parry().api.request<{ id: string; status: string }>(`/v1/alerts/${seg(id)}/resolve`, { method: "POST", body: {}, headers: bearer(token) }),
  pushSubscribe: (subscription: PushSubscriptionJSON, token: string) =>
    parry().api.request<{ ok: boolean }>("/v1/push/subscribe", { method: "POST", body: subscription, headers: bearer(token) }),
  shock: () => parry().api.request<ShockState>("/v1/shock"),
  applyShock: (bps: number) => parry().api.request<ShockResult>("/v1/shock", { method: "POST", body: { bps } }),
  /**
   * Relays a passkey-signed owner request. The relayer checks the account is a Parry account
   * before paying, so the account travels with the request.
   */
  relayOwner: (account: string, request: string, assertion: PasskeyAssertion) =>
    parry().api.request<{ txHash: string }>("/v1/relay/owner", { method: "POST", body: { account, request, assertion } }),
};
