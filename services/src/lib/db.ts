/** Postgres, with the plain SQL migrations in services/migrations applied in order at start. */

import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";

export type Sql = postgres.Sql;

let shared: Sql | null = null;

export function db(url = process.env.DATABASE_URL): Sql {
  if (shared) return shared;
  if (!url) throw new Error("DATABASE_URL is not set");
  shared = postgres(url, { max: Number(process.env.DB_POOL ?? 4), idle_timeout: 30, onnotice: () => {} });
  return shared;
}

export async function migrate(sql: Sql): Promise<void> {
  const dir = join(import.meta.dir, "..", "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  // Services start together: one transaction under one advisory lock creates the bookkeeping
  // table and applies what is missing, so concurrent starts never race.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242)`;
    await tx`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    for (const f of files) {
      const [done] = await tx`SELECT 1 FROM migrations WHERE name = ${f}`;
      if (done) continue;
      await tx.unsafe(readFileSync(join(dir, f), "utf8"));
      await tx`INSERT INTO migrations (name) VALUES (${f})`;
      log.info("migration applied", { file: f });
    }
  });
}

/** Counts one use of `kind` by `who` today; false once `limit` is reached. */
export async function useQuota(sql: Sql, kind: string, who: string, limit: number): Promise<boolean> {
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO usage (day, kind, who, count) VALUES (current_date, ${kind}, ${who}, 1)
    ON CONFLICT (day, kind, who) DO UPDATE SET count = usage.count + 1
    RETURNING count`;
  return (row?.count ?? 0) <= limit;
}

export async function setStatus(sql: Sql, name: string, ok: boolean, detail: string): Promise<void> {
  await sql`INSERT INTO service_status (name, ok, detail, checked_at) VALUES (${name}, ${ok}, ${detail}, now())
    ON CONFLICT (name) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, checked_at = now()`;
}
