/**
 * The market, replay, verification, watched-account, certificate, savings, insurance, heatmap,
 * price, incident and stream routes (docs/api.md). Every number read live says where it came from.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { alertsFor, DEFAULT_ANNUAL_VOL, DEFAULT_THRESHOLDS, routeSaving, type StoredRoutes } from "@parry/core";
import { enclaveKeyAt, envelopeDigest, fromBase58, verifyCertificate } from "@parry/sdk";
import { checkInput, CertificateError, certificateView, issueCertificate, type CertificateRow } from "@parry/services/lib/certificates";
import { contract, FASTNEAR_TX_URL, network, type Network } from "@parry/services/lib/config";
import type { Sql } from "@parry/services/lib/db";
import { heatmapView } from "@parry/services/lib/heatmap";
import { changes24h, BINANCE_TICKER, hyperliquidFunding, lendingOf, pythInfos, rheaAssets, tokenMeta, tokenPrices } from "@parry/services/lib/markets";
import { view } from "@parry/services/lib/near";
import { oraclePrices, readRhea } from "@parry/services/lib/positions";
import type { Context, Hono } from "hono";
import { alertView, STREAM_EVENTS, StreamHub, type StreamEvent } from "./stream";
import { verifyDecisionRecord } from "./verify";
import { cached, position, vaultState, type DecisionRow, type PositionRow } from "./views";

export interface RouteHelpers {
  bad: (message: string, status?: number) => Error;
  account: (id: unknown) => string;
  numQuery: (c: Context, name: string, fallback: number, min: number, max: number) => number;
  body: <T>(c: Context) => Promise<T>;
  /** The signed-in account, or a 401. */
  signedIn: (c: Context) => Promise<string>;
}

const ROOT = join(import.meta.dir, "..", "..", "..");
const REPLAY = process.env.PARRY_REPLAY_FILE ?? join(ROOT, "deployments", "replay.json");
const WATCH_LIMIT = 25;

type InsuranceView = {
  share_bps: number;
  linear: string;
  usdc_e6: string;
  value_usd_e6: string;
  paid_total_e6: string;
  paid_today_e6: string;
  cap_per_day_bps: number;
  margin_reserved_usd_e6: string;
};

/** The vault's `insurance()` view, or null while the deployed vault has none. */
export const insuranceOf = () => cached("insurance", 30_000, () => view<InsuranceView>(contract("vault"), "insurance").catch(() => null));

/** The NEAR key that signed a risk-board report (`at`) or a guardian envelope (`issued_at`), from the board's key history. */
async function keyHistory() {
  return cached("enclave-history", 60_000, () => view<{ public_key: string; wasm_sha256: string; since: number }[]>(contract("risk"), "enclave_history", { limit: 100 }).catch(() => []));
}

const verifyEd25519 = (signatureB64: string, digest: Uint8Array, key: string): boolean => {
  try {
    return ed25519.verify(Buffer.from(signatureB64, "base64"), digest, fromBase58(key.replace(/^ed25519:/, "")));
  } catch {
    return false;
  }
};

type FastTx = {
  transaction: { hash?: string; signer_id: string; receiver_id: string; actions: ({ FunctionCall?: { method_name: string; args: string } } | string)[] };
  execution_outcome: { block_timestamp: number; outcome: { status: unknown } };
  receipts: { execution_outcome: { outcome: { logs: string[]; status: unknown } } }[];
};

/** A transaction by hash from FastNEAR's public transactions API (no sender needed). */
async function fetchTx(hash: string): Promise<FastTx | null> {
  const res = await fetch(`${FASTNEAR_TX_URL}/v0/transactions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hashes: [hash] }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FastNEAR transactions API answered ${res.status}`);
  const body = (await res.json()) as { transactions: FastTx[] };
  return body.transactions[0] ?? null;
}

const failed = (status: unknown) => !!status && typeof status === "object" && "Failure" in status;

