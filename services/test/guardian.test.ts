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
});
