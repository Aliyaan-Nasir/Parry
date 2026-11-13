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
  Certificate,
  CertificateRequest,
  Heatmap,
  Incident,
  Prices,
  Rates,
  Replay,
  Reserves,
  RouteSavings,
  VaultInsurance,
  VerifyResult,
  WatchRow,
  WatchThresholds,
  RiskCheck,
  RouteComparison,
  Simulation,
  Stats,
  Status,
  VaultPoint,
  VaultState,
  Verification,
} from "./types.js";

import type { Network } from "./networks.js";

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
  method?: "GET" | "POST" | "PUT" | "DELETE";
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
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

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
    /** Every Rhea lending asset's rates, Hyperliquid's NEAR funding and the vault's yield, each with its source. */
    rates: () => api.request<Rates>("/v1/rates"),
    /** Parry's risk model, guardian and vault replayed through NEAR's largest historical crashes. */
    replay: () => api.request<Replay>("/v1/replay"),
    /** Re-checks a decision id, a certificate hash or a NEAR transaction hash. */
    verify: (id: string) => api.request<VerifyResult>(`/v1/verify/${seg(id)}`),
    /** What each rescue's route choice saved against the worst quote. */
    routeSavings: (account?: string) => api.request<RouteSavings>("/v1/routes/savings", { query: { account } }),
    /** The vault's insurance fund (`insurance()` view) and its inflows and payouts. */
    vaultInsurance: () => api.request<VaultInsurance>("/v1/vault/insurance"),
    /** Every Rhea lending borrower's liquidation price, bucketed, and the chained cascades. */
    heatmap: (q: { network?: Network; asset?: string } = {}) => api.request<Heatmap>("/v1/heatmap", { query: { network: q.network, asset: q.asset } }),
    /** USD prices with 24-hour change for NEAR, the liquid staking tokens, USDC and every Rhea asset. */
    prices: (tokens?: string[]) => api.request<Prices>("/v1/prices", { query: { tokens: tokens?.join(",") } }),
    /** Related alerts grouped into incidents, newest first. */
    incidents: (account: string) => api.request<Incident[]>("/v1/incidents", { query: { account } }),
    /** A sign-in challenge for `accountId` (sign it with `signInNep413`, or a passkey). */
    authChallenge: (accountId: string) => api.request<{ nonce: string; message: string; recipient: string }>("/v1/auth/challenge", { method: "POST", body: { accountId } }),
    /** Exchanges a signed challenge for a session token. */
    authVerify: (proof: { accountId: string; nonce: string; nep413?: { publicKey: string; signature: string }; passkey?: { authenticator_data: string; client_data_json: string; signature: string } }) =>
      api.request<{ token: string }>("/v1/auth/verify", { method: "POST", body: proof }),
    /** The signed-in account's watched accounts, each with its live risk (auth). */
    watchlist: (token: string) => api.request<WatchRow[]>("/v1/watch", { headers: auth(token) }),
    /** Watches `accountId` with these thresholds (auth). */
    watch: (token: string, accountId: string, body: { thresholds: WatchThresholds; label?: string }) =>
      api.request<WatchRow>(`/v1/watch/${seg(accountId)}`, { method: "PUT", body, headers: auth(token) }),
    unwatch: (token: string, accountId: string) => api.request<{ ok: true }>(`/v1/watch/${seg(accountId)}`, { method: "DELETE", headers: auth(token) }),
    /** Has the enclave certify that an account's health is at least a threshold, for a reader (auth). */
    issueCertificate: (token: string, req: CertificateRequest) => api.request<Certificate>("/v1/certificates", { method: "POST", body: req, headers: auth(token) }),
    certificates: (account: string) => api.request<Certificate[]>("/v1/certificates", { query: { account } }),
    certificate: (hash: string) => api.request<Certificate>(`/v1/certificates/${seg(hash)}`),
    status: () => api.request<Status>("/v1/status"),
    rescueQuote: (amountNear: number) => api.request<RouteComparison>("/v1/quotes/rescue", { query: { amountNear } }),
    /** Relays a passkey-signed owner request to `owner_execute` (the relayer pays the gas). */
    relayOwnerRequest: (text: string, assertion: PasskeyAssertion) => {
      // The request names its account; the relayer checks it is a Parry account before relaying.
      const account = (JSON.parse(text) as { account?: string }).account;
      if (!account) throw new Error("the owner request names no account");
      return api.request<{ txHash: string; value?: unknown }>("/v1/relay/owner", { method: "POST", body: { account, request: text, assertion } });
    },
    /** Creates a protected account without gas, for a passkey (compressed P-256 hex) or a NEAR account. */
    createProtectedAccount: (owner: { passkey: string } | { nearAccount: string }) =>
      api.request<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: owner }),
    /** Relays a NEP-366 signed delegate action (standard base64 of its borsh bytes). */
    relayDelegate: (signedDelegateAction: string) =>
      api.request<{ txHash: string }>("/v1/relay/delegate", { method: "POST", body: { signedDelegateAction } }),
  };
}

export type ApiMethods = ReturnType<typeof apiMethods>;
