/**
 * `GET /v1/stream`: Server-Sent Events. One shared poller per API process reads Postgres for what
 * changed since its last pass (alerts, decisions, scored positions, the oracle price, the vault's
 * report, service status) and fans each item out to every connected client that wants it, so the
 * database and the chain see one read per change whatever the number of clients. It runs only
 * while a client is connected. Each client gets a heartbeat comment every 15 seconds.
 */

import type { Sql } from "@parry/services/lib/db";
import { errorText } from "@parry/services/lib/log";
import { decision, position, vaultState, type DecisionRow, type PositionRow } from "./views";

export const STREAM_EVENTS = ["alert", "decision", "position", "price", "vault", "status"] as const;
export type StreamEvent = (typeof STREAM_EVENTS)[number];

export interface StreamItem {
  event: StreamEvent;
  /** The account the item belongs to, or null for market-wide items. */
  account: string | null;
  data: unknown;
}

interface Client {
  events: Set<StreamEvent>;
  account: string | null;
  send: (chunk: string) => void;
}

type AlertRow = { id: string; account: string; kind: string; severity: string; title: string; body: string; status: string; created_at: Date; updated_at: Date };

export const alertView = (a: AlertRow) => ({
  id: String(a.id),
  account: a.account,
  kind: a.kind,
  severity: a.severity,
  title: a.title,
  body: a.body,
  status: a.status,
  createdAt: a.created_at.toISOString(),
  updatedAt: a.updated_at.toISOString(),
});

export const sseFrame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class StreamHub {
  private readonly clients = new Set<Client>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Per event, the database time (text, microseconds) of the newest item sent. */
  private cursor: Record<string, string> = {};
  private ready: Promise<void> = Promise.resolve();
  private polling = false;

  constructor(
    private readonly sql: Sql,
    private readonly opts: { pollMs?: number; heartbeatMs?: number; vault?: (sql: Sql) => Promise<unknown> } = {},
  ) {}

  get size(): number {
    return this.clients.size;
  }

  /**
   * Starts the cursors at the database's now (its clock, not this process's, so no change is lost
   * to clock skew): a client gets what changes after it connects.
   */
  private start() {
    this.ready = this.sql<{ t: string }[]>`SELECT now()::text AS t`.then(([r]) => {
      const now = r!.t;
      this.cursor = { alert: now, decision: now, position: now, price: now, vault: now, status: now };
    });
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 2000);
    this.heartbeat = setInterval(() => this.broadcastRaw(": heartbeat\n\n"), this.opts.heartbeatMs ?? 15_000);
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = this.heartbeat = null;
  }

  private broadcastRaw(chunk: string) {
    for (const c of this.clients) c.send(chunk);
  }

  /** Delivers items to the clients that want them. */
  publish(items: StreamItem[]) {
    for (const item of items) {
      const frame = sseFrame(item.event, item.data);
      for (const c of this.clients) {
        if (!c.events.has(item.event)) continue;
        if (c.account && item.account && item.account !== c.account) continue;
        c.send(frame);
      }
    }
  }

  /** One pass over everything that changed since the last one. */
  async poll(): Promise<StreamItem[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const items = await this.changes();
      this.publish(items);
      return items;
    } catch (e) {
      this.broadcastRaw(`: poll failed: ${errorText(e).replace(/\n/g, " ")}\n\n`);
      return [];
    } finally {
      this.polling = false;
    }
  }

  private async changes(): Promise<StreamItem[]> {
    const sql = this.sql;
    await this.ready;
    // Cursors are the database's own timestamps as text, so comparisons keep its microseconds; the
    // parameter goes in as text (postgres.js would round a timestamptz parameter to milliseconds).
    const c = this.cursor;
    const out: StreamItem[] = [];
    const advance = (k: string, t: string | null | undefined) => {
      if (t) c[k] = t;
    };
    const alerts = await sql<(AlertRow & { cur: string })[]>`SELECT *, updated_at::text AS cur FROM alerts WHERE updated_at > ${c.alert!}::text::timestamptz ORDER BY updated_at LIMIT 200`;
    for (const a of alerts) out.push({ event: "alert", account: a.account, data: alertView(a) });
    advance("alert", alerts.at(-1)?.cur);
    const decisions = await sql<(DecisionRow & { cur: string })[]>`SELECT *, created_at::text AS cur FROM decisions WHERE created_at > ${c.decision!}::text::timestamptz ORDER BY created_at LIMIT 100`;
    for (const d of decisions) out.push({ event: "decision", account: d.account, data: decision(d) });
    advance("decision", decisions.at(-1)?.cur);
    const positions = await sql<(PositionRow & { cur: string })[]>`SELECT *, scored_at::text AS cur FROM positions WHERE scored_at > ${c.position!}::text::timestamptz ORDER BY scored_at LIMIT 500`;
    for (const p of positions) out.push({ event: "position", account: p.account, data: position(p) });
    advance("position", positions.at(-1)?.cur);
    const [price] = await sql<{ cur: string; price: number; old: number | null }[]>`
      SELECT t::text AS cur, price, (SELECT price FROM prices WHERE asset = 'NEAR' AND source = 'oracle' AND t < now() - interval '24 hours' ORDER BY t DESC LIMIT 1) AS old
      FROM prices WHERE asset = 'NEAR' AND source = 'oracle' AND t > ${c.price!}::text::timestamptz ORDER BY t DESC LIMIT 1`;
    if (price) {
      out.push({
        event: "price",
        account: null,
        data: { id: "wrap.near", symbol: "NEAR", priceUsd: price.price, change24h: price.old ? price.price / price.old - 1 : null, source: "lending oracle (the monitor's sample)" },
      });
      advance("price", price.cur);
    }
    const [vault] = await sql<{ cur: string }[]>`SELECT t::text AS cur FROM vault_history WHERE t > ${c.vault!}::text::timestamptz ORDER BY t DESC LIMIT 1`;
    if (vault) {
      advance("vault", vault.cur);
      // One chain read per vault report, shared by every client.
      const state = await (this.opts.vault ?? vaultState)(sql).catch(() => null);
      if (state) out.push({ event: "vault", account: null, data: state });
    }
    const status = await sql<{ name: string; ok: boolean; detail: string; checked_at: Date; cur: string }[]>`SELECT *, checked_at::text AS cur FROM service_status WHERE checked_at > ${c.status!}::text::timestamptz ORDER BY checked_at LIMIT 50`;
    for (const s of status) out.push({ event: "status", account: null, data: { name: s.name, ok: s.ok, detail: s.detail, checkedAt: s.checked_at.toISOString() } });
    advance("status", status.at(-1)?.cur);
    return out;
  }

  /** A text/event-stream response for one client; it leaves when the request is aborted. */
  connect(req: { events: StreamEvent[]; account: string | null; signal?: AbortSignal }): Response {
    const encoder = new TextEncoder();
    let client: Client | null = null;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = {
          events: new Set(req.events),
          account: req.account,
          send: (chunk) => {
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              this.leave(client!);
            }
          },
        };
        if (this.clients.size === 0) this.start();
        this.clients.add(client);
        controller.enqueue(encoder.encode(`: connected; events ${req.events.join(",")}\nretry: 5000\n\n`));
        req.signal?.addEventListener("abort", () => {
          this.leave(client!);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel: () => {
        if (client) this.leave(client);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" } });
  }

  private leave(c: Client) {
    if (!this.clients.delete(c)) return;
    if (this.clients.size === 0) this.stop();
  }

  close() {
    this.clients.clear();
    this.stop();
  }
}
