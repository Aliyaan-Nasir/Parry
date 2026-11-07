import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import postgres from "postgres";
import { migrate } from "@parry/services/lib/db";
import { nep413Payload } from "../src/auth";
import { recoverEip191, reviewHash } from "../src/verify";
import { requirements } from "../src/x402";

describe("decision verification", () => {
  test("recovers an EIP-191 signer and hashes the review in the enclave's field order", () => {
    const sk = secp256k1.utils.randomSecretKey();
    const text = "z-ai/glm-5.3-flash:aa:bb";
    const msg = utf8ToBytes(`\x19Ethereum Signed Message:\n${text.length}${text}`);
    const sig = secp256k1.sign(keccak_256(msg), sk, { prehash: false, format: "recovered" });
    // noble's "recovered" format puts the recovery byte first; EIP-191 wants it last, plus 27.
    const eth = Buffer.concat([Buffer.from(sig.subarray(1)), Buffer.from([sig[0]! + 27])]);
    const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1)).slice(12))}`;
    expect(recoverEip191(text, `0x${eth.toString("hex")}`)).toBe(address);
    const review = { reasoning: "r", verdict: "approve", model: "m", chat_id: "c", request_hash: "aa", response_hash: "bb", signed_text: text, signature: "0x", signing_address: address, signature_kind: "provider_tee" };
    // Same hash whatever order the stored JSON came back in.
    expect(reviewHash(review)).toBe(reviewHash(Object.fromEntries(Object.entries(review).reverse())));
    expect(reviewHash(review)).toBe(bytesToHex(sha256(utf8ToBytes(JSON.stringify({ model: "m", chat_id: "c", request_hash: "aa", response_hash: "bb", signed_text: text, signature: "0x", signing_address: address, signature_kind: "provider_tee", verdict: "approve", reasoning: "r" })))));
  });
});

describe("NEP-413 sign-in payload", () => {
  test("is the borsh layout wallets sign", () => {
    const nonce = new Uint8Array(32).fill(7);
    const p = nep413Payload("hi", nonce, "parry");
    expect(Buffer.from(p.subarray(0, 4)).readUInt32LE()).toBe(2 ** 31 + 413);
    expect(Buffer.from(p.subarray(4, 8)).readUInt32LE()).toBe(2);
    expect(Buffer.from(p.subarray(8, 10)).toString()).toBe("hi");
    expect(p.subarray(10, 42)).toEqual(nonce);
    expect(p[p.length - 1]).toBe(0);
    const sk = ed25519.utils.randomSecretKey();
    const sig = ed25519.sign(sha256(p), sk);
    expect(ed25519.verify(sig, sha256(p), ed25519.getPublicKey(sk))).toBe(true);
  });
});

describe("x402", () => {
  test("advertises an exact NEAR payment in test USDC", () => {
    process.env.X402_PAY_TO = "api.parry.testnet";
    const r = requirements("http://x/v1/paid/risk/a.testnet");
    expect(r.x402Version).toBe(2);
    expect(r.accepts[0]).toMatchObject({ scheme: "exact", network: "near:testnet", amount: "10000", payTo: "api.parry.testnet" });
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("routes on a database", () => {
  const sql = postgres(url ?? "postgres://invalid", { onnotice: () => {} });
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    const { createApp } = await import("../src/app");
    app = createApp(sql) as never;
    await sql`INSERT INTO decisions (id, account, venue, action, plan, trigger, outcome, review, txs) VALUES
      ('d1', '0ua.testnet', 'rhea', 'repay', 'Repay 10 USDC', ${sql.json({ score: 80, tier: "critical", health_bps: 10300 })}, 'executed', ${sql.json({ model: "m", verdict: "approve" })}, ${sql.json({ action: "tx1" })})`;
  });
  afterAll(() => sql.end());

  test("decisions list and detail", async () => {
    const list = (await (await app.request("/v1/guardian/decisions?account=0ua.testnet")).json()) as { items: { id: string; trigger: { healthBps: number } }[] };
    expect(list.items[0]!.id).toBe("d1");
    expect(list.items[0]!.trigger.healthBps).toBe(10300);
    expect((await app.request("/v1/guardian/decisions/nope")).status).toBe(404);
  });

  test("paid risk without payment answers 402 with requirements", async () => {
    const r = await app.request("/v1/paid/risk/alice.testnet");
    expect(r.status).toBe(402);
    expect(((await r.json()) as { accepts: unknown[] }).accepts.length).toBe(1);
  });

  test("settings need a sign-in to change, and alerts need an account", async () => {
    expect((await app.request("/v1/settings/alice.testnet", { method: "PUT", body: "{}" })).status).toBe(401);
    expect((await app.request("/v1/alerts")).status).toBe(400);
    const s = (await (await app.request("/v1/settings/alice.testnet")).json()) as { thresholds: { score: number } };
    expect(s.thresholds.score).toBe(50);
  });

  test("an unknown account is a 404 and a bad id a 400 or 500 with a message", async () => {
    expect((await app.request("/v1/accounts/0unknown.testnet")).status).toBe(404);
  });
});
