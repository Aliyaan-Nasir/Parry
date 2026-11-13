/**
 * Relayer: pays gas so people need no NEAR. It creates protected accounts through the factory,
 * relays passkey-signed owner requests, and relays NEP-366 delegate actions from NEAR wallets.
 * Everything it relays is checked against an allowlist (Parry accounts and contracts only) and a
 * daily budget, and it transacts on gas-key lanes so requests do not queue behind each other.
 */

import { decodeSignedDelegateAction } from "near-kit";
import { contract, intEnv, network, NEAR_USD } from "./lib/config";
import { db, migrate, setStatus, useQuota, type Sql } from "./lib/db";
import { every, serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";
import { balanceOf, returnValue, senderFromEnv, tendGasKey, toNear, txHash, view, yocto } from "./lib/near";
import { derivedAddress, PATH_EVM, PATH_HYPERLIQUID } from "./lib/positions";

const relayer = senderFromEnv("RELAYER");

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);
/** A spent budget or rate limit: answered with 429, not 400. */
const limited = (message: string) => Object.assign(new Error(message), { status: 429 });

async function isParryAccount(sql: Sql, account: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM accounts WHERE account = ${account}`;
  return !!row;
}

export async function createAccount(sql: Sql, body: { passkey?: string; nearAccount?: string }, ip: string) {
  if (!relayer) throw new Error("the relayer wallet is not configured");
  const owner = body.passkey ?? body.nearAccount;
  if (!owner || (body.passkey && body.nearAccount)) throw new Error("give exactly one of passkey or nearAccount");
  // A drained wallet fails on chain with an opaque RPC error; say so before spending anyone's quota (top-up refills it).
  const deposit = Number(process.env.RELAYER_ACCOUNT_DEPOSIT ?? 0.3);
  if (toNear((await balanceOf(relayer.accountId)) ?? 0n) < deposit + 0.1) throw Object.assign(new Error("the relayer is being refilled; try again in a few minutes"), { status: 503 });
  if (!(await useQuota(sql, "create-account", "all", intEnv("RELAYER_DAILY_ACCOUNTS", 50)))) throw limited("the relayer's daily account budget is spent; try again tomorrow");
  if (!(await useQuota(sql, "create-account-ip", ip, intEnv("RELAYER_ACCOUNTS_PER_IP", 3)))) throw limited("too many accounts from this address today");
  const args = body.passkey ? { passkey: body.passkey } : { near_account: body.nearAccount };
  const accountId = await view<string>(contract("factory"), "account_id_of", args);
  const o = await relayer.call({ receiverId: contract("factory"), methodName: "create_account", args, deposit: yocto(deposit), tgas: 250 });
  const [hl, evm] = await Promise.all([derivedAddress(accountId, PATH_HYPERLIQUID).catch(() => null), derivedAddress(accountId, PATH_EVM).catch(() => null)]);
  await sql`INSERT INTO accounts (account, owner_kind, owner_id, hl_address, evm_address, created_tx) VALUES (${accountId}, ${body.passkey ? "passkey" : "near"}, ${owner}, ${hl}, ${evm}, ${txHash(o)})
    ON CONFLICT (account) DO NOTHING`;
  return { accountId, txHash: txHash(o) };
}

/** Protocol tokens assumed for an unwind's gas (testnet lists two; the account's `protocol()` has the count). */
const PROTOCOL_TOKENS = 3;

/**
 * The gas a relayed owner request needs. The account refuses a close or an unwind sent with less
 * than its whole promise chain needs: `close_rhea` 750 + 30 per protocol token Tgas (sent 900), an
 * unwind 160 + 130 per protocol token + 25 per listed token (sent with 60 more, at least 600);
 * everything else fits in 300. One call may carry up to 1 PGas.
 */
export function ownerRequestTgas(request: string): number {
  let actions: unknown;
  try {
    actions = (JSON.parse(request) as { actions?: unknown }).actions;
  } catch {
    return 300;
  }
  let tgas = 300;
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== "object") continue;
    if ("close_rhea" in a) tgas = Math.max(tgas, 900);
    if ("unwind" in a) {
      const tokens = (a as { unwind?: { tokens?: unknown } }).unwind?.tokens;
      const n = Array.isArray(tokens) ? tokens.length : 0;
      tgas = Math.max(tgas, Math.min(1000, Math.max(600, 160 + 130 * PROTOCOL_TOKENS + 25 * n + 60)));
    }
  }
  return tgas;
}

/**
 * NEAR the gas key must hold before it prepays `tgas`: prepaid gas is checked against the
 * pessimistic gas price, about 0.00117 NEAR per Tgas on testnet (0.35 NEAR for 300 Tgas).
 */
export const prepaidNear = (tgas: number): number => tgas * 0.0012 + 0.1;

/** Tops the gas key up before a call above 300 Tgas, so a close or unwind is not refused for its prepaid gas. */
async function ensureGasKeyFor(tgas: number): Promise<void> {
  if (!relayer || tgas <= 300) return;
  const need = prepaidNear(tgas);
  const detail = await relayer.refillGasKey(need, need + 0.5);
  if (detail.includes("too low")) log.warn("the relayer's gas key may not cover a large call", { tgas, detail });
}

async function owner(sql: Sql, body: { account: string; request: string; assertion: unknown }) {
  if (!relayer) throw new Error("the relayer wallet is not configured");
  if (!(await isParryAccount(sql, body.account))) throw new Error("not a Parry protected account");
  if (typeof body.request !== "string") throw new Error("send the owner request as its exact text");
  if (!(await useQuota(sql, "owner", body.account, intEnv("RELAYER_OWNER_PER_DAY", 60)))) throw limited("this account's daily relay budget is spent");
  const tgas = ownerRequestTgas(body.request);
  await ensureGasKeyFor(tgas);
  const o = await relayer.call({ receiverId: body.account, methodName: "owner_execute", args: { request: body.request, assertion: body.assertion }, tgas });
  // The account's answer travels back: a signing action returns its `{ r, s, v }`, which the owner
  // then sends to Hyperliquid or the EVM chain.
  return { txHash: txHash(o), value: returnValue<unknown>(o) ?? null };
}

/** What a NEAR-wallet owner may have relayed: calls on their Parry account, the vault, or a test USDC transfer. */
export async function checkDelegate(sql: Sql, payload: string): Promise<{ sender: string; receiver: string; tgas: number }> {
  const d = decodeSignedDelegateAction(payload).signedDelegate.delegateAction;
  const receiver = d.receiverId;
  const allowed = (await isParryAccount(sql, receiver)) || receiver === contract("vault") || receiver === contract("usdc") || receiver === contract("factory");
  if (!allowed) throw new Error("the relayer pays only for Parry accounts and contracts");
  return { sender: d.senderId, receiver, tgas: delegateTgas(d.actions) };
}

/** The gas the delegate's function calls prepay, in Tgas (the relayer's transaction prepays it). */
export function delegateTgas(actions: readonly unknown[]): number {
  let gas = 0n;
  for (const a of actions) {
    const fc = (a as { functionCall?: { gas?: bigint | number | string } }).functionCall;
    if (fc?.gas !== undefined) gas += BigInt(fc.gas);
  }
  return Number(gas / 1_000_000_000_000n);
}

async function delegate(sql: Sql, body: { payload?: string; signedDelegateAction?: string }) {
  if (!relayer) throw new Error("the relayer wallet is not configured");
  const payload = body.payload ?? body.signedDelegateAction;
  if (!payload) throw new Error("send the signed delegate action as base64 borsh");
  const { sender, tgas } = await checkDelegate(sql, payload);
  if (!(await useQuota(sql, "delegate", sender, intEnv("RELAYER_DELEGATE_PER_DAY", 60)))) throw limited("this account's daily relay budget is spent");
  await ensureGasKeyFor(tgas);
  const o = await relayer.relayDelegate(payload);
  return { txHash: txHash(o) };
}

/**
 * Testnet market shock for people without a NEAR wallet: the oracle itself bounds and rate limits
 * it. `bps: 0` clears the active shock.
 */
async function shock(sql: Sql, body: { bps: number }, ip: string) {
  if (network !== "testnet") throw new Error("the market shock exists only on testnet");
  if (!relayer) throw new Error("the relayer wallet is not configured");
  const bps = Math.trunc(Number(body.bps));
  if (!Number.isFinite(bps)) throw new Error("bps must be an integer (0 clears the shock)");
  if (!(await useQuota(sql, "shock", ip, intEnv("SHOCKS_PER_IP", 20)))) throw limited("too many shocks from this address today");
  const o = await relayer.call({ receiverId: contract("oracle"), methodName: bps === 0 ? "reset_shock" : "shock", args: bps === 0 ? { price_id: NEAR_USD } : { price_id: NEAR_USD, bps }, tgas: 30 });
  const s = await view<unknown>(contract("oracle"), "shock_of", { price_id: NEAR_USD });
  return { txHash: txHash(o), shock: s };
}

export async function main() {
  const sql = db();
  await migrate(sql);
  let last = "idle";
  const handle = async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (req.method !== "POST") return null;
    // The right-most entry: the one the reverse proxy in front of the API appended.
    const ip = req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean).pop() ?? "local";
    const body = await req.json().catch(() => ({}));
    try {
      const routes: Record<string, () => Promise<unknown>> = {
        "/create-account": () => createAccount(sql, body, ip),
        "/owner": () => owner(sql, body),
        "/delegate": () => delegate(sql, body),
        "/shock": () => shock(sql, body, ip),
      };
      const f = routes[url.pathname];
      if (!f) return null;
      const out = await f();
      last = `${url.pathname} ok`;
      await setStatus(sql, "relayer", true, last);
      return json(out);
    } catch (e) {
      log.warn("relay refused", { path: url.pathname, error: errorText(e) });
      return fail(errorText(e), (e as { status?: number }).status ?? 400);
    }
  };
  every(600_000, "gas-key", () => tendGasKey(sql, "relayer", relayer));
  // An idle relayer still reports, so the status page does not count it as down between requests.
  every(60_000, "status", () => setStatus(sql, "relayer", !!relayer, relayer ? `${last}; ${relayer.inFlight} in flight on ${relayer.lanes} lanes` : "RELAYER wallet is not configured"));
  serveHealth("relayer", intEnv("PORT", 4500), async () => ({ ok: !!relayer, detail: relayer ? last : "RELAYER wallet is not configured", lanes: relayer?.lanes ?? 0, inFlight: relayer?.inFlight ?? 0 }), handle);
}