export function registerRoutes(app: Hono, sql: Sql, h: RouteHelpers) {
  // ------------------------------------------------------------------ rates
  app.get("/v1/rates", async (c) => {
    const rhea = await cached("rhea-rates", 60_000, async () => {
      const assets = await rheaAssets(network);
      return Promise.all(
        assets.map(async (a) => ({
          asset: (await tokenMeta(network, a.tokenId)).symbol,
          tokenId: a.tokenId,
          supplyApr: a.supplyApr,
          borrowApr: a.borrowApr,
          utilization: a.utilization,
          source: `${lendingOf(network)} get_assets_paged_detailed`,
        })),
      );
    });
    const hyperliquid = await hyperliquidFunding().catch((e) => ({ fundingHourly: null, funding24hApr: null, source: `unavailable: ${(e as Error).message}` }));
    const v = await vaultState(sql).catch(() => null);
    const ins = await insuranceOf();
    const [first] = await sql<{ t: Date | null }[]>`SELECT min(t) AS t FROM vault_history`;
    const days = first?.t ? Math.max(1 / 24, (Date.now() - first.t.getTime()) / 86_400_000) : 0;
    const fundingApr = v && v.navUsd > 0 && days > 0 ? (v.yield.fundingUsd / v.navUsd) * (365 / days) : null;
    const stakingApr = v?.yield.stakingApr ?? null;
    return c.json({
      rhea,
      hyperliquid,
      vault: {
        stakingApr,
        fundingApr,
        netApr: stakingApr !== null && fundingApr !== null ? stakingApr + fundingApr : null,
        insuranceShareBps: ins?.share_bps ?? null,
        source: `${contract("vault")} yield_breakdown (LiNEAR rate growth and the short's funding since ${first?.t?.toISOString() ?? "the first report"})${ins ? " and insurance()" : ""}`,
      },
      readAt: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------------ prices
  app.get("/v1/prices", async (c) => {
    const all = await cached("prices", 60_000, async () => {
      const [prices, changes, infos, assets] = await Promise.all([tokenPrices(), changes24h().catch(() => new Map()), pythInfos(), rheaAssets("mainnet")]);
      const ids = [...new Set([...assets.map((a) => a.tokenId), ...Object.keys(infos)])];
      const rows = await Promise.all(
        ids.map(async (id) => {
          const p = prices.get(id);
          if (!p) return null;
          const ch = changes.get(infos[id]?.price_identifier ?? "");
          return {
            id,
            symbol: (await tokenMeta("mainnet", id)).symbol,
            priceUsd: p.priceUsd,
            change24h: ch ? ch.change : null,
            source: `${p.source}${ch ? `; 24 h change: ${BINANCE_TICKER} ${ch.symbol}${p.nearLinked && id !== "wrap.near" ? " (the token's NEAR rate moves under 0.1 % a day)" : ""}` : ""}`,
          };
        }),
      );
      return rows.filter((r): r is NonNullable<typeof r> => r !== null);
    });
    const wanted = c.req.query("tokens")?.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const tokens = wanted?.length ? all.filter((t) => wanted.includes(t.id.toLowerCase()) || wanted.includes(t.symbol.toLowerCase())) : all;
    return c.json({ tokens, readAt: new Date().toISOString() });
  });

  // ------------------------------------------------------------------ replay
  app.get("/v1/replay", async (c) => {
    if (!existsSync(REPLAY)) return c.json({ error: "no replay yet: run pnpm replay" }, 503);
    const file = await cached(`replay:${statSync(REPLAY).mtimeMs}`, 3_600_000, async () => JSON.parse(readFileSync(REPLAY, "utf8")) as unknown);
    // ?summary=1: the headline figures and sources without the hourly series (a few hundred bytes, not 150 KB).
    if (c.req.query("summary") === "1") {
      const { crashes: _crashes, ...rest } = file as { crashes?: unknown[] } & Record<string, unknown>;
      return c.json({ ...rest, crashes: [] });
    }
    return c.json(file as Record<string, unknown>);
  });

  // ------------------------------------------------------------------ heatmap
  app.get("/v1/heatmap", async (c) => {
    const net = (c.req.query("network") ?? network) as Network;
    if (net !== "testnet" && net !== "mainnet") throw h.bad("network is testnet or mainnet");
    const asset = (c.req.query("asset") ?? "NEAR").toUpperCase();
    if (asset !== "NEAR" && asset !== "WNEAR") throw h.bad("asset: the heatmap's driver is NEAR (wNEAR and the liquid staking tokens move with it)");
    // The market report's price and volatility, so this pressure is the one /v1/market shows.
    const [m] = await sql<{ payload: { price?: number; tremor?: { sigmaHourly?: number } } }[]>`SELECT payload FROM reports WHERE kind = 'market' ORDER BY run_id DESC LIMIT 1`;
    const price = m?.payload.price || (await tokenPrices()).get("wrap.near")?.priceUsd;
    if (!price) throw h.bad("no NEAR price from the lending oracle", 503);
    const sigma = m?.payload.tremor?.sigmaHourly ?? DEFAULT_ANNUAL_VOL / Math.sqrt(8760);
    return c.json(await heatmapView(sql, net, price, sigma));
  });

  // ------------------------------------------------------------------ verification
  app.get("/v1/verify/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9]{32,128}$/.test(id)) throw h.bad("an id is a decision id, a certificate hash (hex) or a NEAR transaction hash (base58)");
    const [d] = await sql<DecisionRow[]>`SELECT * FROM decisions WHERE id = ${id}`;
    if (d) {
      const v = await verifyDecisionRecord(d);
      return c.json({ kind: "decision", ok: v.ok, checks: v.checks, subject: { id: d.id, account: d.account, action: d.action, outcome: d.outcome, attestation: v.attestation, txs: d.txs } });
    }
    const [cert] = await sql<CertificateRow[]>`SELECT * FROM certificates WHERE hash = ${id.toLowerCase()}`;
    if (cert) {
      const history = await keyHistory();
      const anchor = await view<{ hash: string; reader: string; expires_at: number; at: number } | null>(contract("risk"), "certificate", { hash: cert.hash }).then(
        (a) => a ?? null,
        () => undefined,
      );
      const v = verifyCertificate(certificateView(cert), { enclaveHistory: history, ...(anchor !== undefined ? { anchor } : {}) });
      return c.json({
        kind: "certificate",
        ok: v.ok,
        checks: v.checks.map((x) => ({ name: x.name, ok: x.status !== "fail", detail: x.status === "skip" ? `not checked: ${x.detail}` : x.detail })),
        subject: { hash: cert.hash, certificate: v.certificate, anchorTx: cert.anchor_tx, enclavePublicKey: v.enclavePublicKey },
      });
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(id)) return c.json({ error: "no decision, certificate or transaction with this id" }, 404);
    const tx = await fetchTx(id).catch(() => null);
    if (!tx) return c.json({ error: "no decision, certificate or transaction with this id" }, 404);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const statuses = [tx.execution_outcome.outcome.status, ...tx.receipts.map((r) => r.execution_outcome.outcome.status)];
    checks.push({ name: "Transaction succeeded", ok: !statuses.some(failed), detail: `${tx.transaction.signer_id} → ${tx.transaction.receiver_id}` });
    const history = await keyHistory();
    const logs = tx.receipts.flatMap((r) => r.execution_outcome.outcome.logs);
    let linked: Record<string, unknown> = {};
    for (const a of tx.transaction.actions) {
      const call = typeof a === "object" ? a.FunctionCall : undefined;
      if (!call) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(Buffer.from(call.args, "base64").toString()) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (call.method_name === "submit" && tx.transaction.receiver_id === contract("risk") && typeof args.report_json === "string" && typeof args.signature === "string") {
        const report = JSON.parse(args.report_json) as { kind?: string; at?: number; hash?: string; id?: string };
        const key = enclaveKeyAt(history, report.at ?? 0);
        const digest = sha256(utf8ToBytes(`parry-risk:v1:${args.report_json}`));
        checks.push({ name: "Enclave signature on the report", ok: !!key && verifyEd25519(args.signature, digest, key), detail: `${report.kind} report, key ${key ?? "unknown"} in force at ${report.at}` });
        linked = { report: report.kind, runId: (report as { run_id?: number }).run_id ?? null, ...(report.kind === "certificate" ? { certificate: report.hash } : {}), ...(report.kind === "decision" ? { decision: report.id } : {}) };
      }
      if (call.method_name === "guardian_execute" && typeof args.envelope === "string" && typeof args.signature === "string") {
        const env = JSON.parse(args.envelope) as { issued_at?: number; review_hash?: string };
        const key = enclaveKeyAt(history, env.issued_at ?? 0);
        checks.push({ name: "Enclave signature on the envelope", ok: !!key && verifyEd25519(args.signature, envelopeDigest(args.envelope), key), detail: `key ${key ?? "unknown"} in force at ${env.issued_at}` });
        const acted = logs.map((l) => (l.startsWith("EVENT_JSON:") ? (JSON.parse(l.slice(11)) as { event: string; data: { review_hash?: string } }) : null)).find((e) => e?.event === "guardian_acted");
        checks.push({ name: "Review hash on chain", ok: !!acted && acted.data.review_hash === env.review_hash, detail: acted ? `the account emitted ${acted.data.review_hash}` : "no guardian_acted event" });
        const decisionId = Buffer.from(sha256(utf8ToBytes(args.envelope))).toString("hex");
        const [row] = await sql<DecisionRow[]>`SELECT * FROM decisions WHERE id = ${decisionId}`;
        if (row) {
          const v = await verifyDecisionRecord(row);
          checks.push(...v.checks.filter((x) => !checks.some((y) => y.name === x.name)));
        }
        linked = { decision: decisionId, account: tx.transaction.receiver_id };
      }
    }
    if (checks.length === 1) checks.push({ name: "Parry record", ok: false, detail: "this transaction carries no enclave-signed report or envelope" });
    return c.json({ kind: "transaction", ok: checks.every((x) => x.ok), checks, subject: { txHash: id, signer: tx.transaction.signer_id, receiver: tx.transaction.receiver_id, ...linked } });
  });

  // ------------------------------------------------------------------ watched accounts
  type WatchRowDb = { account: string; label: string | null; thresholds: { score: number; health: number } };
  const watchRow = async (w: WatchRowDb) => {
    const rows = await sql<PositionRow[]>`SELECT * FROM positions WHERE account = ${w.account} ORDER BY score DESC`;
    let p = rows[0] ? position(rows[0]) : null;
    if (!p) {
      // Not read by the monitor yet: read it once now (cached for 30 s).
      p = await cached(`watch-live:${w.account}`, 30_000, async () => {
        const { near } = await oraclePrices();
        const r = near === null ? null : await readRhea(w.account, near).catch(() => null);
        if (!r || near === null) return null;
        const { assess } = await import("@parry/core");
        const a = assess(r.position, near, [], Date.now() / 1000);
        return { id: `${w.account}:rhea:main`, account: w.account, venue: "rhea", label: "Rhea wNEAR/USDC", collateralUsd: r.collateralUsd, debtUsd: r.debtUsd, health: Number.isFinite(a.health) ? a.health : null,
          liqPrice: a.liqPrice, distance: a.distance, score: a.score.score, tier: a.score.tier, probability24h: a.probability24h, ttlHours: a.ttl.medianHours, valueAtRisk99: a.valueAtRisk99, updatedAt: new Date().toISOString() };
      });
    }
    const alert = p
      ? alertsFor({ id: p.id, label: `${w.label ?? w.account}: ${p.label}` }, { score: p.score, tier: p.tier as never, health: p.health ?? Infinity, ttlHours: p.ttlHours }, { ...DEFAULT_THRESHOLDS, ...w.thresholds }).map((a) => ({
          kind: a.kind,
          severity: a.severity,
          title: a.title,
          body: a.body,
        }))
      : [];
    return { account: w.account, label: w.label, thresholds: w.thresholds, position: p, alert };
  };

  app.get("/v1/watch", async (c) => {
    const who = await h.signedIn(c);
    const rows = await sql<WatchRowDb[]>`SELECT account, label, thresholds FROM watched WHERE owner = ${who} ORDER BY created_at`;
    return c.json(await Promise.all(rows.map(watchRow)));
  });

  app.put("/v1/watch/:accountId", async (c) => {
    const who = await h.signedIn(c);
    const target = h.account(c.req.param("accountId"));
    const b = await h.body<{ thresholds?: { score?: number; health?: number }; label?: string | null }>(c);
    const t = b.thresholds;
    const ok = !!t && typeof t === "object" && Number.isFinite(t.score) && t.score! >= 0 && t.score! <= 100 && Number.isFinite(t.health) && t.health! > 1 && t.health! <= 5;
    if (!ok) throw h.bad("thresholds are { score 0 to 100, health above 1 up to 5 }");
    if (b.label !== undefined && b.label !== null && (typeof b.label !== "string" || b.label.length > 64)) throw h.bad("label is text of at most 64 characters");
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM watched WHERE owner = ${who} AND account <> ${target}`;
    if ((n?.n ?? 0) >= WATCH_LIMIT) throw h.bad(`at most ${WATCH_LIMIT} watched accounts`);
    const thresholds = { score: t!.score!, health: t!.health! };
    const [row] = await sql<WatchRowDb[]>`INSERT INTO watched (owner, account, label, thresholds) VALUES (${who}, ${target}, ${b.label ?? null}, ${sql.json(thresholds)})
      ON CONFLICT (owner, account) DO UPDATE SET thresholds = excluded.thresholds, label = COALESCE(excluded.label, watched.label), updated_at = now() RETURNING account, label, thresholds`;
    return c.json(await watchRow(row!));
  });

  app.delete("/v1/watch/:accountId", async (c) => {
    const who = await h.signedIn(c);
    const [row] = await sql`DELETE FROM watched WHERE owner = ${who} AND account = ${h.account(c.req.param("accountId"))} RETURNING account`;
    return row ? c.json({ ok: true }) : c.json({ error: "not watched" }, 404);
  });

  // ------------------------------------------------------------------ certificates
  app.post("/v1/certificates", async (c) => {
    const who = await h.signedIn(c);
    const b = await h.body<Record<string, unknown>>(c);
    try {
      const input = checkInput(b as never);
      if (input.account !== who) throw new CertificateError("sign in as the account to certify", 401);
      return c.json(await issueCertificate(sql, input, who));
    } catch (e) {
      if (e instanceof CertificateError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  });

  app.get("/v1/certificates", async (c) => {
    const acct = h.account(c.req.query("account"));
    const rows = await sql<CertificateRow[]>`SELECT * FROM certificates WHERE account = ${acct} ORDER BY created_at DESC LIMIT 100`;
    return c.json(rows.map(certificateView));
  });

  app.get("/v1/certificates/:hash", async (c) => {
    const [row] = await sql<CertificateRow[]>`SELECT * FROM certificates WHERE hash = ${c.req.param("hash").toLowerCase()}`;
    return row ? c.json(certificateView(row)) : c.json({ error: "no such certificate" }, 404);
  });

  // ------------------------------------------------------------------ route savings
  app.get("/v1/routes/savings", async (c) => {
    const acct = c.req.query("account");
    if (acct !== undefined) h.account(acct);
    const rows = await sql<{ id: string; routes: StoredRoutes; created_at: Date }[]>`SELECT id, routes, created_at FROM decisions
      WHERE routes IS NOT NULL AND (${acct ?? null}::text IS NULL OR account = ${acct ?? null}) ORDER BY created_at DESC LIMIT 200`;
    const rescues = rows.map((r) => ({ decision: r.id, ...routeSaving(r.routes), at: r.created_at.toISOString() }));
    return c.json({ totalSavedUsd: rescues.reduce((s, r) => s + r.savedUsd, 0), rescues });
  });

  // ------------------------------------------------------------------ vault insurance
  app.get("/v1/vault/insurance", async (c) => {
    const ins = await insuranceOf();
    const events = await sql<{ event: string; data: Record<string, unknown>; block_time: Date | null; tx_hash: string }[]>`SELECT event, data, block_time, tx_hash FROM events
      WHERE contract = ${contract("vault")} AND event IN ('insurance_inflow', 'insurance_paid') ORDER BY block_height DESC LIMIT 100`;
    return c.json({
      available: ins !== null,
      shareBps: ins?.share_bps ?? null,
      linear: ins?.linear ?? "0",
      usdcE6: ins?.usdc_e6 ?? "0",
      valueUsdE6: ins?.value_usd_e6 ?? "0",
      paidTotalE6: ins?.paid_total_e6 ?? "0",
      paidTodayE6: ins?.paid_today_e6 ?? "0",
      capPerDayBps: ins?.cap_per_day_bps ?? null,
      marginReservedUsdE6: ins?.margin_reserved_usd_e6 ?? "0",
      events: events.map((e) => ({ kind: e.event === "insurance_inflow" ? "inflow" : "payout", at: e.block_time?.toISOString() ?? null, tx: e.tx_hash, ...e.data })),
      source: ins ? `${contract("vault")} insurance() and its insurance events` : `${contract("vault")} has no insurance() view yet`,
    });
  });

  // ------------------------------------------------------------------ incidents
  app.get("/v1/incidents", async (c) => {
    const acct = c.req.query("account");
    if (!acct) return c.json({ error: "account is required" }, 400);
    h.account(acct);
    const incidents = await sql<{ id: string; account: string; title: string; body: string; severity: string; opened_at: Date; closed_at: Date | null }[]>`
      SELECT * FROM incidents WHERE account = ${acct} ORDER BY opened_at DESC LIMIT 50`;
    const ids = incidents.map((i) => i.id);
    const alerts = ids.length
      ? await sql<(Parameters<typeof alertView>[0] & { incident_id: string })[]>`SELECT * FROM alerts WHERE incident_id = ANY(${ids}) ORDER BY id`
      : [];
    return c.json(
      incidents.map((i) => ({
        id: String(i.id),
        account: i.account,
        title: i.title,
        body: i.body,
        severity: i.severity,
        alerts: alerts.filter((a) => String(a.incident_id) === String(i.id)).map(alertView),
        openedAt: i.opened_at.toISOString(),
        closedAt: i.closed_at?.toISOString() ?? null,
      })),
    );
  });

  // ------------------------------------------------------------------ live updates
  const hub = new StreamHub(sql);
  app.get("/v1/stream", (c) => {
    const raw = c.req.query("events");
    const events = (raw ? raw.split(",").map((e) => e.trim()) : [...STREAM_EVENTS]) as StreamEvent[];
    const unknown = events.filter((e) => !(STREAM_EVENTS as readonly string[]).includes(e));
    if (unknown.length) throw h.bad(`unknown events: ${unknown.join(", ")}; the events are ${STREAM_EVENTS.join(", ")}`);
    const acct = c.req.query("account");
    return hub.connect({ events, account: acct ? h.account(acct) : null, signal: c.req.raw.signal });
  });
  return hub;
}
