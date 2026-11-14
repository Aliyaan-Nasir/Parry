import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import postgres from "postgres";
import { migrate } from "@parryguard/services/lib/db";
import { nep413Payload } from "../src/auth";
import { recoverEip191, reviewHash } from "../src/verify";
import { DelegateAction, parsePublicKey, serializeDelegateAction } from "near-kit";
import { Hono } from "hono";
import { decodePaymentRequired, decodePaymentResponse, encodePaymentHeader, toBase58, type PaymentRequired } from "@parryguard/sdk";
import { paidRisk, requirement, requirements, resourceUrl, type PaidDeps } from "../src/x402";

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
  process.env.X402_PAY_TO = "api.parry.testnet";
  const PROXIED = { "x-forwarded-proto": "https", "x-forwarded-host": "api.parry.market" };
  const RESOURCE = "https://api.parry.market/v1/paid/risk/alice.testnet";
  const payerSeed = sha256(utf8ToBytes("x402 payer"));
  const payerKey = `ed25519:${toBase58(ed25519.getPublicKey(payerSeed))}`;

  /** A signed delegate `ft_transfer`, encoded as borsh(DelegateAction) ++ ed25519 signature. */
  const delegate = (amount = "10000", maxBlockHeight = 1_120n) => {
    const req = requirement();
    const args = utf8ToBytes(JSON.stringify({ receiver_id: req.payTo, amount }));
    const actions = [{ functionCall: { methodName: "ft_transfer", args, gas: 30_000_000_000_000n, deposit: 1n } }];
    const signed = serializeDelegateAction(new DelegateAction("agent.parry.testnet", req.asset, actions as never, 42n, maxBlockHeight, parsePublicKey(payerKey)));
    return Buffer.concat([signed.subarray(4), Buffer.from([0]), ed25519.sign(sha256(signed), payerSeed)]).toString("base64");
  };

  const harness = (over: Partial<PaidDeps> = {}) => {
    const relayed: string[] = [];
    const recorded: unknown[] = [];
    const deps: PaidDeps = {
      checkOnChain: async () => ({ ok: true, blockHeight: 1_000n }),
      relay: async (d) => (relayed.push(d), { txHash: "paidTx1" }),
      record: async (p) => void recorded.push(p),
      ...over,
    };
    const app = new Hono();
    app.get("/v1/paid/risk/:id", (c) => paidRisk(c, null as never, async () => ({ account: c.req.param("id") }), deps));
    const call = (headers: Record<string, string> = {}) => app.request("http://localhost:4000/v1/paid/risk/alice.testnet", { headers: { ...PROXIED, ...headers } });
    return { call, relayed, recorded };
  };
  const v2 = (signedDelegateAction = delegate(), resource = RESOURCE) =>
    encodePaymentHeader({ x402Version: 2, resource: { url: resource }, accepted: requirement(), payload: { signedDelegateAction } });

  test("advertises an exact NEAR payment in test USDC, in x402 v2's shape", () => {
    const r = requirements("https://api.parry.market/v1/paid/risk/a.testnet");
    expect(r.x402Version).toBe(2);
    expect(r.resource).toMatchObject({ url: "https://api.parry.market/v1/paid/risk/a.testnet", mimeType: "application/json" });
    expect(r.accepts[0]).toEqual({ scheme: "exact", network: "near:testnet", asset: requirement().asset, amount: "10000", payTo: "api.parry.testnet", maxTimeoutSeconds: 240 });
  });

  test("the resource is the public https URL behind the proxy, with path and query", () => {
    const h = (headers: Record<string, string>) => (name: string) => headers[name];
    const url = "http://localhost:4000/v1/paid/risk/a.testnet?x=1";
    expect(resourceUrl(url, h(PROXIED), "")).toBe("https://api.parry.market/v1/paid/risk/a.testnet?x=1");
    expect(resourceUrl(url, h({ "x-forwarded-proto": "https, http", host: "api.parry.market" }), "")).toBe("https://api.parry.market/v1/paid/risk/a.testnet?x=1");
    // A configured public URL wins over the headers.
    expect(resourceUrl(url, h({ "x-forwarded-proto": "http", "x-forwarded-host": "evil.example" }), "https://api.parry.market/")).toBe("https://api.parry.market/v1/paid/risk/a.testnet?x=1");
    // Without a proxy, the request's own URL; a malformed host is ignored.
    expect(resourceUrl(url, h({}), "")).toBe(url);
    expect(resourceUrl(url, h({ "x-forwarded-proto": "gopher", "x-forwarded-host": "a b/c" }), "")).toBe(url);
  });

  test("without payment answers 402 with PAYMENT-REQUIRED and the same JSON body", async () => {
    delete process.env.PUBLIC_API_URL;
    const r = await harness().call();
    expect(r.status).toBe(402);
    const body = (await r.json()) as PaymentRequired;
    expect(body.resource.url).toBe(RESOURCE);
    expect(body.error).toBe("payment required");
    expect(decodePaymentRequired(r.headers.get("payment-required")!)).toEqual(body);
  });

  test("a v2 PAYMENT-SIGNATURE is verified, relayed once and answered with PAYMENT-RESPONSE and X-PAYMENT-RESPONSE", async () => {
    const t = harness();
    const r = await t.call({ "payment-signature": v2() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ account: "alice.testnet" });
    const settled = { success: true, transaction: "paidTx1", network: "near:testnet", payer: "agent.parry.testnet" };
    expect(decodePaymentResponse(r.headers.get("payment-response")!)).toEqual(settled);
    expect(decodePaymentResponse(r.headers.get("x-payment-response")!)).toEqual(settled);
    expect(t.relayed).toHaveLength(1);
    expect(t.recorded).toEqual([{ txHash: "paidTx1", payer: "agent.parry.testnet", amount: "10000", path: "/v1/paid/risk/alice.testnet" }]);
  });

  test("the v1 X-PAYMENT header with an SDK 0.1 payload is still accepted", async () => {
    const old = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "near:testnet", payload: { signedDelegateAction: delegate() } })).toString("base64");
    const r = await harness().call({ "x-payment": old });
    expect(r.status).toBe(200);
    expect(decodePaymentResponse(r.headers.get("payment-response")!).transaction).toBe("paidTx1");
  });

  test("a payment for another resource, amount or lifetime is refused before relaying", async () => {
    const t = harness();
    const refused = async (header: string) => {
      const r = await t.call({ "payment-signature": header });
      expect(r.status).toBe(402);
      expect(r.headers.get("payment-required")).toBeTruthy();
      return ((await r.json()) as PaymentRequired).error;
    };
    expect(await refused(v2(delegate(), "http://localhost:4000/v1/paid/risk/alice.testnet"))).toBe("the payment is for another resource");
    expect(await refused(v2(delegate("9999")))).toBe("ft_transfer must move exactly 10000");
    expect(await refused(v2(delegate("10000", 1_241n)))).toBe("delegate is valid for too long");
    expect(await refused("not base64 json")).toContain("base64 JSON");
    expect(t.relayed).toHaveLength(0);
  });

  test("a payment that did not settle answers 402 with a failed PAYMENT-RESPONSE", async () => {
    const r = await harness({ relay: async () => ({ error: "insufficient balance" }) }).call({ "payment-signature": v2() });
    expect(r.status).toBe(402);
    expect(decodePaymentResponse(r.headers.get("payment-response")!)).toEqual({ success: false, transaction: "", network: "near:testnet", errorReason: "payment did not settle: insufficient balance" });
  });

  test("the same payment sent twice at once is relayed once", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = harness({ relay: async () => (await gate, { txHash: "paidTx1" }) });
    const header = v2();
    const a = t.call({ "payment-signature": header });
    await new Promise((r) => setTimeout(r, 10));
    const b = await t.call({ "payment-signature": header });
    expect(b.status).toBe(402);
    expect(((await b.json()) as PaymentRequired).error).toContain("duplicate_settlement");
    release();
    expect((await a).status).toBe(200);
  });

  test("CORS lets browsers send PAYMENT-SIGNATURE and read the x402 answers", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp(null as never);
    const pre = await app.request("/v1/paid/risk/alice.testnet", { method: "OPTIONS", headers: { origin: "https://parry.market", "access-control-request-method": "GET", "access-control-request-headers": "payment-signature" } });
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("payment-signature");
    const got = await app.request("/v1/status/nope", { headers: { origin: "https://parry.market" } });
    expect(got.headers.get("access-control-expose-headers")?.toLowerCase()).toBe("payment-required,payment-response,x-payment-response");
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

  test("an unknown account is a 404 and a malformed id a 400 with a message", async () => {
    expect((await app.request("/v1/accounts/0unknown.testnet")).status).toBe(404);
    const bad = await app.request("/v1/risk/not_an_account!!");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("not a NEAR account id");
  });

  test("a non-numeric parameter, a body that is not JSON and a missing account id are 400s", async () => {
    expect((await app.request("/v1/guardian/decisions?limit=abc")).status).toBe(400);
    expect((await app.request("/v1/guardian/decisions?cursor=yesterday")).status).toBe(400);
    expect((await app.request("/v1/auth/challenge", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await app.request("/v1/auth/challenge", { method: "POST", body: "{}" })).status).toBe(400);
  });

  test("signing in to a protected account that is not created yet says so", async () => {
    const { nonce } = (await (await app.request("/v1/auth/challenge", { method: "POST", body: JSON.stringify({ accountId: "0unew.testnet" }) })).json()) as { nonce: string };
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: "parry", error: { code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCOUNT" } } })) as unknown as typeof fetch;
    try {
      const r = await app.request("/v1/auth/verify", { method: "POST", body: JSON.stringify({ accountId: "0unew.testnet", nonce }) });
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: string }).error).toBe("0unew.testnet is not created yet: create the protected account first");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("client address", () => {
  test("is the entry the reverse proxy appended, not one the client sent", async () => {
    const { clientIp } = await import("../src/app");
    expect(clientIp("6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
    expect(clientIp("203.0.113.9")).toBe("203.0.113.9");
    expect(clientIp(undefined)).toBe("local");
  });
});

describe("model attestation", () => {
  test("is not run without a NEAR AI key, and says so", async () => {
    const { modelAttestation } = await import("../src/verify");
    expect(await modelAttestation("z-ai/glm-5.3-flash", `0x${"ab".repeat(20)}`, "")).toBeNull();
  });
});
