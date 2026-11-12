import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import postgres from "postgres";
import * as near from "../src/lib/near";
import { migrate } from "../src/lib/db";

const url = process.env.TEST_DATABASE_URL;

// The enclave and the chain stand in: each run records the accounts it was asked about, and each
// account's mandate view says how many of its daily actions are used.
const runs: string[][] = [];
const used: Record<string, number> = {};
mock.module("../src/lib/enclave", () => ({
  runEnclave: async (_mode: string, accounts: string[]) => {
    runs.push(accounts);
    return { output: { decisions: [], skipped: accounts.map((account) => ({ account, reason: "no action needed" })) }, tx: null };
  },
}));
mock.module("../src/lib/near", () => ({
  ...near,
  view: async (account: string, method: string) =>
    method === "mandate" && account in used ? { mandate: { max_actions_per_day: 10 }, actions_today: used[account] } : null,
}));
const { tick } = await import("../src/guardian");

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
    used["0ufull.testnet"] = 10;
    used["0uroom.testnet"] = 3;
    await sql`INSERT INTO guardian_queue (account, reason) VALUES ('0ufull.testnet', 'danger 60'), ('0uroom.testnet', 'danger 61')`;
    await tick(sql);
    expect(runs).toEqual([["0uroom.testnet"]]);
    // Both wait out the cooldown: the full one is looked at again later, when a new day may have begun.
    const queued = await sql<{ account: string; last_run_at: Date | null }[]>`SELECT account, last_run_at FROM guardian_queue ORDER BY account`;
    expect(queued.map((q) => [q.account, q.last_run_at !== null])).toEqual([
      ["0ufull.testnet", true],
      ["0uroom.testnet", true],
    ]);
  });
});
