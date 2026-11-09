/**
 * Agent Market worker: answers hires of Parry's listing on NEAR's Agent Market (market.near.ai).
 * It polls the agent's assignments, reads the NEAR accounts named in each job, scores their
 * lending positions through Parry's own API, and submits a Markdown risk report. It runs only
 * with MARKET_AGENT_TOKEN, which `bun scripts/market.ts --register` writes (with the owner's
 * go-ahead: registering creates a public listing).
 */

import { intEnv } from "./lib/config";
import { db, migrate, setStatus } from "./lib/db";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";

const MARKET = (process.env.MARKET_URL ?? "https://market.near.ai").replace(/\/$/, "");
const API = (process.env.PARRY_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const TOKEN = process.env.MARKET_AGENT_TOKEN;
const MAX_ACCOUNTS = 5;
let lastDetail = "idle";

interface Assignment {
  assignment: { assignmentId: string; status: string; submittedAt: string | null };
  job: { title: string; description: string };
}

interface RiskCheck {
  account: string;
  position: { label: string; health: number | null; liqPrice: number | null; probability24h: number; ttlHours: number | null; score: number; tier: string } | null;
  market: { near: { priceUsd: number }; tremor: { annual: number; level: string }; cascade: { pressure: number } };
}

/** NEAR account ids named in a job: named accounts and 64-hex implicit accounts, at most five. */
export function accountsIn(text: string): string[] {
  const named = text.match(/\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b/gi) ?? [];
  const implicit = text.match(/\b[0-9a-f]{64}\b/g) ?? [];
  return [...new Set([...named, ...implicit].map((a) => a.toLowerCase()))].slice(0, MAX_ACCOUNTS);
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)} %`;

/** The Markdown report for one job. */
export function report(checks: RiskCheck[], missing: string[]): string {
  const lines = ["# Liquidation risk report", ""];
  if (checks.length === 0 && missing.length === 0) {
    return [...lines, "The job names no NEAR account. Name one or more accounts, for example `alice.near`, and hire again."].join("\n");
  }
  const m = checks[0]?.market;
  if (m) lines.push(`Scored against NEAR at $${m.near.priceUsd.toFixed(3)}, Tremor volatility ${pct(m.tremor.annual)} a year (${m.tremor.level}), cascade pressure ${m.cascade.pressure.toFixed(2)}.`, "");
  lines.push("| Account | Health | Liquidation price | 24 h liquidation odds | Median time to liquidation | Score |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const c of checks) {
    const p = c.position;
    if (!p) {
      lines.push(`| \`${c.account}\` | no lending position | | | | |`);
      continue;
    }
    const ttl = p.ttlHours === null ? "beyond 30 days" : p.ttlHours < 48 ? `${p.ttlHours.toFixed(1)} h` : `${(p.ttlHours / 24).toFixed(1)} days`;
    lines.push(`| \`${c.account}\` | ${p.health === null ? "no debt" : p.health.toFixed(3)} | ${p.liqPrice === null ? "none" : `$${p.liqPrice.toFixed(3)}`} | ${pct(p.probability24h)} | ${ttl} | ${p.score} (${p.tier}) |`);
  }
  for (const a of missing) lines.push(`| \`${a}\` | could not be read | | | | |`);
  lines.push("", "The score combines the 24 hour odds of liquidation, volatility and cascade pressure (0 to 100: safe under 25, caution from 25, danger from 50, critical from 75).");
  lines.push("Parry can protect these positions: its guardian repays, adds collateral or deleverages before the threshold, inside a mandate the owner sets.");
  return lines.join("\n");
}

async function market<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${MARKET}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Scores every account a job names and returns the report. */
export async function answer(title: string, description: string): Promise<string> {
  const accounts = accountsIn(`${title}\n${description}`);
  const checks: RiskCheck[] = [];
  const missing: string[] = [];
  for (const a of accounts) {
    const r = await fetch(`${API}/v1/risk/${encodeURIComponent(a)}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r?.ok) checks.push((await r.json()) as RiskCheck);
    else missing.push(a);
  }
  return report(checks, missing);
}

async function tick(): Promise<string> {
  const { assignments } = await market<{ assignments: Assignment[] }>("GET", "/v1/agents/me/assignments");
  const open = assignments.filter((a) => a.assignment.status === "in_progress" && !a.assignment.submittedAt);
  for (const a of open) {
    const md = await answer(a.job.title, a.job.description);
    await market("POST", `/v1/assignments/${a.assignment.assignmentId}/submit`, { deliverableMarkdown: md });
    log.info("market job answered", { assignment: a.assignment.assignmentId });
  }
  return `${open.length} answered, ${assignments.length} assignments`;
}

export async function main() {
  const sql = db();
  await migrate(sql);
  if (TOKEN) {
    every(intEnv("MARKET_MS", 45_000), "market", async () => {
      try {
        lastDetail = await tick();
        await setStatus(sql, "market", true, lastDetail);
      } catch (e) {
        lastDetail = errorText(e);
        await setStatus(sql, "market", false, lastDetail);
        throw e;
      }
    });
  } else {
    lastDetail = "not listed: MARKET_AGENT_TOKEN is not set (scripts/market.ts --register)";
  }
  serveHealth("market", intEnv("PORT", 4900), async () => ({ ok: true, detail: lastDetail }));
}
