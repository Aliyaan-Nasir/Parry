/**
 * Alerts: groups new alerts into incidents (one price move touching several positions is one
 * incident) and delivers one message per incident to Web Push subscriptions and, for people who linked it, a
 * Telegram chat (the bot links a chat when it receives `/start <code>` from Settings). The app
 * reads the same alerts from the API (in-app feed). An email digest is sent only when an email
 * provider key is configured.
 */

import webpush from "web-push";
import { incidentSummary, joinsIncident, type AlertKind, type Severity } from "@parryguard/core";
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

/** Sends one notification to a person's push subscriptions and linked Telegram chat. */
async function notify(sql: Sql, account: string, tag: string, title: string, body: string) {
  if (VAPID) {
    const subs = await sql<{ endpoint: string; keys: { p256dh: string; auth: string } }[]>`SELECT endpoint, keys FROM push_subscriptions WHERE account = ${account}`;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body, tag }));
      } catch (e) {
        // A gone subscription (404/410) is removed; anything else is retried next alert.
        if (/410|404/.test(errorText(e))) await sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
      }
    }
  }
  if (TELEGRAM) {
    const [s] = await sql<{ telegram_chat_id: string | null }[]>`SELECT telegram_chat_id FROM settings WHERE account = ${account}`;
    if (s?.telegram_chat_id) await telegram("sendMessage", { chat_id: s.telegram_chat_id, text: `${title}\n${body}` });
  }
}

type AlertRow = { id: string; account: string; kind: AlertKind; severity: Severity; key: string; title: string; body: string; created_at: Date; incident_id: string | null };

/**
 * Groups new alerts into incidents: an alert joins its account's open incident when it came within
 * the incident window of the incident opening (one price move touching several positions), else
 * it opens one. Returns the incidents that changed.
 */
export async function groupIncidents(sql: Sql): Promise<Set<string>> {
  const pending = await sql<AlertRow[]>`SELECT id, account, kind, severity, key, title, body, created_at, incident_id FROM alerts
    WHERE NOT delivered AND status = 'open' ORDER BY id LIMIT 200`;
  const touched = new Set<string>();
  for (const a of pending) {
    let incident = a.incident_id;
    if (!incident) {
      const [open] = await sql<{ id: string; opened_at: Date }[]>`SELECT id, opened_at FROM incidents WHERE account = ${a.account} AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`;
      if (open && joinsIncident(open.opened_at.getTime(), a.created_at.getTime(), false)) incident = String(open.id);
      else {
        const [created] = await sql<{ id: string }[]>`INSERT INTO incidents (account, title, body, severity, opened_at) VALUES (${a.account}, ${a.title}, ${a.body}, ${a.severity}, ${a.created_at}) RETURNING id`;
        incident = String(created!.id);
      }
      await sql`UPDATE alerts SET incident_id = ${incident} WHERE id = ${a.id}`;
    }
    touched.add(incident);
  }
  for (const id of touched) {
    const alerts = await sql<AlertRow[]>`SELECT id, account, kind, severity, key, title, body, created_at, incident_id FROM alerts WHERE incident_id = ${id} ORDER BY id`;
    const s = incidentSummary(alerts);
    await sql`UPDATE incidents SET title = ${s.title}, body = ${s.body}, severity = ${s.severity}, updated_at = now() WHERE id = ${id}`;
  }
  // An incident closes once every alert in it is resolved.
  await sql`UPDATE incidents i SET closed_at = now(), updated_at = now() WHERE closed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id AND a.status <> 'resolved')
    AND EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id)`;
  return touched;
}

/**
 * Delivers one message per incident: when it opens, and once more only if it becomes more severe
 * (a later critical alert in a warning incident). The alerts in it are then marked delivered.
 */
export async function deliver(sql: Sql, send: typeof notify = notify): Promise<number> {
  const touched = await groupIncidents(sql);
  let sent = 0;
  for (const id of touched) {
    const [i] = await sql<{ id: string; account: string; title: string; body: string; severity: Severity; delivered: boolean; delivered_rank: number | null }[]>`
      SELECT id, account, title, body, severity, delivered,
        (SELECT max(CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) FROM alerts WHERE incident_id = ${id} AND delivered) AS delivered_rank
      FROM incidents WHERE id = ${id}`;
    if (!i) continue;
    const rank = { info: 0, warning: 1, critical: 2 } as const;
    const escalated = i.delivered && i.delivered_rank !== null && rank[i.severity] > i.delivered_rank;
    if (!i.delivered || escalated) {
      await send(sql, i.account, `incident-${i.id}`, i.title, i.body);
      sent++;
    }
    await sql`UPDATE incidents SET delivered = true WHERE id = ${id}`;
    await sql`UPDATE alerts SET delivered = true WHERE incident_id = ${id} AND NOT delivered`;
  }
  return sent;
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
