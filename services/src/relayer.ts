/**
 * Relayer: pays gas so people need no NEAR. It creates protected accounts through the factory,
 * relays passkey-signed owner requests, and relays NEP-366 delegate actions from NEAR wallets.
 * Everything it relays is checked against an allowlist (Parry accounts and contracts only) and a
 * daily budget, and it transacts on gas-key lanes so requests do not queue behind each other.
 */

import { decodeSignedDelegateAction } from "near-kit";
import { contract, intEnv, network, NEAR_USD } from "./lib/config";
import { db, migrate, setStatus, useQuota, type Sql } from "./lib/db";
import { serveHealth } from "./lib/health";
import { errorText, log } from "./lib/log";
import { senderFromEnv, txHash, view, yocto } from "./lib/near";
import { derivedAddress, PATH_EVM, PATH_HYPERLIQUID } from "./lib/positions";

const relayer = senderFromEnv("RELAYER");

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

async function isParryAccount(sql: Sql, account: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM accounts WHERE account = ${account}`;
  return !!row;
}

export async function createAccount(sql: Sql, body: { passkey?: string; nearAccount?: string }, ip: string) {
  if (!relayer) throw new Error("the relayer wallet is not configured");
  const owner = body.passkey ?? body.nearAccount;
  if (!owner || (body.passkey && body.nearAccount)) throw new Error("give exactly one of passkey or nearAccount");
  if (!(await useQuota(sql, "create-account", "all", intEnv("RELAYER_DAILY_ACCOUNTS", 50)))) throw new Error("the relayer's daily account budget is spent; try again tomorrow");
  if (!(await useQuota(sql, "create-account-ip", ip, intEnv("RELAYER_ACCOUNTS_PER_IP", 3)))) throw new Error("too many accounts from this address today");
  const args = body.passkey ? { passkey: body.passkey } : { near_account: body.nearAccount };
  const accountId = await view<string>(contract("factory"), "account_id_of", args);
  const o = await relayer.call({ receiverId: contract("factory"), methodName: "create_account", args, deposit: yocto(Number(process.env.RELAYER_ACCOUNT_DEPOSIT ?? 0.3)), tgas: 250 });
  const [hl, evm] = await Promise.all([derivedAddress(accountId, PATH_HYPERLIQUID).catch(() => null), derivedAddress(accountId, PATH_EVM).catch(() => null)]);
  await sql`INSERT INTO accounts (account, owner_kind, owner_id, hl_address, evm_address, created_tx) VALUES (${accountId}, ${body.passkey ? "passkey" : "near"}, ${owner}, ${hl}, ${evm}, ${txHash(o)})
    ON CONFLICT (account) DO NOTHING`;
  return { accountId, txHash: txHash(o) };
}

async function owner(sql: Sql, body: { account: string; request: string; assertion: unknown }) {
  if (!relayer) throw new Error("the relayer wallet is not configured");
  if (!(await isParryAccount(sql, body.account))) throw new Error("not a Parry protected account");
  if (!(await useQuota(sql, "owner", body.account, intEnv("RELAYER_OWNER_PER_DAY", 60)))) throw new Error("this account's daily relay budget is spent");
  const o = await relayer.call({ receiverId: body.account, methodName: "owner_execute", args: { request: body.request, assertion: body.assertion }, tgas: 300 });
  return { txHash: txHash(o) };
}

/** What a NEAR-wallet owner may have relayed: calls on their Parry account, the vault, or a test USDC transfer. */
export async function checkDelegate(sql: Sql, payload: string): Promise<{ sender: string; receiver: string }> {
  const d = decodeSignedDelegateAction(payload).signedDelegate.delegateAction;
  const receiver = d.receiverId;
  const allowed = (await isParryAccount(sql, receiver)) || receiver === contract("vault") || receiver === contract("usdc") || receiver === contract("factory");
  if (!allowed) throw new Error("the relayer pays only for Parry accounts and contracts");
  return { sender: d.senderId, receiver };
}

async function delegate(sql: Sql, body: { payload?: string; signedDelegateAction?: string }) {
  if (!relayer) throw new Error("the relayer wallet is not configured");
  const payload = body.payload ?? body.signedDelegateAction;
  if (!payload) throw new Error("send the signed delegate action as base64 borsh");
  const { sender } = await checkDelegate(sql, payload);
  if (!(await useQuota(sql, "delegate", sender, intEnv("RELAYER_DELEGATE_PER_DAY", 60)))) throw new Error("this account's daily relay budget is spent");
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
  if (!(await useQuota(sql, "shock", ip, intEnv("SHOCKS_PER_IP", 20)))) throw new Error("too many shocks from this address today");
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
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
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
      return fail(errorText(e));
    }
  };
  serveHealth("relayer", intEnv("PORT", 4500), async () => ({ ok: !!relayer, detail: relayer ? last : "RELAYER wallet is not configured", lanes: relayer?.lanes ?? 0, inFlight: relayer?.inFlight ?? 0 }), handle);
}
