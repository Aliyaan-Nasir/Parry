// The Parry API, NEAR RPC and wallet manifests, answered from the fixtures inside the test browser,
// so the end-to-end tests never reach a real service (a local API may be running on the same port).

import { createHash } from "node:crypto";
import type { CDPSession, Page, Request, Route } from "@playwright/test";
import { p256 } from "@noble/curves/nist.js";
import { fromBase64, requestDigest, toBase64, toBase64Url, type Alert, type OwnerAction } from "@parryguard/sdk";
import type { Settings } from "@/lib/api-types";
import * as fx from "./fixtures";

export const API_ORIGIN = "http://localhost:4000";

export type MockResponse = { status?: number; body?: unknown; headers?: Record<string, string> };

export type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
};

export type MockContext = RecordedRequest & {
  params: Record<string, string>;
  /** The fixtures' clock: fixed when the mock is installed, so ids and times stay stable. */
  now: number;
  state: MockState;
};

export type MockHandler = (ctx: MockContext) => MockResponse;

/** A route as "METHOD /v1/path/:param", for example "GET /v1/accounts/:id". */
export type RouteKey = string;

export type MockOptions = {
  /** "ok" (default) serves the fixtures; "empty" an account with nothing in it and no vault report; "down" answers 503; "unreachable" refuses connections. */
  api?: "ok" | "empty" | "down" | "unreachable";
  /** "down" makes every NEAR RPC call fail (HTTP 400, not retried). */
  rpc?: "ok" | "down";
  /** Who owns the fixture account: its NEAR wallet (default) or the fixture passkey. */
  ownerKind?: "near" | "passkey";
  /** Replaces a route's answer: a fixed response or a handler. */
  overrides?: Record<RouteKey, MockResponse | MockHandler>;
};

export type MockState = {
  mode: NonNullable<MockOptions["api"]>;
  ownerKind: "near" | "passkey";
  alerts: Alert[];
  settings: Map<string, Settings>;
  /** Sign-in tokens issued by /v1/auth/verify, with the account each signs in as. */
  tokens: Map<string, string>;
  challenges: Map<string, { account: string; message: string }>;
  shockBps: number | null;
  lastShockAt: number | null;
  /** The last owner request nonce used, per account (`nonces()` answers [owner, guardian]). */
  ownerNonce: Map<string, number>;
  /** Accounts created through the relay: owner (NEAR account or passkey hex) to account. */
  created: Map<string, string>;
  /** Passkey owners' compressed P-256 keys, per account, to check relayed signatures. */
  passkeys: Map<string, string>;
  /** NEAR balances in yocto per account (view_account). */
  balances: Map<string, bigint>;
  /** The global code each account runs (view_account's global_contract_hash); none by default. */
  accountCodes: Map<string, string>;
  /** Watched accounts per signed-in account. */
  watch: Map<string, Map<string, { thresholds: { score: number; health: number }; label: string | null }>>;
  /** Set once a relayed owner request closes the Rhea position (`close_rhea`): its debt is then gone. */
  rheaClosed: boolean;
  /** Certificates issued through the API, newest first. */
  certificates: ReturnType<typeof fx.certificate>[];
  /** The account's Hyperliquid address: Perps value, Spot USDC, its NEAR perp size, and every `/exchange` body it received. */
  hyperliquid: { perps: number; spotUsdc: number; nearSize: number; exchange: { action: { type: string; [k: string]: unknown }; nonce: number; signature: unknown }[]; reject: string | null };
};

export type MockHandle = {
  state: MockState;
  /** Every API request, in order. */
  requests: RecordedRequest[];
  /** Requests with this method to this exact path. */
  calls: (method: string, path: string) => RecordedRequest[];
  /** Every view call made over NEAR RPC. */
  rpcCalls: { accountId: string; method: string; args: unknown }[];
  /** API paths no route answered (they get a 404). */
  unmatched: string[];
  override: (key: RouteKey, response: MockResponse | MockHandler) => void;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-payment",
  "access-control-expose-headers": "x-payment-response",
};

const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const sha256 = (data: string | Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());
const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const json = (body: unknown, status = 200): MockResponse => ({ status, body });
const error = (message: string, status: number): MockResponse => ({ status, body: { error: message } });

function bearer(ctx: MockContext): string | null {
  const token = ctx.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  return token ? (ctx.state.tokens.get(token) ?? null) : null;
}

