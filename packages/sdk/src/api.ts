/**
 * The Parry API client (docs/api.md). Every read is typed; errors carry the HTTP status and body.
 */

import type {
  AccountSummary,
  Alert,
  Config,
  Decision,
  DecisionPage,
  HistoryPoint,
  Market,
  PasskeyAssertion,
  Position,
  Rate,
  Reserves,
  RiskCheck,
  RouteComparison,
  Simulation,
  Stats,
  Status,
  VaultPoint,
  VaultState,
  Verification,
} from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ParryApiError extends Error {
  override readonly name = "ParryApiError";
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    const detail = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : typeof body === "string" ? body.slice(0, 200) : "";
    super(`Parry API ${path} answered ${status}${detail ? `: ${detail}` : ""}`);
  }
}

type Query = Record<string, string | number | undefined | null>;

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT";
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ParryApi {
  private readonly base: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(apiUrl: string | undefined | null, fetchImpl?: FetchLike) {
    this.base = apiUrl ? apiUrl.replace(/\/+$/, "") : null;
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  get configured(): boolean {
    return this.base !== null;
  }

  url(path: string, query?: Query): string {
    if (!this.base) throw new Error("this Parry client has no apiUrl: pass createParry({ apiUrl }) for API reads and relays");
    const qs = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${this.base}${path}${qs ? `?${qs}` : ""}`;
  }

  /** A raw response (used by the x402 flow, which reads 402 bodies and headers). */
  async raw(path: string, req: ApiRequest = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    return this.fetchImpl(this.url(path, req.query), {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
  }

  async request<T>(path: string, req: ApiRequest = {}): Promise<T> {
    const res = await this.raw(path, req);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text for the error.
    }
    if (!res.ok) throw new ParryApiError(res.status, path, body);
    return body as T;
  }
}

const seg = (s: string) => encodeURIComponent(s);

/** The typed reads and relays of the API, bound to one client. */
export function apiMethods(api: ParryApi) {
  return {
    /** Live counters for the site: protected positions, rescues, vault TVL and risk. */
    stats: () => api.request<Stats>("/v1/stats"),
    /** Network, contract ids, the enclave's keys, the review model, explorer URLs. */
    config: () => api.request<Config>("/v1/config"),
    /** NEAR price, Tremor volatility index and cascade pressure. */
    market: () => api.request<Market>("/v1/market"),
    /** A protected account: owner, mandate, positions, derived addresses. */
    account: (accountId: string) => api.request<AccountSummary>(`/v1/accounts/${seg(accountId)}`),
    positions: (accountId: string) => api.request<Position[]>(`/v1/accounts/${seg(accountId)}/positions`),
    history: (positionId: string, hours = 24) => api.request<HistoryPoint[]>(`/v1/positions/${seg(positionId)}/history`, { query: { hours } }),
    /** Risk of any NEAR account's lending position (rate limited). */
    riskCheck: (accountId: string) => api.request<RiskCheck>(`/v1/risk/${seg(accountId)}`),
    /** What the guardian would do now, unsigned. */
    simulate: (accountId: string) => api.request<Simulation>(`/v1/simulate/${seg(accountId)}`, { method: "POST", body: {} }),
    decisions: (q: { account?: string; limit?: number; cursor?: string } = {}) =>
      api.request<DecisionPage>("/v1/guardian/decisions", { query: { account: q.account, limit: q.limit, cursor: q.cursor } }),
    decision: (id: string) => api.request<Decision>(`/v1/guardian/decisions/${seg(id)}`),
    /** The API's own verification of a decision (`verifyDecision` checks it independently). */
    verification: (id: string) => api.request<Verification>(`/v1/guardian/decisions/${seg(id)}/verify`),
    alerts: (account: string, q: { status?: Alert["status"] } = {}) => api.request<Alert[]>("/v1/alerts", { query: { account, status: q.status } }),
    vault: () => api.request<VaultState>("/v1/vault"),
    vaultHistory: (days = 7) => api.request<VaultPoint[]>("/v1/vault/history", { query: { days } }),
    /** Every reserve leaf with its Merkle proof. */
    reserves: () => api.request<Reserves>("/v1/vault/reserves"),
    rates: () => api.request<Rate[]>("/v1/rates"),
    status: () => api.request<Status>("/v1/status"),
    rescueQuote: (amountNear: number) => api.request<RouteComparison>("/v1/quotes/rescue", { query: { amountNear } }),
    /** Relays a passkey-signed owner request to `owner_execute` (the relayer pays the gas). */
    relayOwnerRequest: (text: string, assertion: PasskeyAssertion) =>
      api.request<{ txHash: string }>("/v1/relay/owner", { method: "POST", body: { request: text, assertion } }),
    /** Creates a protected account without gas, for a passkey (compressed P-256 hex) or a NEAR account. */
    createProtectedAccount: (owner: { passkey: string } | { nearAccount: string }) =>
      api.request<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: owner }),
    /** Relays a NEP-366 signed delegate action (standard base64 of its borsh bytes). */
    relayDelegate: (signedDelegateAction: string) =>
      api.request<{ txHash: string }>("/v1/relay/delegate", { method: "POST", body: { signedDelegateAction } }),
  };
}

export type ApiMethods = ReturnType<typeof apiMethods>;
