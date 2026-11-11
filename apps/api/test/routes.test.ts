import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { encodeEip1559, repayAaveActions } from "@parry/sdk";
import { encodeUnsigned } from "@parry/services/lib/evm";
import { migrate } from "@parry/services/lib/db";
import { sseFrame, StreamHub } from "../src/stream";

describe("EVM encoding", () => {
  test("the SDK's owner repay encodes transactions exactly as the services do", () => {
    const [approve] = repayAaveActions({
      chainId: 84532,
      nonce: 3,
      pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      amount: 10_000_000n,
      onBehalfOf: "0x33aacfd7ed3dd010f659455155e820bfcddf1af1",
      maxFeePerGas: 1_500_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    const data = approve.unsignedTx.slice(approve.unsignedTx.indexOf("095ea7b3"), approve.unsignedTx.length - 2);
    expect(approve.unsignedTx).toBe(
      encodeUnsigned({ chainId: 84532, nonce: 3, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 1_500_000_000n, gasLimit: 80_000n, to: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", value: 0n, data: `0x${data}` }),
    );
    expect(encodeEip1559({ chainId: 1, nonce: 300, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21_000n, to: `0x${"22".repeat(20)}`, value: 10n ** 18n, data: new Uint8Array(60).fill(7) })).toBe(
      encodeUnsigned({ chainId: 1, nonce: 300, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21_000n, to: `0x${"22".repeat(20)}`, value: 10n ** 18n, data: `0x${"07".repeat(60)}` }),
    );
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("new routes on a database", () => {
  const sql = postgres(url ?? "postgres://invalid", { onnotice: () => {} });
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  const auth = { authorization: "Bearer t-watcher" };

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    const { createApp } = await import("../src/app");
    app = createApp(sql) as never;
    await sql`INSERT INTO auth_sessions (token, account, expires_at) VALUES ('t-watcher', '0uwatcher.testnet', now() + interval '1 hour')`;
    const raw = { position: { collateral: [], debt: [] }, protected: true };
    await sql`INSERT INTO positions (id, account, venue, label, raw, collateral_usd, debt_usd, health, score, tier, scored_at) VALUES
      ('bob.testnet:rhea:main', 'bob.testnet', 'rhea', 'Rhea wNEAR/USDC', ${sql.json({ ...raw, protected: false })}, 300, 250, 1.1, 62, 'danger', now()),
      ('0ua.testnet:rhea:main', '0ua.testnet', 'rhea', 'Rhea wNEAR/USDC', ${sql.json(raw)}, 500, 100, 3.5, 4, 'safe', now())`;
  });
  afterAll(() => sql.end());

  test("watched accounts need a sign-in, keep thresholds, and carry live risk and alerts", async () => {
    expect((await app.request("/v1/watch")).status).toBe(401);
    const bad = await app.request("/v1/watch/bob.testnet", { method: "PUT", headers: auth, body: JSON.stringify({ thresholds: { score: 50, health: 0.9 } }) });
    expect(bad.status).toBe(400);
    const put = await app.request("/v1/watch/bob.testnet", { method: "PUT", headers: auth, body: JSON.stringify({ thresholds: { score: 50, health: 1.2 }, label: "Bob" }) });
    expect(put.status).toBe(200);
    const row = (await put.json()) as { label: string; position: { score: number }; alert: { kind: string }[] };
    expect(row.label).toBe("Bob");
    expect(row.position.score).toBe(62);
    expect(row.alert.map((a) => a.kind).sort()).toEqual(["health", "risk"]);
    const list = (await (await app.request("/v1/watch", { headers: auth })).json()) as { account: string }[];
    expect(list.map((x) => x.account)).toEqual(["bob.testnet"]);
    expect((await app.request("/v1/watch/bob.testnet", { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await app.request("/v1/watch/bob.testnet", { method: "DELETE", headers: auth })).status).toBe(404);
  });

  test("certificates: sign-in, the account itself, and 503 until the enclave mode is deployed", async () => {
    const req = (account: string, headers: Record<string, string> = auth) =>
      app.request("/v1/certificates", { method: "POST", headers, body: JSON.stringify({ account, reader: "lender.testnet", threshold: 1.2, ttlSecs: 3600 }) });
    expect((await req("0uwatcher.testnet", {})).status).toBe(401);
    expect((await req("0ua.testnet")).status).toBe(401);
    const modes = process.env.ENCLAVE_MODES;
    const enclave = process.env.ENCLAVE_ACCOUNT_ID;
    try {
      process.env.ENCLAVE_MODES = "keys,risk_update,guardian,vault_report";
      const r = await req("0uwatcher.testnet");
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: string }).error).toContain("certificate mode");
      // Deployed, but this API cannot call the enclave: still a 503 that says why.
      process.env.ENCLAVE_MODES = "certificate";
      delete process.env.ENCLAVE_ACCOUNT_ID;
      const run = await req("0uwatcher.testnet");
      expect(run.status).toBe(503);
      expect(((await run.json()) as { error: string }).error).toContain("enclave run failed");
    } finally {
      if (modes === undefined) delete process.env.ENCLAVE_MODES;
      else process.env.ENCLAVE_MODES = modes;
      if (enclave !== undefined) process.env.ENCLAVE_ACCOUNT_ID = enclave;
    }
    expect(await (await app.request("/v1/certificates?account=0uwatcher.testnet")).json()).toEqual([]);
    expect((await app.request(`/v1/certificates/${"ab".repeat(32)}`)).status).toBe(404);
  });

  test("route savings come from the stored quotes", async () => {
    const routes = { amountNear: 10, rhea: { outUsd: 30, priceImpact: 0, poolId: 1 }, intents: { outUsd: 31, confidential: false, dry: true }, chosen: "intents", reason: "" };
    await sql`INSERT INTO decisions (id, account, venue, action, plan, trigger, outcome, review, routes) VALUES
      ('d-route', '0ua.testnet', 'rhea', 'deleverage', 'p', ${sql.json({ score: 70, tier: "danger", health_bps: 11000 })}, 'executed', ${sql.json({})}, ${sql.json(routes)})`;
    const s = (await (await app.request("/v1/routes/savings?account=0ua.testnet")).json()) as { totalSavedUsd: number; rescues: { decision: string; savedUsd: number }[] };
    expect(s.totalSavedUsd).toBeCloseTo(1, 9);
    expect(s.rescues[0]!.decision).toBe("d-route");
  });

  test("incidents group their alerts; stats count watched and protected value; the market says its regime and source", async () => {
    const [i] = await sql<{ id: string }[]>`INSERT INTO incidents (account, title, body, severity) VALUES ('0ua.testnet', 't', 'b', 'warning') RETURNING id`;
    await sql`INSERT INTO alerts (account, kind, severity, key, title, body, incident_id) VALUES ('0ua.testnet', 'risk', 'warning', 'k1', 'a', 'b', ${i!.id}), ('0ua.testnet', 'health', 'warning', 'k2', 'a', 'b', ${i!.id})`;
    const incidents = (await (await app.request("/v1/incidents?account=0ua.testnet")).json()) as { alerts: unknown[]; closedAt: null }[];
    expect(incidents[0]!.alerts).toHaveLength(2);
    expect((await app.request("/v1/incidents")).status).toBe(400);

    await sql`INSERT INTO reports (kind, run_id, payload) VALUES ('market', 1, ${sql.json({ price: 3, tremor: { sigmaHourly: 0.03, annual: 2.8, level: "extreme", windows: [] }, cascade: { pressure: 0.1, atRiskUsd: 5, correlatedOwners: 0 } })})`;
    const m = (await (await app.request("/v1/market")).json()) as { tremor: { regime: string }; cascade: { source: string } };
    expect(m.tremor.regime).toBe("panic");
    expect(m.cascade.source).toBe("positions");
  });

  test("vault history carries the new series", async () => {
    await sql`INSERT INTO vault_history (t, share_price, nav, score, hedged, basis_apr, drawdown, reserves_root) VALUES (now(), 1.01, 100, 10, 0.9, 0.12, 0.002, 'ab')`;
    const [p] = (await (await app.request("/v1/vault/history?days=1")).json()) as { basisApr: number; drawdown: number; reservesRoot: string; stakingYieldUsd: null }[];
    expect(p).toMatchObject({ basisApr: 0.12, drawdown: 0.002, reservesRoot: "ab", stakingYieldUsd: null });
  });

  test("verify and stream refuse what they cannot serve", async () => {
    expect((await app.request("/v1/verify/short")).status).toBe(400);
    expect((await app.request(`/v1/verify/${"ab".repeat(32)}`)).status).toBe(404);
    expect((await app.request("/v1/stream?events=gossip")).status).toBe(400);
    expect((await app.request("/v1/heatmap?network=elsewhere")).status).toBe(400);
  });

  test("the replay file is served as written", async () => {
    const r = await app.request("/v1/replay");
    if (r.status === 503) return; // no committed replay in this checkout
    const body = (await r.json()) as { source: string; crashes: { position: { healthWith: unknown[] } }[]; summary: { crashes: number } };
    expect(body.source).toContain("binance");
    expect(body.crashes.length).toBe(body.summary.crashes);
    expect(body.crashes[0]!.position.healthWith.length).toBeGreaterThan(24);
  });

  test("the stream hub reads each change once and fans it out to the clients that want it", async () => {
    let vaultReads = 0;
    const hub = new StreamHub(sql, { pollMs: 60_000, heartbeatMs: 60_000, vault: async () => ({ reportAt: String(++vaultReads) }) });
    const ctrl = new AbortController();
    const a = hub.connect({ events: ["alert", "vault"], account: "0ua.testnet", signal: ctrl.signal });
    const b = hub.connect({ events: ["alert"], account: "someone.testnet" });
    expect(hub.size).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES ('0ua.testnet', 'risk', 'warning', 'stream-1', 'Streamed', 'b')`;
    await sql`INSERT INTO vault_history (t, share_price, nav, score, hedged) VALUES (now() + interval '1 minute', 1, 1, 1, 1)`;
    const items = await hub.poll();
    expect(items.filter((i) => i.event === "alert")).toHaveLength(1);
    expect(vaultReads).toBe(1);
    expect(await hub.poll()).toEqual([]);
    const reader = a.body!.getReader();
    let text = "";
    while (!text.includes("event: vault")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(": connected");
    expect(text).toContain(sseFrame("alert", (items.find((i) => i.event === "alert")!.data)));
    const otherReader = b.body!.getReader();
    const first = new TextDecoder().decode((await otherReader.read()).value);
    expect(first).toContain(": connected");
    ctrl.abort();
    hub.close();
  });
});