/** Checks a passkey assertion over `challenge` with the account's key (as the contract and the API do). */
function passkeySigned(assertion: unknown, challenge: Uint8Array, key: string): string | null {
  const a = assertion as { authenticator_data?: string; client_data_json?: string; signature?: string } | null;
  if (!a?.authenticator_data || !a.client_data_json || !a.signature) return "the assertion is incomplete";
  let client: { type?: string; challenge?: string };
  try {
    client = JSON.parse(a.client_data_json) as { type?: string; challenge?: string };
  } catch {
    return "clientDataJSON is not JSON";
  }
  if (client.type !== "webauthn.get") return "not a webauthn.get assertion";
  if (client.challenge !== toBase64Url(challenge)) return "the assertion is for another challenge";
  const auth = fromBase64(a.authenticator_data);
  const signed = new Uint8Array([...auth, ...sha256(a.client_data_json)]);
  const ok = p256.verify(Buffer.from(a.signature, "hex"), signed, Buffer.from(key, "hex"));
  return ok ? null : "passkey signature does not verify";
}

/** The passkey that owns `account`, if a passkey owns it. */
function passkeyOf(state: MockState, account: string): string | null {
  return state.passkeys.get(account) ?? (account === fx.ACCOUNT && state.ownerKind === "passkey" ? fx.PASSKEY.publicKey : null);
}

function protectedAccountFor(owner: string): string {
  if (owner === fx.OWNER_WALLET) return fx.ACCOUNT;
  return `0u${sha256Hex(`parry-e2e:account:${owner}`).slice(0, 52)}`;
}

// ---------------------------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------------------------

type RouteDef = { key: RouteKey; method: string; parts: string[]; handler: MockHandler };

function route(key: RouteKey, handler: MockHandler): RouteDef {
  const [method, path] = key.split(" ") as [string, string];
  return { key, method, parts: path.split("/").filter(Boolean), handler };
}

function match(def: RouteDef, method: string, parts: string[]): Record<string, string> | null {
  if (def.method !== method || def.parts.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const want = def.parts[i]!;
    const got = parts[i]!;
    if (want.startsWith(":")) params[want.slice(1)] = got;
    else if (want !== got) return null;
  }
  return params;
}

const empty = (ctx: MockContext) => ctx.state.mode === "empty";

