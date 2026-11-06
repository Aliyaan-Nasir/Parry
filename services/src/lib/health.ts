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

/** Runs `tick` every `ms`, never overlapping, logging failures. */
export function every(ms: number, name: string, tick: () => Promise<void>): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      log.error(`${name} failed`, { error: (e as Error).message?.slice(0, 400) });
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(run, ms);
}
