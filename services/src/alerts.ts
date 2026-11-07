/**
 * Alerts: delivers new alerts to Web Push subscriptions and, for people who linked it, a
 * Telegram chat (the bot links a chat when it receives `/start <code>` from Settings). The app
 * reads the same alerts from the API (in-app feed). An email digest is sent only when an email
 * provider key is configured.
 */

import webpush from "web-push";
import { intEnv } from "./lib/config";
import { db, migrate, setStatus, type Sql } from "./lib/db";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";

const TELEGRAM = process.env.TELEGRAM_BOT_TOKEN;
const VAPID = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
if (VAPID) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:alerts@parry.invalid", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);

async function telegram(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return (await res.json()) as { ok: boolean; result?: unknown };
}

let telegramOffset = 0;
async function linkTelegram(sql: Sql) {
  if (!TELEGRAM) return;
  const r = (await telegram("getUpdates", { offset: telegramOffset, timeout: 0 })) as { result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
  for (const u of r.result ?? []) {
    telegramOffset = u.update_id + 1;
    const code = u.message?.text?.match(/^\/start\s+(\S+)/)?.[1];
    if (!code || !u.message) continue;
    const [s] = await sql<{ account: string }[]>`UPDATE settings SET telegram_chat_id = ${String(u.message.chat.id)}, telegram_code = NULL WHERE telegram_code = ${code} RETURNING account`;
    await telegram("sendMessage", { chat_id: u.message.chat.id, text: s ? `Parry alerts for ${s.account} will arrive here.` : "That link has expired. Open Settings in Parry for a new one." });
  }
}

async function deliver(sql: Sql): Promise<number> {
  const pending = await sql<{ id: string; account: string; severity: string; title: string; body: string }[]>`
    SELECT id, account, severity, title, body FROM alerts WHERE NOT delivered AND status = 'open' ORDER BY id LIMIT 50`;
  for (const a of pending) {
    if (VAPID) {
      const subs = await sql<{ endpoint: string; keys: { p256dh: string; auth: string } }[]>`SELECT endpoint, keys FROM push_subscriptions WHERE account = ${a.account}`;
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title: a.title, body: a.body, tag: a.id }));
        } catch (e) {
          // A gone subscription (404/410) is removed; anything else is retried next alert.
          if (/410|404/.test(errorText(e))) await sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
        }
      }
    }
    if (TELEGRAM) {
      const [s] = await sql<{ telegram_chat_id: string | null }[]>`SELECT telegram_chat_id FROM settings WHERE account = ${a.account}`;
      if (s?.telegram_chat_id) await telegram("sendMessage", { chat_id: s.telegram_chat_id, text: `${a.title}\n${a.body}` });
    }
    await sql`UPDATE alerts SET delivered = true WHERE id = ${a.id}`;
  }
  return pending.length;
}

async function digest(sql: Sql) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const people = await sql<{ account: string; email: string }[]>`SELECT account, email FROM settings WHERE digest = 'daily' AND email IS NOT NULL`;
  for (const p of people) {
    const rows = await sql<{ title: string; body: string }[]>`SELECT title, body FROM alerts WHERE account = ${p.account} AND created_at > now() - interval '1 day' ORDER BY id`;
    if (rows.length === 0) continue;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.DIGEST_FROM, to: p.email, subject: `Parry: ${rows.length} alerts today`, text: rows.map((r) => `${r.title}\n${r.body}`).join("\n\n") }),
    }).catch((e) => log.warn("digest failed", { error: errorText(e) }));
  }
}

export async function main() {
  const sql = db();
  await migrate(sql);
  let sent = 0;
  every(intEnv("ALERTS_MS", 5_000), "deliver", async () => {
    sent += await deliver(sql);
    await linkTelegram(sql);
    await setStatus(sql, "alerts", true, `${sent} delivered since start; push ${VAPID ? "on" : "off"}, Telegram ${TELEGRAM ? "on" : "off"}`);
  });
  every(86_400_000, "digest", () => digest(sql));
  serveHealth("alerts", intEnv("PORT", 4700), async () => ({ ok: true, detail: `${sent} delivered`, push: !!VAPID, telegram: !!TELEGRAM }));
}
