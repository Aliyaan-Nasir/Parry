import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate, useQuota } from "../src/lib/db";
import { delegateTgas, ownerRequestTgas, prepaidNear } from "../src/relayer";
import { Sender, spendable, TxError } from "../src/lib/near";
import { wallets } from "../src/topup";

const url = process.env.TEST_DATABASE_URL;

describe("top-up configuration", () => {
  test("parses wallets and refuses malformed entries", () => {
    expect(wallets("keeper:keeper.parry.testnet:8, relayer:relayer.parry.testnet:12")).toEqual([
      { name: "keeper", account: "keeper.parry.testnet", target: 8 },
      { name: "relayer", account: "relayer.parry.testnet", target: 12 },
    ]);
    expect(() => wallets("keeper:keeper.parry.testnet")).toThrow();
    expect(wallets("")).toEqual([]);
  });

  test("counts only what storage does not hold", () => {
    // 5 NEAR with 400 kB of storage (4 NEAR at 10^19 yoctoNEAR a byte) leaves 1 NEAR to spend.
    expect(spendable(5n * 10n ** 24n, 400_000)).toBe(10n ** 24n);
    expect(spendable(10n ** 24n, 400_000)).toBe(0n);
  });
});

describe("a send that failed", () => {
  const sender = new Sender({ accountId: "enclave.parry.testnet", privateKey: "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr" });
  const real = globalThis.fetch;
  // The RPC answers `tx` by its wait_until: an error name, or the outcome.
  const answering = (byWait: Record<string, string | object>) => {
    const asked: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const wait = (JSON.parse(init.body) as { params: { wait_until: string } }).params.wait_until;
      asked.push(wait);
      const a = byWait[wait];
      return Response.json(typeof a === "string" ? { jsonrpc: "2.0", id: "parry", error: { code: -32000, message: "Server error", cause: { name: a } } } : { jsonrpc: "2.0", id: "parry", result: a });
    }) as unknown as typeof fetch;
    return asked;
  };
  afterAll(() => {
    globalThis.fetch = real;
  });

  test("is sent again only when the chain never saw it", async () => {
    const asked = answering({ INCLUDED: "UNKNOWN_TRANSACTION" });
    expect(await sender.lookup("h1", 0)).toBeNull();
    expect(asked).toEqual(["INCLUDED", "INCLUDED", "INCLUDED"]);
  });

  test("that landed returns its outcome", async () => {
    const outcome = { status: { SuccessValue: "" }, transaction: { hash: "h2" }, receipts_outcome: [] };
    answering({ INCLUDED: {}, EXECUTED_OPTIMISTIC: outcome });
    expect(await sender.lookup("h2", 0)).toEqual(outcome as never);
  });

  test("that landed but is still running is never sent twice", async () => {
    // An OutLayer request waits on the worker: a second send would pay for a second run.
    const asked = answering({ INCLUDED: {}, EXECUTED_OPTIMISTIC: "TIMEOUT_ERROR" });
    const e = await sender.lookup("h3", 0, 0).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TxError);
    expect((e as TxError).hash).toBe("h3");
    expect(asked.filter((w) => w === "INCLUDED")).toHaveLength(1);
  });

  test("that landed is awaited until its slow outcome arrives", async () => {
    // A slow OutLayer worker answers after the RPC's own wait has timed out several times.
    const outcome = { status: { SuccessValue: "" }, transaction: { hash: "h4" }, receipts_outcome: [] };
    let pending = 5;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const wait = (JSON.parse(init.body) as { params: { wait_until: string } }).params.wait_until;
      const late = wait === "EXECUTED_OPTIMISTIC" && pending-- > 0;
      return Response.json(late ? { jsonrpc: "2.0", id: "parry", error: { code: -32000, message: "Server error", cause: { name: "TIMEOUT_ERROR" } } } : { jsonrpc: "2.0", id: "parry", result: wait === "INCLUDED" ? {} : outcome });
    }) as unknown as typeof fetch;
    expect(await sender.lookup("h4", 0, 60_000)).toEqual(outcome as never);
    expect(pending).toBe(-1);
  });
});

describe("relayer gas", () => {
  const request = (actions: unknown[]) => JSON.stringify({ account: "0ua.testnet", network: "testnet", nonce: 1, created_at: 1, actions });

  test("an owner request carries what its chain needs: 300, 900 for a close, 600 or more for an unwind", () => {
    expect(ownerRequestTgas(request([{ repay: { token: "usdc.parry.testnet", amount: "1" } }]))).toBe(300);
    expect(ownerRequestTgas(request([{ close_rhea: { slippage_bps: 100, pool_id: 2939 } }]))).toBe(900);
    expect(ownerRequestTgas(request([{ unwind: { tokens: ["usdc.parry.testnet", "wrap.testnet"], to: "me.testnet" } }]))).toBe(660);
    expect(ownerRequestTgas(request([{ unwind: { tokens: Array.from({ length: 16 }, (_, i) => `t${i}.testnet`) } }]))).toBe(1000);
    expect(ownerRequestTgas(request(["revoke_mandate"]))).toBe(300);
    expect(ownerRequestTgas("not json")).toBe(300);
  });

  test("a delegate's prepaid gas is the sum of its function calls, and the gas key is sized for it", () => {
    expect(delegateTgas([{ functionCall: { methodName: "owner_call", args: new Uint8Array(), gas: 900_000_000_000_000n, deposit: 1n } }, { transfer: { deposit: 1n } }])).toBe(900);
    expect(delegateTgas([])).toBe(0);
    // 300 Tgas needs about 0.35 NEAR up front at the pessimistic gas price.
    expect(prepaidNear(300)).toBeGreaterThan(0.35);
    expect(prepaidNear(900)).toBeLessThan(1.3);
  });
});

