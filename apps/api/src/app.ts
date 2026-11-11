/** The API routes (docs/api.md). Reads come from Postgres (services' output) and the chain. */

import { DEFAULT_THRESHOLDS, plan as planSteps, reserveProof, STRATEGIES, type ReserveLeaf } from "@parry/core";
import { contract, dexPool, enclaveInfo, explorers, network, NEAR_USD } from "@parry/services/lib/config";
import type { Sql } from "@parry/services/lib/db";
import { errorText } from "@parry/services/lib/log";
import { nearHistory } from "@parry/services/lib/history";
import { balanceOf, gasKeyNonces, rpc, toNear, view } from "@parry/services/lib/near";
import { oraclePrices, readRhea } from "@parry/services/lib/positions";
import { quoteRescue } from "@parry/services/lib/routes";
import { scoreAll } from "@parry/services/risk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { challenge, session, verify, type Proof } from "./auth";
import { cached, decision, position, vaultState, type DecisionRow, type PositionRow } from "./views";
import { copilot, fx } from "./extras";
import { paidRisk } from "./x402";

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:4500";

export function createApp(sql: Sql, opts: { mcp?: (req: Request) => Promise<Response> } = {}) {
  const app = new Hono();
  app.use("*", cors({ origin: (o) => o ?? "*", allowHeaders: ["content-type", "authorization", "x-payment"], exposeHeaders: ["x-payment-response"] }));
  // A request error (a malformed account id, say) carries its 4xx status; anything else is a 500.
  app.onError((e, c) => {
    const status = (e as { status?: number }).status;
    return c.json({ error: errorText(e) }, status !== undefined && status >= 400 && status < 500 ? (status as 400) : 500);
  });

  const account = (id: string) => {
    if (!ACCOUNT.test(id)) throw Object.assign(new Error("not a NEAR account id"), { status: 400 });
    return id;
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
    const v = await vaultState(sql).catch(() => null);
    return c.json({ network, positionsProtected: Number(p?.n ?? 0), rescues: Number(r?.n ?? 0), vaultTvlUsd: v?.navUsd ?? 0, vaultRiskScore: v?.riskScore ?? null, updatedAt: new Date().toISOString() });
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
    return c.json({ near: { priceUsd: m.payload.price, hlMid: hl?.price ?? null, updatedAt: m.created_at.toISOString() }, tremor: m.payload.tremor, cascade: m.payload.cascade });
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
    const hours = Math.min(168, Math.max(1, Number(c.req.query("hours") ?? 24)));
    const rows = await sql<{ t: Date; health: number | null; score: number; price: number }[]>`
      SELECT t, health, score, price FROM position_history WHERE position_id = ${c.req.param("id")} AND t > now() - make_interval(hours => ${hours}) ORDER BY t`;
    return c.json(rows.map((r) => ({ t: r.t.toISOString(), health: r.health, score: r.score, price: r.price })));
  });

  /** Any NEAR account's lending risk, read live (the free, rate-limited version). */
  async function riskCheck(id: string) {
    const { near } = await oraclePrices();
    if (near === null) throw new Error("no fresh NEAR price");
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
    const ip = c.req.header("x-forwarded-for")?.split(",")[0] ?? "local";
    const { useQuota } = await import("@parry/services/lib/db");
    if (!(await useQuota(sql, "risk-check", ip, Number(process.env.FREE_RISK_CHECKS_PER_DAY ?? 200)))) return c.json({ error: "daily free checks used; use /v1/paid/risk over x402" }, 429);
    return c.json(await riskCheck(account(c.req.param("id"))));
  });

  app.get("/v1/paid/risk/:id", async (c) => paidRisk(c, sql, () => riskCheck(account(c.req.param("id")))));

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
    const target = Number(c.req.query("target") ?? 1.45);
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
    const limit = Math.min(100, Number(c.req.query("limit") ?? 25));
    const acct = c.req.query("account");
    const cursor = c.req.query("cursor");
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
      const status = action === "ack" ? "acknowledged" : "resolved";
      const [a] = await sql`UPDATE alerts SET status = ${status}, updated_at = now() WHERE id = ${c.req.param("id")} AND account = ${who} RETURNING id, status`;
      return a ? c.json({ id: String(a.id), status: a.status }) : c.json({ error: "no such alert for this account" }, 404);
    });
  }

  app.post("/v1/auth/challenge", async (c) => {
    const { accountId } = await c.req.json<{ accountId: string }>();
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
    const b = await c.req.json<{ thresholds?: typeof DEFAULT_THRESHOLDS; displayCurrency?: string; email?: string | null; digest?: string; linkTelegram?: boolean }>();
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
    const sub = await c.req.json<{ endpoint: string; keys: { p256dh: string; auth: string } }>();
    await sql`INSERT INTO push_subscriptions (endpoint, account, keys) VALUES (${sub.endpoint}, ${who}, ${sql.json(sub.keys)}) ON CONFLICT (endpoint) DO UPDATE SET account = excluded.account, keys = excluded.keys`;
    return c.json({ ok: true });
  });

  app.get("/v1/vault", async (c) => c.json(await vaultState(sql)));

  app.get("/v1/vault/history", async (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 7)));
    const rows = await sql<{ t: Date; share_price: number; nav: number; score: number; hedged: number }[]>`SELECT * FROM vault_history WHERE t > now() - make_interval(days => ${days}) ORDER BY t`;
    return c.json(rows.map((r) => ({ t: r.t.toISOString(), sharePriceUsd: r.share_price, navUsd: r.nav, riskScore: r.score, hedgedFraction: r.hedged })));
  });

  app.get("/v1/vault/reserves", async (c) => {
    const [r] = await sql<{ payload: { reserves: { root: string; ratio_bps: number }; at: number }; extra: { leaves: ReserveLeaf[] } }[]>`
      SELECT payload, extra FROM reports WHERE kind = 'vault_report' ORDER BY run_id DESC LIMIT 1`;
    if (!r) return c.json({ error: "no vault report yet" }, 404);
    const leaves = r.extra.leaves;
    return c.json({ root: r.payload.reserves.root, ratioBps: r.payload.reserves.ratio_bps, reportAt: new Date(r.payload.at * 1000).toISOString(), leaves: leaves.map((l) => ({ ...l, proof: reserveProof(leaves, l) })) });
  });

  app.get("/v1/rates", async (c) => {
    const rates = await cached("rates", 120_000, async () => {
      const out: { asset: string; supplyApr: number; borrowApr: number; source: string }[] = [];
      for (const [asset, token] of [["wNEAR", contract("wnear")], ["USDC", contract("usdc")]] as const) {
        const a = await view<{ supply_apr: string; borrow_apr: string } | null>(contract("lending"), "get_asset", { token_id: token }).catch(() => null);
        if (a) out.push({ asset, supplyApr: Number(a.supply_apr), borrowApr: Number(a.borrow_apr), source: "Rhea lending" });
      }
      return out;
    });
    const v = await vaultState(sql).catch(() => null);
    return c.json([...rates, ...(v ? [{ asset: "Parry Earn (EARN)", supplyApr: v.yield.stakingApr ?? 0, borrowApr: 0, source: "Parry vault (staking yield; funding shown separately)" }] : [])]);
  });

  app.get("/v1/fx", async (c) => c.json(await fx()));
  app.post("/v1/copilot", async (c) => {
    const body = await c.req.json<{ account: string; positionId?: string; question?: string }>();
    try {
      return c.json(await copilot(sql, { ...body, account: account(body.account) }));
    } catch (e) {
      return c.json({ error: errorText(e) }, ((e as { status?: number }).status ?? 500) as 500);
    }
  });

  app.get("/v1/quotes/rescue", async (c) => c.json(await quoteRescue(Math.max(0.1, Number(c.req.query("amountNear") ?? 10)))));

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
    return c.json({
      network,
      services: services.map((s) => ({ name: s.name, ok: s.ok && Date.now() - s.checked_at.getTime() < 300_000, detail: s.detail, checkedAt: s.checked_at.toISOString() })),
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

  if (opts.mcp) app.all("/mcp", (c) => opts.mcp!(c.req.raw));

  // Score positions on demand in tests and single-process local runs.
  app.post("/v1/internal/score", async (c) => {
    if (process.env.PARRY_INTERNAL !== "1") return c.json({ error: "not found" }, 404);
    return c.json({ scored: await scoreAll(sql) });
  });

  return app;
}