const ROUTES: RouteDef[] = [
  route("GET /v1/stats", (c) => json(fx.stats(c.now))),
  route("GET /v1/config", () => json(fx.config())),
  route("GET /v1/market", (c) => json(fx.market(c.now))),
  route("GET /v1/fx", (c) => json(fx.fx(c.now))),
  route("GET /v1/rates", () => json(fx.rates())),
  route("GET /v1/status", (c) => json(fx.status(c.now))),
  route("GET /v1/replay", () => json(fx.replay())),
  route("GET /v1/heatmap", (c) => json(fx.heatmap(c.now, c.query.network ?? "testnet"))),
  route("GET /v1/prices", (c) => json(fx.prices(c.now))),
  route("GET /v1/vault/insurance", (c) => json(fx.insurance(c.now))),
  route("GET /v1/routes/savings", (c) => json(fx.savings(c.now))),
  route("GET /v1/incidents", (c) => json(c.query.account === fx.ACCOUNT && !empty(c) ? fx.incidents(c.now) : [])),
  // The stream: one comment, then the connection closes (the client falls back to polling).
  route("GET /v1/stream", () => ({ status: 200, body: ": parry\n\nevent: alert\ndata: {}\n\n", headers: { "content-type": "text/event-stream" } })),
  route("GET /v1/certificates", (c) => json(c.query.account === fx.ACCOUNT ? c.state.certificates : [])),
  route("GET /v1/certificates/:hash", (c) => {
    const cert = [...c.state.certificates, fx.certificate(c.now)].find((x) => x.hash === c.params.hash);
    return cert ? json(cert) : error("no such certificate", 404);
  }),
  route("POST /v1/certificates", (c) => {
    const who = bearer(c);
    if (!who) return error("sign in first", 401);
    const req = c.body as { account?: string; reader?: string; threshold?: number };
    if (req.account !== who) return error("not your account", 403);
    if ((req.threshold ?? 0) > 1.5) return error("health is below the threshold", 422);
    const cert = fx.certificate(c.now, req.reader ?? "", req.threshold ?? 1.3);
    c.state.certificates.unshift(cert);
    return json(cert);
  }),
  route("GET /v1/verify/:id", (c) => {
    const cert = [...c.state.certificates, fx.certificate(c.now)].find((x) => x.hash === c.params.id);
    if (cert) {
      const body = JSON.parse(cert.certificate) as { statement: string; reader: string; block_height: number };
      return json({
        kind: "certificate",
        ok: true,
        checks: [
          { name: "hash", ok: true, detail: `SHA-256 of the domain and certificate is ${cert.hash}` },
          { name: "signature", ok: true, detail: `signed by ${fx.ENCLAVE_PUBLIC_KEY}` },
          { name: "statement", ok: true, detail: `${body.statement} at block ${body.block_height}, for ${body.reader}` },
          { name: "expiry", ok: true, detail: "valid for another 23 hours" },
        ],
        subject: cert,
      });
    }
    return error("unknown id", 404);
  }),
  route("GET /v1/watch", (c) => {
    const who = bearer(c);
    if (!who) return error("sign in first", 401);
    return json([...(c.state.watch.get(who) ?? new Map()).entries()].map(([account, w]) => ({ account, ...w, position: null, alert: [] })));
  }),
  route("PUT /v1/watch/:id", (c) => {
    const who = bearer(c);
    if (!who) return error("sign in first", 401);
    const body = c.body as { thresholds: { score: number; health: number }; label?: string };
    const list = c.state.watch.get(who) ?? new Map();
    list.set(c.params.id!, { thresholds: body.thresholds, label: body.label ?? null });
    c.state.watch.set(who, list);
    return json({ account: c.params.id, thresholds: body.thresholds, label: body.label ?? null, position: null, alert: [] });
  }),
  route("DELETE /v1/watch/:id", (c) => {
    const who = bearer(c);
    if (!who) return error("sign in first", 401);
    c.state.watch.get(who)?.delete(c.params.id!);
    return json({ ok: true });
  }),
  route("GET /v1/treasury", () => json({ account: "treasury.parry.testnet", balanceNear: 182.4 })),

  route("GET /v1/accounts/by-owner/:owner", (c) => {
    const owner = c.params.owner!;
    const created = c.state.created.get(owner);
    if (created) return json([created]);
    if (owner === fx.OWNER_WALLET || owner === fx.PASSKEY.publicKey) return json([fx.ACCOUNT]);
    return json([]);
  }),
  route("GET /v1/accounts/:id", (c) => {
    const id = c.params.id!;
    if (!ACCOUNT_ID.test(id)) return error("not a NEAR account id", 400);
    if (id === fx.ACCOUNT) return json(fx.accountSummary(c.now, { ownerKind: c.state.ownerKind, empty: empty(c) }));
    const key = c.state.passkeys.get(id);
    const owner = [...c.state.created.entries()].find(([, a]) => a === id)?.[0];
    if (!owner) return error("not a Parry protected account", 404);
    return json({
      ...fx.accountSummary(c.now, { empty: true }),
      account: id,
      owner: key ? { kind: "passkey", id: key } : { kind: "near", id: owner },
    });
  }),
  route("GET /v1/accounts/:id/positions", (c) => {
    const id = c.params.id!;
    if (!ACCOUNT_ID.test(id)) return error("not a NEAR account id", 400);
    return json(id === fx.ACCOUNT && !empty(c) ? fx.positions(c.now) : []);
  }),
  route("GET /v1/accounts/:id/portfolio", (c) => {
    const id = c.params.id!;
    if (!ACCOUNT_ID.test(id)) return error("not a NEAR account id", 400);
    return json({ ...fx.portfolio(c.now, empty(c) || id !== fx.ACCOUNT), account: id });
  }),
  route("GET /v1/positions/:id/history", (c) => {
    const hours = Math.min(168, Math.max(1, Number(c.query.hours ?? 24)));
    return json(empty(c) ? [] : fx.history(c.params.id!, hours, c.now));
  }),
  route("GET /v1/risk/:id", (c) => json(fx.riskCheck(c.now))),
  route("GET /v1/paid/risk/:id", (c) =>
    json(
      {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "near:testnet",
            asset: fx.CONTRACTS.usdc,
            amount: "10000",
            payTo: "api.parry.testnet",
            resource: `${API_ORIGIN}/v1/paid/risk/${c.params.id}`,
            description: "A Parry risk check",
            maxTimeoutSeconds: 120,
          },
        ],
      },
      402,
    ),
  ),
  route("POST /v1/simulate/:id", (c) =>
    json(empty(c) || c.params.id !== fx.ACCOUNT ? { account: c.params.id, triggered: false, reason: "no lending position", steps: [], routes: null } : fx.simulation()),
  ),
  route("GET /v1/quotes/rescue", (c) => json(fx.routeComparison(Math.max(0.1, Number(c.query.amountNear ?? 10))))),

  route("GET /v1/guardian/decisions", (c) => {
    const limit = Math.min(100, Number(c.query.limit ?? 25));
    const all = empty(c) || (c.query.account && c.query.account !== fx.ACCOUNT) ? [] : fx.decisions(c.now);
    const cursor = c.query.cursor ? Date.parse(c.query.cursor) : null;
    const rows = all.filter((d) => cursor === null || Date.parse(d.createdAt) < cursor).slice(0, limit);
    return json({ items: rows, next: rows.length === limit ? rows[rows.length - 1]!.createdAt : null });
  }),
  route("GET /v1/guardian/decisions/:id", (c) => {
    const d = fx.decisions(c.now).find((x) => x.id === c.params.id);
    return d ? json(d) : error("no such decision", 404);
  }),
  route("GET /v1/guardian/decisions/:id/verify", (c) => {
    const d = fx.decisions(c.now).find((x) => x.id === c.params.id);
    return d ? json(fx.verification(d)) : error("no such decision", 404);
  }),

  route("GET /v1/alerts", (c) => {
    const account = c.query.account;
    if (!account) return error("account is required", 400);
    if (empty(c) || account !== fx.ACCOUNT) return json([]);
    return json(c.state.alerts.filter((a) => !c.query.status || a.status === c.query.status));
  }),
  ...(["ack", "resolve"] as const).map((action) =>
    route(`POST /v1/alerts/:id/${action}`, (c) => {
      const who = bearer(c);
      if (!who) return error("sign in first", 401);
      const alert = c.state.alerts.find((a) => a.id === c.params.id && a.account === who);
      if (!alert) return error("no such alert for this account", 404);
      alert.status = action === "ack" ? "acknowledged" : "resolved";
      alert.updatedAt = new Date().toISOString();
      return json({ id: alert.id, status: alert.status });
    }),
  ),

  route("POST /v1/auth/challenge", (c) => {
    const accountId = (c.body as { accountId?: string } | null)?.accountId ?? "";
    if (!ACCOUNT_ID.test(accountId)) return error("not a NEAR account id", 400);
    const nonce = sha256Hex(`parry-e2e:nonce:${accountId}:${c.state.challenges.size}`);
    const message = `Sign in to Parry as ${accountId}. Nonce ${nonce}.`;
    c.state.challenges.set(nonce, { account: accountId, message });
    return json({ nonce, message, recipient: "parry" });
  }),
  route("POST /v1/auth/verify", (c) => {
    const p = c.body as { accountId?: string; nonce?: string; nep413?: { publicKey?: string; signature?: string }; passkey?: unknown } | null;
    const challenge = p?.nonce ? c.state.challenges.get(p.nonce) : undefined;
    if (!p || !challenge || challenge.account !== p.accountId) return error("unknown or expired challenge", 401);
    c.state.challenges.delete(p.nonce!);
    if (p.nep413) {
      if (!p.nep413.publicKey?.startsWith("ed25519:") || !p.nep413.signature) return error("NEP-413 signature does not verify", 401);
    } else if (p.passkey) {
      const key = passkeyOf(c.state, p.accountId!);
      if (!key) return error("sign with what owns the account", 401);
      const problem = passkeySigned(p.passkey, sha256(challenge.message), key);
      if (problem) return error(problem, 401);
    } else {
      return error("sign with what owns the account", 401);
    }
    const token = sha256Hex(`parry-e2e:token:${p.accountId}:${c.state.tokens.size}`);
    c.state.tokens.set(token, p.accountId!);
    return json({ token });
  }),

  route("GET /v1/settings/:id", (c) => {
    const id = c.params.id!;
    if (!ACCOUNT_ID.test(id)) return error("not a NEAR account id", 400);
    return json(c.state.settings.get(id) ?? fx.settings(id));
  }),
  route("PUT /v1/settings/:id", (c) => {
    const id = c.params.id!;
    if (bearer(c) !== id) return error("sign in as this account first", 401);
    const b = (c.body ?? {}) as Partial<Settings> & { email?: string | null; digest?: "off" | "daily"; linkTelegram?: boolean };
    const s = c.state.settings.get(id) ?? fx.settings(id);
    const next: Settings = {
      ...s,
      ...(b.thresholds ? { thresholds: b.thresholds } : {}),
      ...(b.displayCurrency ? { displayCurrency: b.displayCurrency } : {}),
      email: { address: b.email !== undefined ? b.email : s.email.address, digest: b.digest ?? s.email.digest },
      telegram: b.linkTelegram ? { ...s.telegram, deepLink: `https://t.me/parry_alerts_bot?start=${sha256Hex(id).slice(0, 16)}` } : s.telegram,
    };
    c.state.settings.set(id, next);
    return json({ ok: true });
  }),
  route("POST /v1/push/subscribe", (c) => {
    const who = bearer(c);
    if (!who) return error("sign in first", 401);
    const s = c.state.settings.get(who) ?? fx.settings(who);
    c.state.settings.set(who, { ...s, push: true });
    return json({ ok: true });
  }),

  route("GET /v1/vault", (c) => json(fx.vault(c.now, empty(c)))),
  route("GET /v1/vault/history", (c) => json(empty(c) ? [] : fx.vaultHistory(Math.min(90, Math.max(1, Number(c.query.days ?? 7))), c.now))),
  route("GET /v1/vault/reserves", (c) => (empty(c) ? error("no vault report yet", 404) : json(fx.reserves(c.now)))),

  route("POST /v1/copilot", (c) => {
    const b = c.body as { account?: string } | null;
    if (!b?.account || !ACCOUNT_ID.test(b.account)) return error("not a NEAR account id", 500);
    if (empty(c) || b.account !== fx.ACCOUNT) return error("no position to explain", 404);
    return json(fx.copilot());
  }),

  route("POST /v1/relay/create-account", (c) => {
    const b = (c.body ?? {}) as { passkey?: string; nearAccount?: string };
    const owner = b.passkey ?? b.nearAccount;
    if (!owner || (b.passkey && b.nearAccount)) return error("give exactly one of passkey or nearAccount", 400);
    if (b.passkey && !/^0[23][0-9a-f]{64}$/.test(b.passkey)) return error("passkey must be a compressed P-256 key", 400);
    const accountId = b.passkey ? (c.state.created.get(b.passkey) ?? (c.state.created.size === 0 ? fx.PASSKEY_ACCOUNT : protectedAccountFor(b.passkey))) : protectedAccountFor(owner);
    c.state.created.set(owner, accountId);
    if (b.passkey) c.state.passkeys.set(accountId, b.passkey);
    return json({ accountId, txHash: fx.txHash(`create:${accountId}`) });
  }),
  route("POST /v1/relay/owner", (c) => {
    const b = (c.body ?? {}) as { account?: string; request?: string; assertion?: unknown };
    if (!b.account || !b.request || !b.assertion) return error("not a Parry protected account", 400);
    let request: { account?: string; nonce?: number };
    try {
      request = JSON.parse(b.request) as { account?: string; nonce?: number };
    } catch {
      return error("bad request", 400);
    }
    if (request.account !== b.account) return error("Smart contract panicked: request is for another account", 400);
    const last = c.state.ownerNonce.get(b.account) ?? 3;
    if (!request.nonce || request.nonce <= last) return error("Smart contract panicked: request nonce already used", 400);
    const key = passkeyOf(c.state, b.account);
    if (key) {
      const problem = passkeySigned(b.assertion, requestDigest(b.request), key);
      if (problem) return error(`Smart contract panicked: ${problem}`, 400);
    }
    c.state.ownerNonce.set(b.account, request.nonce);
    const actions = (request as { actions?: unknown[] }).actions ?? [];
    if (actions.some((a) => typeof a === "object" && a !== null && "close_rhea" in a)) c.state.rheaClosed = true;
    // A signing action returns the MPC signature, as the account contract does.
    const signs = actions.some((a) => typeof a === "object" && a !== null && ("hl_order" in a || "hl_margin_to_perp" in a || "mpc_sign" in a));
    return json({ txHash: fx.txHash(`owner:${b.account}:${request.nonce}`), value: signs ? fx.MPC_SIGNATURE : null });
  }),
  route("POST /v1/relay/delegate", (c) => json({ txHash: fx.txHash(`delegate:${c.state.tokens.size}`) })),

  route("GET /v1/shock", (c) => json(fx.shock(c.now, empty(c) ? null : c.state.shockBps))),
  route("POST /v1/shock", (c) => {
    const bps = Math.trunc(Number((c.body as { bps?: unknown } | null)?.bps));
    if (!Number.isFinite(bps)) return error("bps must be an integer", 400);
    if (bps === 0) {
      // The relayer clears the shock with the oracle's reset_shock (no rate limit on a reset).
      if (c.state.shockBps === null) return error("Smart contract panicked: no shock", 400);
      c.state.shockBps = null;
      return json({ txHash: fx.txHash(`shock-reset:${Date.now()}`), shock: null });
    }
    if (Math.abs(bps) > 4000) return error("Smart contract panicked: |bps| must be at most 4000", 400);
    const t = Date.now();
    if (c.state.lastShockAt !== null && t - c.state.lastShockAt < 60_000) {
      const next = Math.floor((c.state.lastShockAt + 60_000) / 1000);
      return error(`Smart contract panicked: one shock per account per 60 s: next at ${next} (unix seconds)`, 400);
    }
    c.state.lastShockAt = t;
    c.state.shockBps = bps;
    return json({ txHash: fx.txHash(`shock:${t}`), shock: fx.shock(t, bps).shock });
  }),
];