describe.skipIf(!url)("database-backed services", () => {
  const sql = postgres(url ?? "postgres://invalid", { onnotice: () => {} });

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    await migrate(sql); // idempotent
  });
  afterAll(() => sql.end());

  test("quotas count per day and stop at the limit", async () => {
    expect(await useQuota(sql, "t", "a", 2)).toBe(true);
    expect(await useQuota(sql, "t", "a", 2)).toBe(true);
    expect(await useQuota(sql, "t", "a", 2)).toBe(false);
    expect(await useQuota(sql, "t", "b", 2)).toBe(true);
  });

  test("the risk engine scores positions, keeps history, raises alerts and queues the guardian", async () => {
    process.env.PARRY_INTERNAL = "1";
    const { scoreAll } = await import("../src/risk");
    const now = Date.now();
    // Twelve hours of NEAR prices drifting down from 2.6 to 2.2.
    for (let i = 0; i <= 144; i++) {
      const t = new Date(now - (144 - i) * 300_000);
      await sql`INSERT INTO prices (asset, source, t, price) VALUES ('NEAR', 'oracle', ${t}, ${2.6 - (0.4 * i) / 144 + 0.01 * Math.sin(i)})`;
    }
    const lending = (collateral: number, debt: number) => ({
      position: {
        collateral: [{ symbol: "wNEAR", amount: collateral, priceUsd: 2.2, volatilityRatio: 0.75, driver: true }],
        debt: [{ symbol: "USDC", amount: debt, priceUsd: 1, volatilityRatio: 0.95, driver: false }],
      },
      protected: true,
    });
    await sql`INSERT INTO accounts (account, owner_kind, owner_id) VALUES ('0urisky.testnet', 'near', 'alice.testnet'), ('0usafe.testnet', 'near', 'bob.testnet')`;
    await sql`INSERT INTO positions (id, account, venue, label, raw, collateral_usd, debt_usd) VALUES
      ('0urisky.testnet:rhea:main', '0urisky.testnet', 'rhea', 'Rhea wNEAR/USDC', ${sql.json(lending(100, 150) as never)}, 220, 150),
      ('0usafe.testnet:rhea:main', '0usafe.testnet', 'rhea', 'Rhea wNEAR/USDC', ${sql.json(lending(100, 40) as never)}, 220, 40)`;
    expect(await scoreAll(sql)).toBe(2);
    const rows = await sql<{ id: string; score: number; tier: string; health: number }[]>`SELECT id, score, tier, health FROM positions ORDER BY id`;
    const risky = rows.find((r) => r.id.startsWith("0urisky"))!;
    const safe = rows.find((r) => r.id.startsWith("0usafe"))!;
    // 100 × 2.2 × 0.75 × 0.95 / 150 = 1.045: under 1.10, so at least danger.
    expect(risky.health).toBeCloseTo(1.045, 3);
    expect(risky.score).toBeGreaterThanOrEqual(50);
    expect(safe.tier).toBe("safe");
    const alerts = await sql`SELECT kind FROM alerts WHERE account = '0urisky.testnet' AND status = 'open'`;
    expect(alerts.map((a) => a.kind).sort()).toEqual(["health", "risk"]);
    const queue = await sql`SELECT account FROM guardian_queue`;
    expect(queue.map((q) => q.account)).toEqual(["0urisky.testnet"]);
    const history = await sql`SELECT count(*)::int AS n FROM position_history`;
    expect(history[0]!.n).toBe(2);

    // The position recovers: its alerts resolve on their own.
    await sql`UPDATE positions SET raw = ${sql.json(lending(200, 150) as never)} WHERE id = '0urisky.testnet:rhea:main'`;
    await scoreAll(sql);
    const open = await sql`SELECT 1 FROM alerts WHERE account = '0urisky.testnet' AND status = 'open' AND kind IN ('risk', 'health')`;
    expect(open.length).toBe(0);
  });
});

describe("Agent Market worker", () => {
  test("reads named and implicit NEAR accounts from a job, at most five", async () => {
    const { accountsIn } = await import("../src/market");
    expect(accountsIn("Check alice.near and Bob.Testnet please, also alice.near")).toEqual(["alice.near", "bob.testnet"]);
    expect(accountsIn(`implicit ${"ab".repeat(32)}`)).toEqual(["ab".repeat(32)]);
    expect(accountsIn("risk of 0ucgjz0wsmc9wyjzpdxnw835eb8tqy546bhppnhhmvf3j1xs1gj9a0?")).toEqual(["0ucgjz0wsmc9wyjzpdxnw835eb8tqy546bhppnhhmvf3j1xs1gj9a0"]);
    expect(accountsIn("a.near b.near c.near d.near e.near f.near")).toHaveLength(5);
  });

  test("reports each position and says when a job names no account", async () => {
    const { report } = await import("../src/market");
    expect(report([], [])).toContain("names no NEAR account");
    const md = report(
      [
        {
          account: "alice.near",
          position: { label: "Rhea wNEAR/USDC", health: 1.04, liqPrice: 2.31, probability24h: 0.18, ttlHours: 30.5, score: 81, tier: "critical" },
          market: { price: 2.4, tremor: { annual: 0.72, level: "elevated" }, cascade: { pressure: 0.12 } },
        },
      ],
      ["gone.near"],
    );
    expect(md).toContain("| `alice.near` | 1.040 | $2.310 | 18.0 % | 30.5 h | 81 (critical) |");
    expect(md).toContain("`gone.near` | could not be read");
  });
});
