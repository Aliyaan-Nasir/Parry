/**
 * Live updates: `GET /v1/stream` (Server-Sent Events) where an EventSource exists, else polling
 * the matching GET routes. Either way the handler gets one item at a time, shaped as the GET
 * route returns it, and only items that changed since the subscription started.
 */

import type { ParryApi } from "./api.js";
import type { StreamEvent } from "./types.js";

export interface SubscribeOptions {
  /** The events wanted (default: all six). */
  events?: StreamEvent[];
  /** Only this account's alerts, decisions and positions (alerts and positions need it when polling). */
  account?: string;
  onEvent: (event: StreamEvent, data: unknown) => void;
  onError?: (error: unknown) => void;
  /** Polling interval when there is no EventSource (default 10 s). */
  pollMs?: number;
  /** An EventSource implementation; `null` forces polling. Defaults to the global one. */
  eventSource?: (new (url: string) => EventSourceLike) | null;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (e: { data: string }) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
}

const ALL: StreamEvent[] = ["alert", "decision", "position", "price", "vault", "status"];

/** Subscribes to live updates; returns a function that stops them. */
export function subscribe(api: ParryApi, opts: SubscribeOptions): () => void {
  const events = opts.events ?? ALL;
  const ES = opts.eventSource === undefined ? ((globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource ?? null) : opts.eventSource;
  if (ES) {
    const source = new ES(api.url("/v1/stream", { events: events.join(","), account: opts.account }));
    for (const name of events) {
      source.addEventListener(name, (e) => {
        try {
          opts.onEvent(name, JSON.parse(e.data));
        } catch (err) {
          opts.onError?.(err);
        }
      });
    }
    source.onerror = (e) => opts.onError?.(e);
    return () => source.close();
  }
  return poll(api, events, opts);
}

type Seen = Map<string, string>;

function poll(api: ParryApi, events: StreamEvent[], opts: SubscribeOptions): () => void {
  let stopped = false;
  let first = true;
  const seen: Seen = new Map();
  /** Emits `item` when its version changed since the last poll (never on the first poll). */
  const offer = (event: StreamEvent, key: string, version: string, item: unknown) => {
    const k = `${event}:${key}`;
    if (seen.get(k) === version) return;
    seen.set(k, version);
    if (!first) opts.onEvent(event, item);
  };
  const a = opts.account;
  const tick = async () => {
    const jobs: Promise<void>[] = [];
    if (events.includes("alert") && a)
      jobs.push(api.request<{ id: string; updatedAt: string }[]>("/v1/alerts", { query: { account: a } }).then((xs) => xs.forEach((x) => offer("alert", x.id, x.updatedAt, x))));
    if (events.includes("decision"))
      jobs.push(api.request<{ items: { id: string; outcome: string }[] }>("/v1/guardian/decisions", { query: { account: a, limit: 10 } }).then((p) => p.items.forEach((x) => offer("decision", x.id, x.outcome, x))));
    if (events.includes("position") && a)
      jobs.push(api.request<{ id: string; updatedAt: string }[]>(`/v1/accounts/${encodeURIComponent(a)}/positions`).then((xs) => xs.forEach((x) => offer("position", x.id, x.updatedAt, x))));
    if (events.includes("price"))
      jobs.push(
        api.request<{ near: { priceUsd: number; updatedAt: string } }>("/v1/market").then((m) =>
          offer("price", "wrap.near", m.near.updatedAt, { id: "wrap.near", symbol: "NEAR", priceUsd: m.near.priceUsd, change24h: null, source: "Parry market report (lending oracle)" }),
        ),
      );
    if (events.includes("vault")) jobs.push(api.request<{ reportAt: string | null }>("/v1/vault").then((v) => offer("vault", "vault", String(v.reportAt), v)));
    if (events.includes("status"))
      jobs.push(api.request<{ services: { name: string; ok: boolean; detail: string; checkedAt: string }[] }>("/v1/status").then((s) => s.services.forEach((x) => offer("status", x.name, `${x.ok}|${x.detail}`, x))));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") opts.onError?.(r.reason);
    first = false;
  };
  const loop = async () => {
    while (!stopped) {
      await tick();
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 10_000));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