// ---------------------------------------------------------------------------------------------
// NEAR RPC
// ---------------------------------------------------------------------------------------------

const BLOCK = { block_height: 221_455_120, block_hash: "8iPzcDmfqTy9NJuB3TJm2sFxvFmQ1nGxu7kT3KcRZ2fV" };
const NOT_FOUND = Symbol("not found");

function view(state: MockState, now: number, accountId: string, method: string, args: Record<string, unknown>): unknown {
  const C = fx.CONTRACTS;
  const isEmpty = state.mode === "empty";
  if (accountId === C.factory && method === "account_id_of") {
    const owner = (args.near_account as string | null) ?? (args.passkey as string | null) ?? "";
    return state.created.get(owner) ?? protectedAccountFor(owner);
  }
  const enclaveKey = { index: 0, public_key: fx.ENCLAVE_PUBLIC_KEY, wasm_sha256: fx.config().enclave.wasmSha256, since: Math.floor(now / 1000) - 30 * 86_400, note: "initial key" };
  if (accountId === C.risk && method === "get_enclave") return enclaveKey;
  if (accountId === C.risk && method === "enclave_history") return [enclaveKey];
  if (accountId === C.risk && method === "sealing_key") return { public_key: fx.SEALING_PUBLIC_KEY, run_id: 412, at: Math.floor(now / 1000) - 3_600, key_index: 0 };
  if (accountId === C.vault && method === "vault_state") return fx.vaultChainState(now);
  // The close: no round in flight, and the Rhea position's lines until a close round lands.
  if (accountId === fx.ACCOUNT && method === "closing") return null;
  if (accountId === C.lending && method === "get_account") {
    if ((args.account_id as string) !== fx.ACCOUNT || isEmpty) return null;
    const debt = state.rheaClosed ? [] : [{ token_id: C.usdc, balance: "195000000000000000000" }];
    const collateral = state.rheaClosed ? [] : [{ token_id: C.wnear, balance: "100000000000000000000000000" }];
    return { account_id: fx.ACCOUNT, supplied: [], collateral, borrowed: debt };
  }
  if (accountId === C.vault && method === "ft_balance_of") return (args.account_id as string) === fx.ACCOUNT && !isEmpty ? "1500000000000000000000000000" : "0";
  if (accountId === C.lending && method === "get_asset") {
    const token = args.token_id as string;
    if (token === C.wnear) return { token_id: token, config: { volatility_ratio: 7500, extra_decimals: 0, can_use_as_collateral: true, can_borrow: true } };
    if (token === C.usdc) return { token_id: token, config: { volatility_ratio: 9500, extra_decimals: 12, can_use_as_collateral: true, can_borrow: true } };
    return null;
  }
  if (accountId === C.oracle && method === "status") return { owner_id: "parry.testnet", feeders: ["keeper.parry.testnet"], network: "testnet", max_shock_bps: 4000, feeds: [] };
  if (accountId === C.oracle && method === "shock_of") return fx.shock(now, isEmpty ? null : state.shockBps).shock;
  if (accountId === C.usdc && method === "ft_balance_of") return (args.account_id as string) === fx.ACCOUNT && !isEmpty ? "45595276" : "0";
  if (accountId === C.wnear && method === "ft_balance_of") return "0";
  if (accountId === C.usdc && method === "ft_metadata") return { spec: "ft-1.0.0", name: "Parry test USDC", symbol: "USDC", decimals: 6 };
  // Protected accounts.
  const known = accountId === fx.ACCOUNT || state.passkeys.has(accountId) || [...state.created.values()].includes(accountId);
  if (known) {
    if (method === "mandate") return accountId === fx.ACCOUNT && !isEmpty ? fx.mandateView(now) : null;
    if (method === "nonces") return [state.ownerNonce.get(accountId) ?? 3, 7];
    if (method === "stats") return accountId === fx.ACCOUNT && !isEmpty ? { guardian_actions: 2, deleverages: 0 } : { guardian_actions: 0, deleverages: 0 };
    if (method === "owner") {
      const key = passkeyOf(state, accountId);
      return key ? { passkey: { key: [...Buffer.from(key, "hex")] } } : { near: { account_id: fx.OWNER_WALLET } };
    }
  }
  return NOT_FOUND;
}

