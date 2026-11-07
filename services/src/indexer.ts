/**
 * Indexer: Parry's NEP-297 events from FastNEAR's transactions API into Postgres. Per contract it
 * keeps the highest block it has processed; each pass pages back from the newest transaction to
 * that block, so a restart or a gap resynchronizes on its own. The factory's `account_created`
 * events become the protected-account list everything else reads.
 */

import { contract, FASTNEAR_TX_URL, intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";
import { derivedAddress, PATH_EVM, PATH_HYPERLIQUID } from "./lib/positions";

const STANDARDS = new Set(["parry-account", "parry-accounts", "parry-vault", "parry-risk", "parry-oracle", "nep141"]);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FASTNEAR_TX_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`fastnear ${path} ${res.status}`);
  return (await res.json()) as T;
}

type AccountTx = { transaction_hash: string; tx_block_height: number };
type Receipt = { execution_outcome: { id: string; block_height: number; block_timestamp: number; outcome: { logs: string[]; executor_id: string } } };

/** New transaction hashes touching `account` above `after`, oldest first. */
async function newTxs(account: string, after: number): Promise<AccountTx[]> {
  const out: AccountTx[] = [];
  let resume: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await post<{ account_txs: AccountTx[]; resume_token?: string }>("/v0/account", { account_id: account, ...(resume ? { resume_token: resume } : {}) });
    const fresh = r.account_txs.filter((t) => t.tx_block_height > after);
    out.push(...fresh);
    if (fresh.length < r.account_txs.length || !r.resume_token || r.account_txs.length === 0) break;
    resume = r.resume_token;
  }
  return out.reverse();
}

async function indexAccount(sql: Sql, account: string): Promise<number> {
  const [c] = await sql<{ last_block: string }[]>`SELECT last_block FROM indexer_cursors WHERE contract = ${account}`;
  const after = Number(c?.last_block ?? 0);
  const txs = await newTxs(account, after);
  let events = 0;
  for (let i = 0; i < txs.length; i += 20) {
    const batch = txs.slice(i, i + 20);
    const r = await post<{ transactions: { transaction: { hash: string }; receipts: Receipt[] }[] }>("/v0/transactions", { tx_hashes: batch.map((t) => t.transaction_hash) });
    for (const t of r.transactions) {
      for (const rc of t.receipts) {
        const o = rc.execution_outcome;
        let idx = 0;
        for (const l of o.outcome.logs) {
          if (!l.startsWith("EVENT_JSON:")) continue;
          let e: { standard?: string; event?: string; data?: unknown };
          try {
            e = JSON.parse(l.slice(11));
          } catch {
            continue;
          }
          if (!e.standard || !STANDARDS.has(e.standard)) continue;
          await sql`INSERT INTO events (receipt_id, idx, tx_hash, block_height, contract, standard, event, data, block_time)
            VALUES (${o.id}, ${idx++}, ${t.transaction.hash}, ${o.block_height}, ${o.outcome.executor_id}, ${e.standard}, ${e.event ?? ""},
            ${sql.json((e.data ?? {}) as never)}, to_timestamp(${o.block_timestamp / 1e9})) ON CONFLICT DO NOTHING`;
          events++;
          if (e.standard === "parry-accounts" && e.event === "account_created") await onAccountCreated(sql, e.data, t.transaction.hash);
        }
      }
    }
    const top = Math.max(...batch.map((b) => b.tx_block_height));
    await sql`INSERT INTO indexer_cursors (contract, last_block, updated_at) VALUES (${account}, ${top}, now())
      ON CONFLICT (contract) DO UPDATE SET last_block = GREATEST(indexer_cursors.last_block, excluded.last_block), updated_at = now()`;
  }
  if (txs.length === 0) {
    await sql`INSERT INTO indexer_cursors (contract, last_block) VALUES (${account}, ${after}) ON CONFLICT (contract) DO UPDATE SET updated_at = now()`;
  }
  return events;
}

async function onAccountCreated(sql: Sql, data: unknown, tx: string) {
  const d = data as { account: string; owner: { near?: { account_id: string }; passkey?: { key: number[] } } };
  const near = d.owner.near?.account_id;
  const ownerId = near ?? `p256:${Buffer.from(d.owner.passkey?.key ?? []).toString("hex")}`;
  const [hl, evm] = await Promise.all([derivedAddress(d.account, PATH_HYPERLIQUID).catch(() => null), derivedAddress(d.account, PATH_EVM).catch(() => null)]);
  await sql`INSERT INTO accounts (account, owner_kind, owner_id, hl_address, evm_address, created_tx) VALUES (${d.account}, ${near ? "near" : "passkey"}, ${ownerId}, ${hl}, ${evm}, ${tx})
    ON CONFLICT (account) DO UPDATE SET hl_address = COALESCE(accounts.hl_address, excluded.hl_address), evm_address = COALESCE(accounts.evm_address, excluded.evm_address)`;
}

export async function indexAll(sql: Sql): Promise<number> {
  const fixed = ["factory", "risk", "vault", "oracle"].map(contract).filter(Boolean);
  const accounts = (await sql<{ account: string }[]>`SELECT account FROM accounts`).map((r) => r.account);
  let n = 0;
  for (const a of [...fixed, ...accounts]) {
    try {
      n += await indexAccount(sql, a);
    } catch (e) {
      log.warn("index failed", { account: a, error: errorText(e) });
    }
  }
  return n;
}

export async function main() {
  const sql = db();
  await migrate(sql);
  let last = 0;
  every(intEnv("INDEXER_MS", 10_000), "index", async () => {
    const n = await indexAll(sql);
    last = Date.now();
    await setStatus(sql, "indexer", true, `${n} new events`);
  });
  serveHealth("indexer", intEnv("PORT", 4600), async () => ({ ok: Date.now() - last < 120_000, detail: "indexing", lastPassAt: last ? new Date(last).toISOString() : null }));
}
