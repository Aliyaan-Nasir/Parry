import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate, useQuota } from "../src/lib/db";
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
          market: { near: { priceUsd: 2.4 }, tremor: { annual: 0.72, level: "elevated" }, cascade: { pressure: 0.12 } },
        },
      ],
      ["gone.near"],
    );
    expect(md).toContain("| `alice.near` | 1.040 | $2.310 | 18.0 % | 30.5 h | 81 (critical) |");
    expect(md).toContain("`gone.near` | could not be read");
  });
});