type RpcRequest = { id?: number | string; method?: string; params?: Record<string, unknown> } | null;

/** The JSON-RPC answer to one NEAR RPC request, as a FastNEAR node would give it. */
export function rpcReply(state: MockState, now: number, req: RpcRequest, calls: MockHandle["rpcCalls"] = []): Record<string, unknown> {
  const reply = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", id: req?.id ?? 0, ...body });
  const p = req?.params ?? {};
  if (req?.method === "query" && p.request_type === "call_function") {
    const accountId = String(p.account_id);
    const method = String(p.method_name);
    let args: Record<string, unknown> = {};
    try {
      const text = Buffer.from(String(p.args_base64 ?? ""), "base64").toString("utf8");
      args = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    calls.push({ accountId, method, args });
    const value = view(state, now, accountId, method, args);
    if (value === NOT_FOUND) {
      return reply({ result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [], ...BLOCK } });
    }
    return reply({ result: { result: [...Buffer.from(JSON.stringify(value), "utf8")], logs: [], ...BLOCK } });
  }
  if (req?.method === "query" && p.request_type === "view_account") {
    const accountId = String(p.account_id);
    calls.push({ accountId, method: "view_account", args: {} });
    const amount = state.balances.get(accountId) ?? 25_000_000_000_000_000_000_000_000n;
    const global = state.accountCodes.get(accountId) ?? null;
    return reply({ result: { amount: amount.toString(), locked: "0", code_hash: "11111111111111111111111111111111", global_contract_hash: global, storage_usage: 1820, storage_paid_at: 0, ...BLOCK } });
  }
  if (req?.method === "block") {
    return reply({ result: { author: "node0", header: { height: BLOCK.block_height, hash: BLOCK.block_hash, timestamp: now * 1_000_000 }, chunks: [] } });
  }
  return reply({ error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND", info: { method_name: req?.method } }, code: -32601, message: "Method not found", data: String(req?.method) } });
}

async function answerRpc(route: Route, request: Request, state: MockState, now: number, mode: MockOptions["rpc"], calls: MockHandle["rpcCalls"]) {
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  if (mode === "down") return route.fulfill({ status: 400, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "rpc down" }) });
  const body = rpcReply(state, now, request.postDataJSON() as RpcRequest, calls);
  return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------

/** A new mock state, as `mockApi` starts with. */
export function freshState(options: MockOptions, now: number): MockState {
  return {
    mode: options.api ?? "ok",
    ownerKind: options.ownerKind ?? "near",
    alerts: fx.alerts(now),
    settings: new Map(),
    tokens: new Map(),
    challenges: new Map(),
    shockBps: -2000,
    lastShockAt: null,
    ownerNonce: new Map(),
    created: new Map(),
    passkeys: new Map(),
    balances: new Map(),
    accountCodes: new Map(),
    watch: new Map(),
    rheaClosed: false,
    certificates: [],
    hyperliquid: { perps: 0, spotUsdc: 0, nearSize: 0, exchange: [], reject: null },
  };
}

/**
 * Answers every request to the Parry API (http://localhost:4000), NEAR RPC (FastNEAR) and the
 * wallet manifest hosts from the fixtures. Call it before `page.goto`.
 */
export async function mockApi(page: Page, options: MockOptions = {}): Promise<MockHandle> {
  const now = Date.now();
  const state = freshState(options, now);
  const overrides = new Map<RouteKey, MockResponse | MockHandler>(Object.entries(options.overrides ?? {}));
  const handle: MockHandle = {
    state,
    requests: [],
    calls: (method, path) => handle.requests.filter((r) => r.method === method && r.path === path),
    rpcCalls: [],
    unmatched: [],
    override: (key, response) => {
      overrides.set(key, response);
    },
  };

  await page.route(
    (url) => url.origin === API_ORIGIN,
    async (r, request) => {
      if (request.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      if (state.mode === "unreachable") return r.abort("connectionrefused");
      const url = new URL(request.url());
      const raw = request.postData();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const recorded: RecordedRequest = { method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: await request.allHeaders() };
      handle.requests.push(recorded);
      let res: MockResponse;
      if (state.mode === "down") {
        res = error("service unavailable", 503);
      } else {
        const parts = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
        let found: { def: RouteDef; params: Record<string, string> } | null = null;
        for (const def of ROUTES) {
          const params = match(def, recorded.method, parts);
          if (params) {
            found = { def, params };
            break;
          }
        }
        const ctx: MockContext = { ...recorded, params: found?.params ?? {}, now, state };
        const override = found ? overrides.get(found.def.key) : overrides.get(`${recorded.method} ${url.pathname}`);
        if (override) res = typeof override === "function" ? override(ctx) : override;
        else if (found) res = found.def.handler(ctx);
        else {
          handle.unmatched.push(`${recorded.method} ${url.pathname}`);
          res = error("not found", 404);
        }
      }
      const text = res.headers?.["content-type"] && !res.headers["content-type"].includes("json");
      return r.fulfill({
        status: res.status ?? 200,
        headers: { ...CORS, ...res.headers },
        contentType: res.headers?.["content-type"] ?? "application/json",
        body: text ? String(res.body ?? "") : JSON.stringify(res.body ?? null),
      });
    },
  );

  await page.route(
    (url) => url.hostname.endsWith("fastnear.com") || url.hostname === "rpc.testnet.near.org",
    (r, request) => answerRpc(r, request, state, now, options.rpc, handle.rpcCalls),
  );

  // Hyperliquid's API, which the app calls from the browser.
  await page.route(
    (url) => url.hostname === "api.hyperliquid-testnet.xyz",
    async (r, request) => {
      if (request.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      const hl = state.hyperliquid;
      const body = JSON.parse(request.postData() ?? "{}") as { type?: string; action?: { type: string; amount?: string; orders?: { r: boolean }[] }; nonce?: number; signature?: unknown };
      const reply = (v: unknown) => r.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(v) });
      if (new URL(request.url()).pathname === "/exchange") {
        hl.exchange.push(body as MockState["hyperliquid"]["exchange"][number]);
        if (body.action?.type === "usdClassTransfer") {
          const amount = Number(body.action.amount);
          hl.spotUsdc -= amount;
          hl.perps += amount;
          return reply({ status: "ok", response: { type: "default" } });
        }
        if (hl.reject) return reply({ status: "ok", response: { type: "order", data: { statuses: [{ error: hl.reject }] } } });
        if (body.action?.orders?.[0]?.r) hl.nearSize = 0;
        return reply({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "1", avgPx: "2.86", oid: 1 } }] } } });
      }
      switch (body.type) {
        case "clearinghouseState":
          return reply({ marginSummary: { accountValue: String(hl.perps) }, assetPositions: hl.nearSize ? [{ position: { coin: "NEAR", szi: String(hl.nearSize) } }] : [] });
        case "spotClearinghouseState":
          return reply({ balances: hl.spotUsdc > 0 ? [{ coin: "USDC", token: 0, total: String(hl.spotUsdc), hold: "0" }] : [] });
        case "meta":
          return reply({ universe: Array.from({ length: 55 }, (_, i) => (i === 54 ? { name: "NEAR", szDecimals: 1 } : { name: `C${i}`, szDecimals: 2 })) });
        case "allMids":
          return reply({ NEAR: "2.86" });
        default:
          return reply(null);
      }
    },
  );

  // Wallet manifests: an empty list, so nothing loads from the network.
  await page.route(
    (url) => url.hostname === "raw.githubusercontent.com" || url.hostname === "cdn.jsdelivr.net",
    (r) => r.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ wallets: [], version: "0.0.0" }) }),
  );

  return handle;
}

