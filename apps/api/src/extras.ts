/** Display-currency rates and the risk copilot. */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Sql } from "@parryguard/services/lib/db";
import { useQuota } from "@parryguard/services/lib/db";
import { cached, position, type PositionRow } from "./views";
import { recoverEip191 } from "./verify";

export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "SGD", "HKD", "AED", "INR", "CNY"] as const;

/** USD-based rates for the display currencies (balances only; nothing is priced in them). */
export async function fx() {
  return cached("fx", 3_600_000, async () => {
    const res = await fetch(process.env.FX_URL ?? "https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { result: string; rates: Record<string, number>; time_last_update_unix: number };
    if (body.result !== "success") throw new Error("the FX source did not answer");
    return {
      base: "USD",
      rates: Object.fromEntries(CURRENCIES.map((c) => [c, c === "USD" ? 1 : body.rates[c]!])),
      updatedAt: new Date(body.time_last_update_unix * 1000).toISOString(),
      source: "open.er-api.com",
    };
  });
}

const COPILOT_PROMPT = "You explain a leveraged position's liquidation risk to its owner in plain words. Use only the numbers given. " +
  "In at most five short sentences: say how close the position is to liquidation and what would trigger it, how likely that is in the next day and why " +
  "(volatility, trend, cascade pressure), and what the owner or their guardian can do (repay, add collateral, deleverage). No financial advice beyond that, no markdown.";

/**
 * The copilot: a NEAR AI Cloud verifiable model (it runs in a TEE and signs its answers) explains
 * a position. The API checks the signature covers exactly this exchange before returning it.
 */
export async function copilot(sql: Sql, body: { account: string; positionId?: string; question?: string }) {
  const key = process.env.NEARAI_API_KEY;
  if (!key) throw Object.assign(new Error("the copilot needs NEARAI_API_KEY on the API"), { status: 503 });
  if (!(await useQuota(sql, "copilot", body.account, Number(process.env.COPILOT_PER_DAY ?? 30)))) throw Object.assign(new Error("today's copilot questions for this account are used"), { status: 429 });
  const rows = await sql<PositionRow[]>`SELECT * FROM positions WHERE account = ${body.account} AND (${body.positionId ?? null}::text IS NULL OR id = ${body.positionId ?? null})`;
  if (rows.length === 0) throw Object.assign(new Error("no position to explain"), { status: 404 });
  const [m] = await sql<{ payload: unknown }[]>`SELECT payload FROM reports WHERE kind = 'market' ORDER BY run_id DESC LIMIT 1`;
  const model = process.env.PARRY_REVIEW_MODEL ?? "z-ai/glm-5.3-flash";
  const request = JSON.stringify({
    model,
    messages: [
      { role: "system", content: COPILOT_PROMPT },
      { role: "user", content: JSON.stringify({ positions: rows.map(position), market: m?.payload ?? null, question: body.question?.slice(0, 300) ?? "How at risk is this position?" }) },
    ],
    temperature: 0.2,
    max_tokens: 300,
    stream: false,
  });
  const base = process.env.NEARAI_URL ?? "https://cloud-api.near.ai/v1";
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: request, signal: AbortSignal.timeout(60_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`NEAR AI answered ${res.status}`);
  const out = JSON.parse(raw) as { id: string; choices: { message: { content: string } }[] };
  const answer = out.choices[0]?.message.content ?? "";
  let verified = false;
  let signingAddress: string | null = null;
  for (let i = 0; i < 4 && !verified; i++) {
    const s = await fetch(`${base}/signature/${out.id}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${key}` } })
      .then((r) => r.json() as Promise<{ text?: string; signature?: string; signing_address?: string }>)
      .catch(() => ({}) as { text?: string; signature?: string; signing_address?: string });
    if (!s.text || !s.signature) continue;
    const covers = s.text.endsWith(`${bytesToHex(sha256(utf8ToBytes(request)))}:${bytesToHex(sha256(utf8ToBytes(raw)))}`);
    signingAddress = s.signing_address ?? null;
    verified = covers && recoverEip191(s.text, s.signature).toLowerCase() === (s.signing_address ?? "").toLowerCase();
  }
  return { answer, model, chatId: out.id, verified, signingAddress, verifyUrl: "https://cloud.near.ai/verify" };
}
