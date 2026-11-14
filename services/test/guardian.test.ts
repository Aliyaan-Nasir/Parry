import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "../src/lib/db";
import { tick } from "../src/guardian";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("guardian (database)", () => {
  const sql = postgres(url ?? "", { max: 2, onnotice: () => {} });
  beforeAll(async () => {
    await migrate(sql);
    await sql`DELETE FROM guardian_queue`;
  });
  afterAll(async () => {
    await sql`DELETE FROM guardian_queue`;
    await sql.end();
  });

  test("an account whose mandate has used today's actions is not sent to the enclave", async () => {
    // The enclave and the chain stand in: each run records the accounts it was asked about, and
    // each account's mandate view says how many of its ten daily actions are used.
    const runs: string[][] = [];
    const used: Record<string, number> = { "0ufull.testnet": 10, "0uroom.testnet": 3 };
    const run = (async (_mode: string, accounts: string[]) => {
      runs.push(accounts);
      return { output: { decisions: [], skipped: accounts.map((account) => ({ account, reason: "no action needed" })) }, tx: null };
    }) as never;
    const read = (async (account: string, method: string) =>
      method === "mandate" && account in used ? { mandate: { max_actions_per_day: 10 }, actions_today: used[account] } : null) as never;
    await sql`INSERT INTO guardian_queue (account, reason) VALUES ('0ufull.testnet', 'danger 60'), ('0uroom.testnet', 'danger 61')`;
    await tick(sql, { run, read });
    expect(runs).toEqual([["0uroom.testnet"]]);
    // Both wait out the cooldown: the full one is looked at again later, when a new day may have begun.
    const queued = await sql<{ account: string; last_run_at: Date | null }[]>`SELECT account, last_run_at FROM guardian_queue ORDER BY account`;
    expect(queued.map((q) => [q.account, q.last_run_at !== null])).toEqual([
      ["0ufull.testnet", true],
      ["0uroom.testnet", true],
    ]);
  });

  test("a decision keeps its public plan, the facts and the record apart from the full plan; its alert carries the public plan", async () => {
    await sql`DELETE FROM guardian_queue`;
    await sql`INSERT INTO guardian_queue (account, reason) VALUES ('0uprivate.testnet', 'danger 60')`;
    const plan = "Repay 3.81 USDC from the reserve: health 1.122 to 1.450 (target 1.45). Chose repay: the first step in the order repay, deleverage that the mandate allows and that moves health toward 1.45.";
    // Rejected by the review, so nothing is sent: only what is stored is under test.
    const decision = (publicPlan: string | undefined) => ({
      account: "0uprivate.testnet",
      venue: "rhea",
      plan,
      ...(publicPlan ? { public_plan: publicPlan } : {}),
      facts: { target_health: 1.45, owner_trigger: { score: 60, health: 1.15 } },
      action: { repay: { token: "usdc.parry.testnet", amount: "3810000" } },
      review: { model: "z-ai/glm-5.3-flash", verdict: "reject", reasoning: "below the owner's trigger of 1.15" },
      review_hash: publicPlan ? "ab".repeat(32) : "cd".repeat(32),
      outcome: "rejected by the review",
      explanation: { step: "repay", why: "Chose repay", skipped: [] },
    });
    const run = (async () => ({ output: { decisions: [decision("Repay 3.81 USDC from the reserve."), decision(undefined)], skipped: [] }, tx: null })) as never;
    const read = (async () => null) as never;
    await tick(sql, { run, read });
    const rows = await sql<{ id: string; plan: string; public_plan: string; facts: unknown }[]>`SELECT id, plan, public_plan, facts FROM decisions WHERE account = '0uprivate.testnet' ORDER BY id`;
    expect(rows.map((r) => r.public_plan)).toEqual(["Repay 3.81 USDC from the reserve.", "Repay 3.81 USDC from the reserve."]);
    expect(rows.every((r) => r.plan === plan)).toBe(true);
    expect(rows[0]!.facts).toEqual({ target_health: 1.45, owner_trigger: { score: 60, health: 1.15 } });
    const alerts = await sql<{ body: string }[]>`SELECT body FROM alerts WHERE account = '0uprivate.testnet' AND kind = 'guardian'`;
    expect(alerts.map((a) => a.body)).toEqual(["Repay 3.81 USDC from the reserve.", "Repay 3.81 USDC from the reserve."]);
  });
});