// ---------------------------------------------------------------------------------------------
// Connected states
// ---------------------------------------------------------------------------------------------

export type AccountKind = "watch" | "passkey" | "wallet";

/**
 * Puts the app in a connected state before the first load, the way the app itself stores it
 * (localStorage, JSON values). Seeds once per tab, so the app's own changes survive reloads.
 */
export async function seedAccount(page: Page, kind: AccountKind): Promise<void> {
  const entries: Record<string, unknown> = { "parry-account": fx.ACCOUNT };
  if (kind === "watch") entries["parry-watch"] = fx.ACCOUNT;
  if (kind === "passkey") entries["parry-passkey"] = { credentialId: fx.PASSKEY.credentialId, publicKey: fx.PASSKEY.publicKey, accountId: fx.ACCOUNT };
  if (kind === "wallet") entries["parry-wallet"] = { accountId: fx.OWNER_WALLET, walletId: "hot-wallet" };
  await page.addInitScript((values: Record<string, string>) => {
    try {
      if (window.sessionStorage.getItem("parry-e2e-seeded")) return;
      for (const [k, v] of Object.entries(values)) window.localStorage.setItem(k, v);
      window.sessionStorage.setItem("parry-e2e-seeded", "1");
    } catch {
      // Storage unavailable: the app starts disconnected.
    }
  }, Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)])));
}

