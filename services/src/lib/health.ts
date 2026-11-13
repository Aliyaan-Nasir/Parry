/**
 * Every service answers `/live` (the process is up) and `/health` (its own checks, with alerts)
 * on its port, and records its state in `service_status` for the status page.
 */

import { log } from "./log";

export interface Check {
  ok: boolean;
  detail: string;
  [k: string]: unknown;
}

export function serveHealth(name: string, port: number, check: () => Promise<Check>, extra?: (req: Request) => Promise<Response | null>) {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/live") return Response.json({ ok: true, service: name });
      if (url.pathname === "/health") {
        const c = await check().catch((e) => ({ ok: false, detail: String(e) }));
        return Response.json({ service: name, ...c }, { status: c.ok ? 200 : 503 });
      }
      const r = extra ? await extra(req) : null;
      return r ?? new Response("not found", { status: 404 });
    },
  });
  log.info("listening", { port });
}

/** Runs `tick` every `ms`, never overlapping, logging failures (and after `retryMs` when one fails); returns a stop. */
export function every(ms: number, name: string, tick: () => Promise<void>, retryMs?: number): () => void {
  let running = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    if (running) return;
    running = true;
    if (retry) clearTimeout(retry);
    retry = null;
    try {
      await tick();
    } catch (e) {
      log.error(`${name} failed`, { error: (e as Error).message?.slice(0, 400) });
      // A task that runs rarely tries again sooner after a failure than its next period.
      if (retryMs !== undefined && retryMs < ms) retry = setTimeout(run, retryMs);
    } finally {
      running = false;
    }
  };
  void run();
  const interval = setInterval(run, ms);
  return () => {
    clearInterval(interval);
    if (retry) clearTimeout(retry);
  };
}
