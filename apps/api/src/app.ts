/** The API routes (docs/api.md). Reads come from Postgres (services' output) and the chain. */

import { DEFAULT_THRESHOLDS, plan as planSteps, reserveProof, STRATEGIES, tremorRegime, type ReserveLeaf } from "@parry/core";
import { contract, dexPool, enclaveInfo, explorers, network, NEAR_USD } from "@parry/services/lib/config";
import type { Sql } from "@parry/services/lib/db";
import { errorText } from "@parry/services/lib/log";
import { nearHistory } from "@parry/services/lib/history";
import { balanceOf, gasKeyNonces, rpc, toNear, view } from "@parry/services/lib/near";
import { oraclePrices, readRhea } from "@parry/services/lib/positions";
import { quoteRescue } from "@parry/services/lib/routes";
import { scoreAll } from "@parry/services/risk";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { challenge, session, verify, type Proof } from "./auth";
import { cached, decision, position, vaultState, type DecisionRow, type PositionRow } from "./views";
import { copilot, CURRENCIES, fx } from "./extras";
import { paidRisk } from "./x402";
import { insuranceOf, registerRoutes } from "./routes";

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;

/**
 * The client address per-address limits key on: the right-most X-Forwarded-For entry, which the
 * reverse proxy in front of the API appends (entries before it come from the client).
 */
export const clientIp = (forwarded: string | undefined): string =>
  forwarded?.split(",").map((x) => x.trim()).filter(Boolean).pop() ?? "local";
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:4500";

