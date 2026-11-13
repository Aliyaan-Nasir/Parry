/**
 * Sign-in for the few writes that change a person's own data (settings, alert state, push).
 * The person signs a server nonce with what owns their protected account on chain: the NEAR
 * account's full-access key (NEP-413, recipient "parry") or the passkey (a WebAuthn assertion
 * whose challenge is SHA-256 of the message). The API checks against the account's `owner()`.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import type { Sql } from "@parryguard/services/lib/db";
import { rpc, view } from "@parryguard/services/lib/near";

/**
 * NEP-413's signed payload: borsh of (u32 tag 2^31 + 413, message, 32-byte nonce, recipient,
 * no callback URL); the wallet signs its SHA-256.
 */
export function nep413Payload(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return Buffer.concat([tag, str(message), Buffer.from(nonce), str(recipient), Buffer.from([0])]);
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export async function challenge(sql: Sql, accountId: string) {
  const nonce = hex(randomBytes(32));
  const message = `Sign in to Parry as ${accountId}. Nonce ${nonce}.`;
  await sql`INSERT INTO auth_challenges (nonce, account, message, expires_at) VALUES (${nonce}, ${accountId}, ${message}, now() + interval '5 minutes')`;
  return { nonce, message, recipient: "parry" };
}

type Owner = { near?: { account_id: string }; passkey?: { key: number[] } };

export interface Proof {
  accountId: string;
  nonce: string;
  nep413?: { publicKey: string; signature: string };
  passkey?: { authenticator_data: string; client_data_json: string; signature: string };
}

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BS58.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export async function verify(sql: Sql, p: Proof): Promise<string> {
  const [c] = await sql<{ message: string }[]>`DELETE FROM auth_challenges WHERE nonce = ${p.nonce} AND account = ${p.accountId} AND expires_at > now() RETURNING message`;
  if (!c) throw new Error("unknown or expired challenge");
  // An account the factory has not created yet has no owner to check: say so, not the RPC's code.
  const owner = await view<Owner>(p.accountId, "owner").catch((e: Error) => {
    throw /UNKNOWN_ACCOUNT|NoContractCode|CodeDoesNotExist/.test(e.message) ? new Error(`${p.accountId} is not created yet: create the protected account first`) : e;
  });
  if (owner.near && p.nep413) {
    // The key must be a full-access key of the owning NEAR account right now.
    const key = await rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "optimistic", account_id: owner.near.account_id, public_key: p.nep413.publicKey }).catch(() => null);
    if (!key || key.permission !== "FullAccess") throw new Error("that key is not a full-access key of the owner");
    const payload = nep413Payload(c.message, Buffer.from(p.nonce, "hex"), "parry");
    const sig = Buffer.from(p.nep413.signature, "base64");
    const pk = bs58(p.nep413.publicKey.replace(/^ed25519:/, ""));
    if (!ed25519.verify(sig, sha256(payload), pk)) throw new Error("NEP-413 signature does not verify");
  } else if (owner.passkey && p.passkey) {
    const client = JSON.parse(p.passkey.client_data_json) as { type: string; challenge: string };
    if (client.type !== "webauthn.get" || client.challenge !== b64url(sha256(new TextEncoder().encode(c.message)))) throw new Error("assertion is for another challenge");
    const auth = Buffer.from(p.passkey.authenticator_data, "base64url");
    const signed = sha256(Buffer.concat([auth, Buffer.from(sha256(new TextEncoder().encode(p.passkey.client_data_json)))]));
    if (!p256.verify(Buffer.from(p.passkey.signature, "hex"), signed, Uint8Array.from(owner.passkey.key), { prehash: false })) throw new Error("passkey signature does not verify");
  } else {
    throw new Error("sign with what owns the account");
  }
  const token = hex(randomBytes(32));
  await sql`INSERT INTO auth_sessions (token, account, expires_at) VALUES (${token}, ${p.accountId}, now() + interval '12 hours')`;
  return token;
}

/** The account a bearer token signs in as, or null. */
export async function session(sql: Sql, header: string | undefined): Promise<string | null> {
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const [s] = await sql<{ account: string }[]>`SELECT account FROM auth_sessions WHERE token = ${token} AND expires_at > now()`;
  return s?.account ?? null;
}
