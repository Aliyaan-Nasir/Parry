/**
 * Top-up: keeps every service wallet funded from one treasury account, and records balances for
 * the status page, which warns when the treasury itself runs low.
 * TOPUP_WALLETS = "name:account:targetNear,..." (for example "keeper:keeper.parry.testnet:8").
 */

import { intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";
import { balanceOf, senderFromEnv, toNear, yocto } from "./lib/near";

const treasury = senderFromEnv("TREASURY");

export function wallets(spec = process.env.TOPUP_WALLETS ?? ""): { name: string; account: string; target: number }[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, account, target] = s.split(":");
      if (!name || !account || !Number(target)) throw new Error(`bad TOPUP_WALLETS entry ${s}`);
      return { name, account, target: Number(target) };
    });
}

async function pass(sql: Sql): Promise<string> {
  if (!treasury) throw new Error("TREASURY wallet is not configured");
  const notes: string[] = [];
  for (const w of wallets()) {
    const b = await balanceOf(w.account);
    const near = b === null ? 0 : toNear(b);
    // Refill to the target when a wallet falls under half of it.
    if (near < w.target / 2) {
      try {
        // Never more than the treasury can spare: it keeps 0.5 NEAR for its own transactions.
        const spare = toNear((await balanceOf(treasury.accountId)) ?? 0n) - 0.5;
        const amount = Math.min(w.target - near, spare);
        if (amount <= 0) throw new Error("the treasury is empty");
        await treasury.transfer(w.account, yocto(amount));
        notes.push(`${w.name} +${amount.toFixed(2)}`);
      } catch (e) {
        notes.push(`${w.name} refill failed: ${errorText(e)}`);
      }
    }
    await sql`INSERT INTO wallets (name, account, balance, target, checked_at) VALUES (${w.name}, ${w.account}, ${near}, ${w.target}, now())
      ON CONFLICT (name) DO UPDATE SET account = excluded.account, balance = excluded.balance, target = excluded.target, checked_at = now()`;
  }
  const t = toNear((await balanceOf(treasury.accountId)) ?? 0n);
  const min = Number(process.env.TREASURY_MIN_NEAR ?? 20);
  await sql`INSERT INTO wallets (name, account, balance, target, checked_at) VALUES ('treasury', ${treasury.accountId}, ${t}, ${min}, now())
    ON CONFLICT (name) DO UPDATE SET balance = excluded.balance, target = excluded.target, checked_at = now()`;
  if (t < min) log.warn("treasury low", { balance: t, min });
  return `treasury ${t.toFixed(2)} NEAR${t < min ? " (low)" : ""}; ${notes.join(", ") || "all wallets above half their target"}`;
}

export async function main() {
  const sql = db();
  await migrate(sql);
  let last = "";
  every(intEnv("TOPUP_MS", 120_000), "topup", async () => {
    last = await pass(sql);
    await setStatus(sql, "topup", !last.includes("low") && !last.includes("failed"), last);
  });
  serveHealth("topup", intEnv("PORT", 4800), async () => ({ ok: !!treasury, detail: last || "starting" }));
}