export function createApp(sql: Sql, opts: { mcp?: (req: Request) => Promise<Response> } = {}) {
  const app = new Hono();
  app.use("*", cors({ origin: (o) => o ?? "*", allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"], allowHeaders: ["content-type", "authorization", "x-payment"], exposeHeaders: ["x-payment-response"] }));
  // A request error carries its status (4xx, or 503 while a dependency has no data); anything else is a 500.
  app.onError((e, c) => {
    const status = (e as { status?: number }).status;
    return c.json({ error: errorText(e) }, status !== undefined && ((status >= 400 && status < 500) || status === 503) ? (status as 400) : 500);
  });

  const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });
  const account = (id: unknown) => {
    if (typeof id !== "string" || !ACCOUNT.test(id)) throw bad("not a NEAR account id");
    return id;
  };
  /** A numeric query parameter, clamped to [min, max]; one that is not a number is a 400. */
  const numQuery = (c: Context, name: string, fallback: number, min: number, max: number) => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
    return Math.min(max, Math.max(min, n));
  };
  /** The request's JSON body; one that is not JSON is a 400. */
  const body = async <T>(c: Context): Promise<T> => {
    try {
      return await c.req.json<T>();
    } catch {
      throw bad("the request body must be JSON");
    }
  };

  app.get("/", (c) => c.json({ name: "Parry API", network, docs: "docs/api.md" }));
  app.get("/live", (c) => c.json({ ok: true }));
  app.get("/health", async (c) => {
    await sql`SELECT 1`;
    return c.json({ ok: true, network });
  });

  app.get("/v1/stats", async (c) => {
    const [p] = await sql<{ n: string }[]>`SELECT count(DISTINCT p.account)::text AS n FROM positions p JOIN accounts a USING (account)
      WHERE EXISTS (SELECT 1 FROM events e WHERE e.contract = p.account AND e.event = 'mandate_set')`;
    const [r] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM decisions WHERE outcome = 'executed'`;
    // Value protected: every position of an account whose Rhea position the monitor read under a live mandate.
    const [w] = await sql<{ protected_usd: number | null; watched: number }[]>`SELECT
      (SELECT sum(collateral_usd) FROM positions WHERE account IN (SELECT account FROM positions WHERE raw->>'protected' = 'true')) AS protected_usd,
      (SELECT count(*)::int FROM positions) AS watched`;
    const v = await vaultState(sql).catch(() => null);
    const ins = await insuranceOf();
    return c.json({
      network,
      positionsProtected: Number(p?.n ?? 0),
      rescues: Number(r?.n ?? 0),
      vaultTvlUsd: v?.navUsd ?? 0,
      vaultRiskScore: v?.riskScore ?? null,
      valueProtectedUsd: w?.protected_usd ?? 0,
      positionsWatched: w?.watched ?? 0,
      insuranceUsd: ins ? Number(ins.value_usd_e6) / 1e6 : 0,
      updatedAt: new Date().toISOString(),
    });
  });

  app.get("/v1/config", async (c) => {
    const enclave = await cached("enclave", 60_000, async () => {
      const e = await view<{ public_key: string; wasm_sha256: string }>(contract("risk"), "get_enclave").catch(() => null);
      const s = await view<{ public_key: string } | null>(contract("risk"), "sealing_key").catch(() => null);
      return { publicKey: e?.public_key ?? enclaveInfo()?.publicKey ?? "", sealingPublicKey: s?.public_key ?? enclaveInfo()?.sealingPublicKey ?? null, wasmSha256: e?.wasm_sha256 ?? enclaveInfo()?.wasmSha256 ?? "" };
    });
    const names = ["factory", "vault", "risk", "oracle", "lending", "dex", "signer", "usdc", "wnear", "linear"];
    return c.json({
      network,
      contracts: Object.fromEntries(names.map((n) => [n, contract(n) || null])),
      dexPool: dexPool() >= 0 ? dexPool() : null,
      enclave,
      reviewModel: process.env.PARRY_REVIEW_MODEL ?? "z-ai/glm-5.3-flash",
      explorers,
    });
  });

  app.get("/v1/market", async (c) => {
    const [m] = await sql<{ payload: { tremor: Record<string, unknown>; cascade: Record<string, number>; price: number }; created_at: Date }[]>`
      SELECT payload, created_at FROM reports WHERE kind = 'market' ORDER BY run_id DESC LIMIT 1`;
    const [hl] = await sql<{ price: number }[]>`SELECT price FROM prices WHERE asset = 'NEAR' AND source = 'hyperliquid' ORDER BY t DESC LIMIT 1`;
    if (!m) return c.json({ error: "no market data yet" }, 503);
    // Reports written before the regime and the heatmap source carry neither: derive the regime, say the source.
    const tremor = { ...m.payload.tremor, regime: m.payload.tremor.regime ?? tremorRegime(Number(m.payload.tremor.annual ?? 0)) };
    const cascade = { source: "positions", ...m.payload.cascade };
    return c.json({ near: { priceUsd: m.payload.price, hlMid: hl?.price ?? null, updatedAt: m.created_at.toISOString() }, tremor, cascade });
  });

  app.get("/v1/accounts/:id", async (c) => {
    const id = account(c.req.param("id"));
    const [a] = await sql<{ owner_kind: string; owner_id: string; hl_address: string | null; evm_address: string | null }[]>`SELECT * FROM accounts WHERE account = ${id}`;
    if (!a) return c.json({ error: "not a Parry protected account" }, 404);
    const [mandate, stats] = await Promise.all([view<unknown>(id, "mandate").catch(() => null), view<{ guardian_actions: number; deleverages: number }>(id, "stats").catch(() => null)]);
    const rows = await sql<PositionRow[]>`SELECT * FROM positions WHERE account = ${id} ORDER BY score DESC`;
    return c.json({
      account: id,
      owner: { kind: a.owner_kind, id: a.owner_id },
      mandate,
      positions: rows.map(position),
      hyperliquidAddress: a.hl_address,
      evmAddress: a.evm_address,
      stats: { guardianActions: stats?.guardian_actions ?? 0, deleverages: stats?.deleverages ?? 0 },
    });
  });

  app.get("/v1/accounts/by-owner/:owner", async (c) => {
    const rows = await sql<{ account: string }[]>`SELECT account FROM accounts WHERE owner_id = ${c.req.param("owner")} ORDER BY created_at`;
    return c.json(rows.map((r) => r.account));
  });

  app.get("/v1/accounts/:id/positions", async (c) => {
    const rows = await sql<PositionRow[]>`SELECT * FROM positions WHERE account = ${account(c.req.param("id"))} ORDER BY score DESC`;
    return c.json(rows.map(position));
  });

  app.get("/v1/accounts/:id/portfolio", async (c) => {
    const id = account(c.req.param("id"));
    const rows = await sql<PositionRow[]>`SELECT * FROM positions WHERE account = ${id}`;
    const collateral = rows.reduce((s, r) => s + r.collateral_usd, 0);
    const debt = rows.reduce((s, r) => s + r.debt_usd, 0);
    const shares = await view<string>(contract("vault"), "ft_balance_of", { account_id: id }).catch(() => "0");
    const v = await vaultState(sql).catch(() => null);
    const vaultUsd = v ? (Number(BigInt(shares) / 10n ** 12n) / 1e12) * v.sharePriceUsd : 0;
    // PnL over 24h from the stored history: equity now against equity a day ago at the old price.
    const [old] = await sql<{ price: number }[]>`SELECT price FROM prices WHERE asset = 'NEAR' AND source = 'oracle' AND t < now() - interval '24 hours' ORDER BY t DESC LIMIT 1`;
    const { near } = await oraclePrices().catch(() => ({ near: null }));
    const nearCollateral = rows.filter((r) => r.venue === "rhea").reduce((s, r) => s + r.collateral_usd, 0) / (near ?? 1);
    const pnl24h = old && near ? nearCollateral * (near - old.price) : null;
    return c.json({ account: id, collateralUsd: collateral, debtUsd: debt, equityUsd: collateral - debt + vaultUsd, vault: { shares, valueUsd: vaultUsd }, pnl24hUsd: pnl24h, positions: rows.map(position) });
  });

  app.get("/v1/positions/:id/history", async (c) => {
    const hours = numQuery(c, "hours", 24, 1, 168);
    const rows = await sql<{ t: Date; health: number | null; score: number; price: number }[]>`
      SELECT t, health, score, price FROM position_history WHERE position_id = ${c.req.param("id")} AND t > now() - make_interval(hours => ${hours}) ORDER BY t`;
    return c.json(rows.map((r) => ({ t: r.t.toISOString(), health: r.health, score: r.score, price: r.price })));
  });

  /** Any NEAR account's lending risk, read live (the free, rate-limited version). */
  async function riskCheck(id: string) {
    const { near } = await oraclePrices();
    if (near === null) throw bad("no fresh NEAR price", 503);
    const r = await readRhea(id, near);
    // The same inputs the risk engine scores with: market volatility and the latest cascade pressure.
    const { history } = await nearHistory(sql);
    const [m] = await sql<{ payload: { cascade?: { pressure?: number } } }[]>`SELECT payload FROM reports WHERE kind = 'market' ORDER BY run_id DESC LIMIT 1`;
    const { assess } = await import("@parry/core");
    const a = r ? assess(r.position, near, history, Date.now() / 1000, m?.payload.cascade?.pressure ?? 0) : null;
    return {
      account: id,
      checkedAt: new Date().toISOString(),
      position: r && a
        ? { id: `${id}:rhea:main`, account: id, venue: "rhea", label: "Rhea wNEAR/USDC", collateralUsd: r.collateralUsd, debtUsd: r.debtUsd, health: Number.isFinite(a.health) ? a.health : null, liqPrice: a.liqPrice,
            distance: a.distance, score: a.score.score, tier: a.score.tier, probability24h: a.probability24h, ttlHours: a.ttl.medianHours, valueAtRisk99: a.valueAtRisk99, updatedAt: new Date().toISOString() }
        : null,
      market: m?.payload ?? null,
      model: "docs/risk-model.md",
    };
  }

  app.get("/v1/risk/:id", async (c) => {
    const ip = clientIp(c.req.header("x-forwarded-for"));
    const { useQuota } = await import("@parry/services/lib/db");
    if (!(await useQuota(sql, "risk-check", ip, Number(process.env.FREE_RISK_CHECKS_PER_DAY ?? 200)))) return c.json({ error: "daily free checks used; use /v1/paid/risk over x402" }, 429);
    return c.json(await riskCheck(account(c.req.param("id"))));
  });

  // Everything that can refuse the request is checked before the payment is taken.
  app.get("/v1/paid/risk/:id", async (c) => {
    const id = account(c.req.param("id"));
    if ((await oraclePrices()).near === null) throw bad("no fresh NEAR price", 503);
    return paidRisk(c, sql, () => riskCheck(id));
  });

  app.post("/v1/simulate/:id", async (c) => {
    const id = account(c.req.param("id"));
    const { near } = await oraclePrices();
    if (near === null) return c.json({ error: "no fresh NEAR price" }, 503);
    const r = await readRhea(id, near);
    const m = await view<{ mandate: { limits: { token: string; reserve: string; daily: string }[]; max_slippage_bps: number } } | null>(id, "mandate").catch(() => null);
    if (!r) return c.json({ account: id, triggered: false, reason: "no lending position", steps: [], routes: null });
    const usdc = await view<string>(contract("usdc"), "ft_balance_of", { account_id: id }).catch(() => "0");
    const limit = (token: string) => m?.mandate.limits.find((l) => l.token === token);
    const lu = limit(contract("usdc"));
    const lw = limit(contract("wnear"));
    const strategy = STRATEGIES.find((s) => s.id === (c.req.query("strategy") ?? "repay-first")) ?? STRATEGIES[0]!;
    const target = numQuery(c, "target", 1.45, 1.01, 10);
    const pos = { collateral: r.collateralNear, debt: r.debtUsd, price: near, collateralRatio: r.position.collateral[0]!.volatilityRatio, debtRatio: r.position.debt[0]!.volatilityRatio };
    const p = planSteps(strategy, pos, target, {
      repayBudget: Math.min(Number(usdc) / 1e6, lu ? Number(lu.daily) / 1e6 : 0),
      collateralBudget: 0,
      deleverageBudget: lw ? Number(BigInt(lw.daily) / 10n ** 20n) / 1e4 : 0,
      maxSlippage: (m?.mandate.max_slippage_bps ?? 200) / 10_000,
      withdrawFloor: 1.01,
      maxSteps: 6,
    });
    const delev = p.steps.find((s) => s.kind === "deleverage");
    return c.json({
      account: id,
      triggered: p.steps.length > 0,
      reason: p.steps.length ? `health ${pos.collateral ? (pos.collateral * near * pos.collateralRatio * pos.debtRatio / pos.debt).toFixed(3) : "n/a"} is below the ${target} target` : "already at the target",
      mandate: !!m,
      steps: p.steps.map((s) => ({ ...s, amount: String(s.amount), minOut: s.minOut !== undefined ? String(s.minOut) : undefined })),
      reached: p.reached,
      routes: delev ? await quoteRescue(delev.amount) : null,
    });
  });

  app.get("/v1/guardian/decisions", async (c) => {
    const limit = Math.floor(numQuery(c, "limit", 25, 1, 100));
    const acct = c.req.query("account");
    const cursor = c.req.query("cursor");
    if (cursor && Number.isNaN(Date.parse(cursor))) throw bad("cursor must be a time (a page's `next`)");
    const rows = await sql<DecisionRow[]>`SELECT * FROM decisions WHERE (${acct ?? null}::text IS NULL OR account = ${acct ?? null})
      AND (${cursor ?? null}::timestamptz IS NULL OR created_at < ${cursor ?? null}::timestamptz) ORDER BY created_at DESC LIMIT ${limit}`;
    return c.json({ items: rows.map(decision), next: rows.length === limit ? rows[rows.length - 1]!.created_at.toISOString() : null });
  });

  app.get("/v1/guardian/decisions/:id", async (c) => {
    const [r] = await sql<DecisionRow[]>`SELECT * FROM decisions WHERE id = ${c.req.param("id")}`;
    return r ? c.json(decision(r)) : c.json({ error: "no such decision" }, 404);
  });

  app.get("/v1/guardian/decisions/:id/verify", async (c) => {
    const [r] = await sql<DecisionRow[]>`SELECT * FROM decisions WHERE id = ${c.req.param("id")}`;
    if (!r) return c.json({ error: "no such decision" }, 404);
    const { verifyDecisionRecord } = await import("./verify");
    return c.json(await verifyDecisionRecord(r));
  });

  app.get("/v1/alerts", async (c) => {
    const acct = c.req.query("account");
    if (!acct) return c.json({ error: "account is required" }, 400);
    const status = c.req.query("status");
    const rows = await sql<{ id: string; account: string; kind: string; severity: string; title: string; body: string; status: string; created_at: Date; updated_at: Date }[]>`
      SELECT * FROM alerts WHERE account = ${acct} AND (${status ?? null}::text IS NULL OR status = ${status ?? null}) ORDER BY id DESC LIMIT 100`;
    return c.json(rows.map((a) => ({ id: String(a.id), account: a.account, kind: a.kind, severity: a.severity, title: a.title, body: a.body, status: a.status, createdAt: a.created_at.toISOString(), updatedAt: a.updated_at.toISOString() })));
  });

  for (const action of ["ack", "resolve"] as const) {
    app.post(`/v1/alerts/:id/${action}`, async (c) => {
      const who = await session(sql, c.req.header("authorization"));
      if (!who) return c.json({ error: "sign in first" }, 401);
      if (!/^\d+$/.test(c.req.param("id"))) throw bad("an alert id is a number");
      const status = action === "ack" ? "acknowledged" : "resolved";
      const [a] = await sql`UPDATE alerts SET status = ${status}, updated_at = now() WHERE id = ${c.req.param("id")} AND account = ${who} RETURNING id, status`;
      return a ? c.json({ id: String(a.id), status: a.status }) : c.json({ error: "no such alert for this account" }, 404);
    });
  }

  app.post("/v1/auth/challenge", async (c) => {
    const { accountId } = await body<{ accountId?: string }>(c);
    return c.json(await challenge(sql, account(accountId)));
  });
  app.post("/v1/auth/verify", async (c) => {
    try {
      return c.json({ token: await verify(sql, await c.req.json<Proof>()) });
    } catch (e) {
      return c.json({ error: errorText(e) }, 401);
    }
  });

  app.get("/v1/settings/:id", async (c) => {
    const id = account(c.req.param("id"));
    const [s] = await sql<{ thresholds: typeof DEFAULT_THRESHOLDS; display_currency: string; telegram_chat_id: string | null; telegram_code: string | null; email: string | null; digest: string }[]>`SELECT * FROM settings WHERE account = ${id}`;
    const [push] = await sql`SELECT 1 FROM push_subscriptions WHERE account = ${id} LIMIT 1`;
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    return c.json({
      account: id,
      thresholds: s?.thresholds ?? DEFAULT_THRESHOLDS,
      displayCurrency: s?.display_currency ?? "USD",
      telegram: { linked: !!s?.telegram_chat_id, deepLink: bot && s?.telegram_code ? `https://t.me/${bot}?start=${s.telegram_code}` : null, available: !!bot },
      email: { address: s?.email ?? null, digest: s?.digest ?? "off" },
      push: !!push,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    });
  });

  app.put("/v1/settings/:id", async (c) => {
    const id = account(c.req.param("id"));
    if ((await session(sql, c.req.header("authorization"))) !== id) return c.json({ error: "sign in as this account first" }, 401);
    const b = await body<{ thresholds?: typeof DEFAULT_THRESHOLDS; displayCurrency?: string; email?: string | null; digest?: string; linkTelegram?: boolean }>(c);
    if (b.displayCurrency !== undefined && !(CURRENCIES as readonly string[]).includes(b.displayCurrency)) throw bad(`displayCurrency is one of ${CURRENCIES.join(", ")}`);
    if (b.digest !== undefined && b.digest !== "off" && b.digest !== "daily") throw bad("digest is off or daily");
    if (b.email !== undefined && b.email !== null && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(b.email)) throw bad("email is not an address");
    if (b.thresholds !== undefined) {
      const t = b.thresholds;
      const ok = !!t && typeof t === "object" && Number.isFinite(t.score) && t.score >= 0 && t.score <= 100 && Number.isFinite(t.health) && t.health > 1 && t.health <= 5 && Number.isFinite(t.cascade) && t.cascade >= 0 && t.cascade <= 1;
      if (!ok) throw bad("thresholds are { score 0 to 100, health above 1 up to 5, cascade 0 to 1 }");
    }
    const code = b.linkTelegram ? crypto.randomUUID().replace(/-/g, "").slice(0, 16) : null;
    await sql`INSERT INTO settings (account) VALUES (${id}) ON CONFLICT DO NOTHING`;
    await sql`UPDATE settings SET
      thresholds = COALESCE(${b.thresholds ? sql.json(b.thresholds as never) : null}, thresholds),
      display_currency = COALESCE(${b.displayCurrency ?? null}, display_currency),
      email = CASE WHEN ${b.email !== undefined} THEN ${b.email ?? null} ELSE email END,
      digest = COALESCE(${b.digest ?? null}, digest),
      telegram_code = COALESCE(${code}, telegram_code),
      updated_at = now() WHERE account = ${id}`;
    return c.json({ ok: true });
  });

  app.post("/v1/push/subscribe", async (c) => {
    const who = await session(sql, c.req.header("authorization"));
    if (!who) return c.json({ error: "sign in first" }, 401);
    const sub = await body<{ endpoint?: string; keys?: { p256dh: string; auth: string } }>(c);
    if (typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys?.p256dh || !sub.keys.auth) throw bad("a Web Push subscription is { endpoint, keys: { p256dh, auth } }");
    await sql`INSERT INTO push_subscriptions (endpoint, account, keys) VALUES (${sub.endpoint}, ${who}, ${sql.json(sub.keys)}) ON CONFLICT (endpoint) DO UPDATE SET account = excluded.account, keys = excluded.keys`;
    return c.json({ ok: true });
  });

  app.get("/v1/vault", async (c) => c.json(await vaultState(sql)));

  app.get("/v1/vault/history", async (c) => {
    const days = numQuery(c, "days", 7, 1, 90);
    type Row = {
      t: Date; share_price: number; nav: number; score: number; hedged: number; staking_yield_usd: number | null; funding_yield_usd: number | null; hedge_ratio: number | null;
      insurance_usd: number | null; reserves_root: string | null; basis_apr: number | null; drawdown: number | null; margin_ratio: number | null;
    };
    const rows = await sql<Row[]>`SELECT * FROM vault_history WHERE t > now() - make_interval(days => ${days}) ORDER BY t`;
    return c.json(
      rows.map((r) => ({
        t: r.t.toISOString(),
        sharePriceUsd: r.share_price,
        navUsd: r.nav,
        riskScore: r.score,
        hedgedFraction: r.hedged,
        stakingYieldUsd: r.staking_yield_usd,
        fundingYieldUsd: r.funding_yield_usd,
        hedgeRatio: r.hedge_ratio,
        insuranceUsd: r.insurance_usd,
        reservesRoot: r.reserves_root,
        basisApr: r.basis_apr,
        drawdown: r.drawdown,
        marginRatio: r.margin_ratio,
      })),
    );
  });

  app.get("/v1/vault/reserves", async (c) => {
    const [r] = await sql<{ payload: { reserves: { root: string; ratio_bps: number }; at: number }; extra: { leaves: ReserveLeaf[] } }[]>`
      SELECT payload, extra FROM reports WHERE kind = 'vault_report' ORDER BY run_id DESC LIMIT 1`;
    if (!r) return c.json({ error: "no vault report yet" }, 404);
    const leaves = r.extra.leaves;
    return c.json({ root: r.payload.reserves.root, ratioBps: r.payload.reserves.ratio_bps, reportAt: new Date(r.payload.at * 1000).toISOString(), leaves: leaves.map((l) => ({ ...l, proof: reserveProof(leaves, l) })) });
  });

  app.get("/v1/fx", async (c) => c.json(await fx()));
  app.post("/v1/copilot", async (c) => {
    const q = await body<{ account?: string; positionId?: string; question?: string }>(c);
    const id = account(q.account);
    try {
      return c.json(await copilot(sql, { ...q, account: id }));
    } catch (e) {
      return c.json({ error: errorText(e) }, ((e as { status?: number }).status ?? 500) as 500);
    }
  });

  app.get("/v1/quotes/rescue", async (c) => c.json(await quoteRescue(numQuery(c, "amountNear", 10, 0.1, 1_000_000))));

  /** Whether an account holds a post-quantum ML-DSA-65 key (the chain lists its on-trie handle). */
  const postQuantum = async (account: string): Promise<boolean> => {
    const r = await rpc<{ keys: { public_key: string }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: account }).catch(() => null);
    return !!r?.keys.some((k) => k.public_key.startsWith("ml-dsa-65"));
  };

  app.get("/v1/status", async (c) => {
    const services = await sql<{ name: string; ok: boolean; detail: string; checked_at: Date }[]>`SELECT * FROM service_status ORDER BY name`;
    const oracle = await view<{ feeds: { price_id: string; publish_time: number }[] }>(contract("oracle"), "status").catch(() => null);
    const near = oracle?.feeds.find((f) => f.price_id === NEAR_USD);
    const [cursor] = await sql<{ b: string | null }[]>`SELECT max(last_block)::text AS b FROM indexer_cursors`;
    const head = await rpc<{ header: { height: number } }>("block", { finality: "final" }).catch(() => null);
    const wallets = await sql<{ name: string; account: string; balance: number; target: number }[]>`SELECT * FROM wallets ORDER BY name`;
    const lanes = await Promise.all(
      ["MONITOR", "KEEPER", "RELAYER"].map(async (p) => {
        const acct = process.env[`${p}_ACCOUNT_ID`];
        const key = process.env[`${p}_PUBLIC_KEY`];
        const n = acct && key ? await gasKeyNonces(acct, key) : null;
        return { service: p.toLowerCase(), account: acct ?? null, key: key ?? null, nonces: n ?? 0 };
      }),
    );
    const treasury = wallets.find((w) => w.name === "treasury");
    // The last 48 hours, hour by hour: the share of each service's reports that were ok.
    const hours = await sql<{ name: string; hour: Date; checks: number; ok: number }[]>`
      SELECT name, hour, checks, ok FROM service_uptime WHERE hour > now() - interval '48 hours' ORDER BY name, hour`;
    const uptime = services.map((s) => {
      const mine = hours.filter((h) => h.name === s.name);
      const checks = mine.reduce((n, h) => n + h.checks, 0);
      return {
        name: s.name,
        ratio: checks ? mine.reduce((n, h) => n + h.ok, 0) / checks : null,
        hours: mine.map((h) => ({ hour: h.hour.toISOString(), checks: h.checks, ok: h.ok })),
      };
    });
    return c.json({
      network,
      services: services.map((s) => ({ name: s.name, ok: s.ok && Date.now() - s.checked_at.getTime() < 300_000, detail: s.detail, checkedAt: s.checked_at.toISOString() })),
      uptime,
      oracle: near ? { publishTime: new Date(near.publish_time * 1000).toISOString(), ageSeconds: Math.round(Date.now() / 1000 - near.publish_time), fresh: Date.now() / 1000 - near.publish_time < 120 } : null,
      indexer: { lastBlock: Number(cursor?.b ?? 0), lagBlocks: head ? head.header.height - Number(cursor?.b ?? 0) : null },
      lanes,
      treasury: treasury
        ? {
            account: treasury.account,
            balanceNear: treasury.balance,
            low: treasury.balance < treasury.target,
            postQuantumKey: await postQuantum(treasury.account),
            wallets: wallets.filter((w) => w.name !== "treasury").map((w) => ({ name: w.name, account: w.account, balanceNear: w.balance, target: w.target })),
          }
        : null,
    });
  });

  // Relayed writes go to the relayer service, which holds the wallet and the budgets.
  for (const [path, target] of [["/v1/relay/create-account", "/create-account"], ["/v1/relay/owner", "/owner"], ["/v1/relay/delegate", "/delegate"], ["/v1/shock", "/shock"]] as const) {
    app.post(path, async (c) => {
      const res = await fetch(`${RELAYER}${target}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": c.req.header("x-forwarded-for") ?? "" }, body: await c.req.text() });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
    });
  }

  /** Testnet helpers for the market shock page: the oracle's current shock and fed price. */
  app.get("/v1/shock", async (c) => {
    if (network !== "testnet") return c.json({ error: "testnet only" }, 404);
    const [shock, price] = await Promise.all([view(contract("oracle"), "shock_of", { price_id: NEAR_USD }).catch(() => null), view(contract("oracle"), "get_price_unsafe", { price_identifier: NEAR_USD }).catch(() => null)]);
    return c.json({ shock, price });
  });

  app.get("/v1/treasury", async (c) => {
    const t = process.env.TREASURY_ACCOUNT_ID;
    return c.json({ account: t ?? null, balanceNear: t ? toNear((await balanceOf(t)) ?? 0n) : null, postQuantumKey: t ? await postQuantum(t) : false });
  });

  const signedIn = async (c: Context) => {
    const who = await session(sql, c.req.header("authorization"));
    if (!who) throw bad("sign in first", 401);
    return who;
  };
  registerRoutes(app, sql, { bad, account, numQuery, body, signedIn });

  if (opts.mcp) app.all("/mcp", (c) => opts.mcp!(c.req.raw));

  // Score positions on demand in tests and single-process local runs.
  app.post("/v1/internal/score", async (c) => {
    if (process.env.PARRY_INTERNAL !== "1") return c.json({ error: "not found" }, 404);
    return c.json({ scored: await scoreAll(sql) });
  });

  return app;
}