// ---------------------------------------------------------------------------------------------
// Passkeys (Chromium's virtual authenticator)
// ---------------------------------------------------------------------------------------------

/** The fixture passkey's private key as PKCS#8 (DER, base64), for a virtual authenticator. */
export const PASSKEY_PKCS8 = toBase64(
  new Uint8Array([
    ...Buffer.from("3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"),
    ...fx.PASSKEY_SECRET,
  ]),
);

export type VirtualAuthenticator = { cdp: CDPSession; authenticatorId: string };

/**
 * Adds a platform authenticator that verifies the user, so WebAuthn create and get work in the
 * test browser. With `withFixturePasskey` it already holds the fixture passkey for localhost, so
 * the seeded passkey account can sign.
 */
export async function addVirtualAuthenticator(page: Page, opts: { withFixturePasskey?: boolean } = {}): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  if (opts.withFixturePasskey) {
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: toBase64(fromBase64(fx.PASSKEY.credentialId)),
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: PASSKEY_PKCS8,
        userHandle: toBase64(sha256("parry-e2e:user").subarray(0, 16)),
        signCount: 0,
      },
    });
  }
  return { cdp, authenticatorId };
}

/** The owner actions in each relayed passkey request, in order. */
export function relayedActions(api: MockHandle): OwnerAction[][] {
  return api.calls("POST", "/v1/relay/owner").map((r) => (JSON.parse((r.body as { request: string }).request) as { actions: OwnerAction[] }).actions);
}

/** The fixture account, owned by the fixture passkey in Chromium's virtual authenticator. */
export async function asPasskeyOwner(page: Page): Promise<MockHandle> {
  const api = await mockApi(page, { ownerKind: "passkey" });
  await seedAccount(page, "passkey");
  await addVirtualAuthenticator(page, { withFixturePasskey: true });
  return api;
}
