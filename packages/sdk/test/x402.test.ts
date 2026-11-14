import { afterEach, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { DelegateAction, decodeSignedDelegateAction, encodeSignedDelegateAction, parsePublicKey, serializeDelegateAction } from "near-kit";
import {
  checkDelegateOnChain,
  createParry,
  decodePaymentHeader,
  decodePaymentRequired,
  decodePaymentResponse,
  delegateActionHash,
  encodePaymentHeader,
  encodePaymentRequired,
  encodePaymentResponse,
  nearClient,
  NEP366_PREFIX,
  parseSignedDelegate,
  signPaymentDelegate,
  verifyPayment,
  verifySignedDelegate,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "../src/index.js";
import { concatBytes, fromBase64, formatEd25519PublicKey, toBase58, toBase64, toHex, utf8 } from "../src/encoding.js";
import { installGlobalFetch, json, mockFetch, RPC_URL, rpcRoute } from "./helpers.js";

const payerSeed = sha256(utf8("payer key"));
const payerKey = `ed25519:${toBase58(concatBytes(payerSeed, ed25519.getPublicKey(payerSeed)))}`;
const payerPublic = formatEd25519PublicKey(ed25519.getPublicKey(payerSeed));
const PAYER = "agent.parry.testnet";

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "near:testnet",
  asset: "usdc.parry.testnet",
  amount: "10000",
  payTo: "api.parry.testnet",
  maxTimeoutSeconds: 120,
};
const RESOURCE = "https://api.parry.example/v1/paid/risk/alice.testnet";
const required: PaymentRequired = { x402Version: 2, error: "payment required", resource: { url: RESOURCE, description: "Parry risk check", mimeType: "application/json" }, accepts: [requirement] };
const v2Payment = (signedDelegateAction: string): PaymentPayload => ({ x402Version: 2, resource: required.resource, accepted: requirement, payload: { signedDelegateAction } });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

async function signed(height = 1_000, nonce = 41): Promise<string> {
  const rpc = mockFetch(rpcRoute({ blockHeight: height, accessKeyNonce: nonce }));
  restore = installGlobalFetch(rpc.fetch);
  const near = nearClient({ network: "testnet", rpcUrl: RPC_URL }, { accountId: PAYER, privateKey: payerKey });
  return signPaymentDelegate(near, PAYER, requirement);
}

describe("NEP-366 delegate actions", () => {
  test("near-kit signs, we parse and verify with the NEP-461 prefix", async () => {
    const b64 = await signed(1_000, 41);
    const d = parseSignedDelegate(b64);
    expect(d.senderId).toBe(PAYER);
    expect(d.receiverId).toBe("usdc.parry.testnet");
    expect(d.nonce).toBe(42n); // access key nonce + 1
    expect(d.maxBlockHeight).toBe(1_120n); // current height + 120
    expect(d.publicKey).toBe(payerPublic);
    expect(d.actions).toEqual([
      {
        type: "FunctionCall",
        methodName: "ft_transfer",
        args: { receiver_id: "api.parry.testnet", amount: "10000" },
        argsBase64: toBase64(utf8('{"receiver_id":"api.parry.testnet","amount":"10000"}')),
        gas: 30_000_000_000_000n,
        deposit: 1n,
      },
    ]);
    expect(verifySignedDelegate(b64)).toBe(true);
    expect(verifySignedDelegate(fromBase64(b64))).toBe(true);
    // The signature is over SHA-256(u32le(2^30 + 366) ++ borsh(DelegateAction)).
    expect(NEP366_PREFIX).toBe(2 ** 30 + 366);
    const prefix = Uint8Array.of(0x6e, 0x01, 0x00, 0x40);
    expect(toHex(d.hash)).toBe(toHex(sha256(concatBytes(prefix, d.delegateBytes))));
    expect(ed25519.verify(d.signature, d.hash, ed25519.getPublicKey(payerSeed))).toBe(true);
  });

  test("the signed bytes are exactly near-kit's serialization of the delegate action", async () => {
    const d = parseSignedDelegate(await signed());
    const decoded = decodeSignedDelegateAction(await signed()).signedDelegate.delegateAction;
    const action = new DelegateAction(decoded.senderId, decoded.receiverId, decoded.actions as never, BigInt(decoded.nonce), BigInt(decoded.maxBlockHeight), parsePublicKey(payerPublic));
    const serialized = serializeDelegateAction(action);
    expect(toHex(serialized.subarray(0, 4))).toBe("6e010040");
    expect(toHex(serialized.subarray(4))).toBe(toHex(d.delegateBytes));
    expect(toHex(delegateActionHash(serialized.subarray(4)))).toBe(toHex(d.hash));
  });

  test("tampering breaks the signature or the encoding", async () => {
    const bytes = fromBase64(await signed());
    const tampered = bytes.slice();
    // Change one byte of the amount inside the args.
    const at = toHex(tampered).indexOf(toHex(utf8("10000"))) / 2;
    tampered[at] = "2".charCodeAt(0);
    expect(verifySignedDelegate(tampered)).toBe(false);
    expect(() => parseSignedDelegate(concatBytes(bytes, Uint8Array.of(0)))).toThrow("trailing");
    expect(() => parseSignedDelegate("AAAA")).toThrow("not a borsh SignedDelegateAction");
    const sig = bytes.slice();
    sig[sig.length - 1]! ^= 1;
    expect(verifySignedDelegate(sig)).toBe(false);
  });

  test("a delegate signed by another key over the same bytes does not verify", async () => {
    const decoded = decodeSignedDelegateAction(await signed());
    const forged = encodeSignedDelegateAction(
      { signedDelegate: { ...decoded.signedDelegate, signature: { ed25519Signature: { data: [...ed25519.sign(new Uint8Array(32), sha256(utf8("eve")))] } } } },
      "bytes",
    );
    expect(verifySignedDelegate(forged)).toBe(false);
  });
});

describe("chain-side payment checks", () => {
  test("the key, its nonce and the expiry are checked against the chain", async () => {
    const d = parseSignedDelegate(await signed(1_000, 41));
    const check = async (nonce: number, height: number) => {
      restore?.();
      const rpc = mockFetch(rpcRoute({ accessKeyNonce: nonce, blockHeight: height }));
      restore = installGlobalFetch(rpc.fetch);
      return checkDelegateOnChain(nearClient({ network: "testnet", rpcUrl: RPC_URL }), d);
    };
    expect(await check(41, 1_010)).toEqual({ ok: true, blockHeight: 1_010n });
    expect(await check(42, 1_010)).toEqual({ ok: false, reason: "the delegate's nonce is already used" });
    expect(await check(41, 1_120)).toEqual({ ok: false, reason: "delegate expired" });
  });
});

describe("x402 headers", () => {
  test("v2 payment header round trip, with the accepted requirements and the resource", async () => {
    const payload = v2Payment(await signed());
    const header = encodePaymentHeader(payload);
    expect(JSON.parse(new TextDecoder().decode(fromBase64(header)))).toEqual(payload);
    expect(decodePaymentHeader(header)).toEqual(payload);
    expect(() => decodePaymentHeader("not base64 json")).toThrow();
    const raw = (v: unknown) => toBase64(utf8(JSON.stringify(v)));
    expect(() => decodePaymentHeader(raw({ ...payload, accepted: { ...requirement, scheme: "upto" } }))).toThrow("exact");
    expect(() => decodePaymentHeader(raw({ ...payload, accepted: { ...requirement, payTo: undefined } }))).toThrow("payTo");
    expect(() => decodePaymentHeader(raw({ ...payload, accepted: { ...requirement, maxTimeoutSeconds: 0 } }))).toThrow("maxTimeoutSeconds");
  });

  test("an SDK 0.1 payment (scheme and network at the top level) is still read", async () => {
    const signedDelegateAction = await signed();
    const old = toBase64(utf8(JSON.stringify({ x402Version: 2, scheme: "exact", network: "near:testnet", payload: { signedDelegateAction } })));
    const read = decodePaymentHeader(old);
    expect(read).toEqual({ x402Version: 2, accepted: { scheme: "exact", network: "near:testnet" }, payload: { signedDelegateAction } });
    expect(verifyPayment(read, requirement, { blockHeight: 1_010, resource: RESOURCE }).ok).toBe(true);
    expect(() => decodePaymentHeader(toBase64(utf8(JSON.stringify({ x402Version: 2, scheme: "upto", network: "near:testnet", payload: { signedDelegateAction } }))))).toThrow("exact");
  });

  test("PAYMENT-REQUIRED round trip", () => {
    expect(decodePaymentRequired(encodePaymentRequired(required))).toEqual(required);
    expect(() => decodePaymentRequired(toBase64(utf8("{}")))).toThrow("accepts");
  });

  test("payment response round trip", () => {
    const r = { success: true, transaction: "8f3Tx", network: "near:testnet", payer: PAYER };
    expect(decodePaymentResponse(encodePaymentResponse(r))).toEqual(r);
    expect(decodePaymentResponse(encodePaymentResponse({ ...r, success: false, errorReason: "insufficient balance" })).errorReason).toBe("insufficient balance");
  });

  test("verifyPayment accepts the exact payment and refuses everything else", async () => {
    const b64 = await signed(1_000);
    const payload = v2Payment(b64);
    const ok = verifyPayment(payload, requirement, { blockHeight: 1_010, resource: RESOURCE });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.delegate.senderId).toBe(PAYER);

    const refuse = (p: PaymentPayload, req: PaymentRequirements, height = 1_010) => {
      const r = verifyPayment(p, req, { blockHeight: height });
      return r.ok ? "ok" : r.reason;
    };
    // The delegate itself is checked against what was asked, whatever the payment says it accepted.
    const asked = (r: PaymentRequirements) => refuse({ ...payload, accepted: r }, r);
    expect(asked({ ...requirement, amount: "10001" })).toContain("exactly 10001");
    expect(asked({ ...requirement, payTo: "eve.testnet" })).toContain("must pay eve.testnet");
    expect(asked({ ...requirement, asset: "other.testnet" })).toContain("not the asset");
    expect(refuse(payload, { ...requirement, amount: "10001" })).toBe("the payment accepted another amount");
    expect(refuse({ ...payload, accepted: { ...requirement, network: "near:mainnet" } }, requirement)).toContain("network");
    expect(refuse({ ...payload, accepted: { ...requirement, amount: "1" } }, requirement)).toBe("the payment accepted another amount");
    expect(refuse({ ...payload, accepted: { ...requirement, payTo: "eve.testnet" } }, requirement)).toBe("the payment accepted another payTo");
    expect(verifyPayment({ ...payload, resource: { url: "https://api.parry.example/v1/paid/risk/bob.testnet" } }, requirement, { resource: RESOURCE })).toMatchObject({ ok: false, reason: "the payment is for another resource" });
    expect(refuse({ ...payload, x402Version: 1 }, requirement)).toContain("x402Version");
    expect(refuse(payload, requirement, 1_120)).toBe("delegate expired");
    // At most maxTimeoutSeconds blocks ahead (120 here): 1_120 - 999 = 121.
    expect(refuse(payload, requirement, 1_000)).toBe("ok");
    expect(refuse(payload, requirement, 999)).toBe("delegate is valid for too long");
    expect(verifyPayment(payload, requirement, { maxGas: 10_000_000_000_000n }).ok).toBe(false);
  });
});

describe("paidRiskCheck", () => {
  const riskCheck = {
    account: "alice.testnet",
    checkedAt: "2026-11-10T00:00:00Z",
    position: null,
    market: {
      near: { priceUsd: 3.2, hlMid: 3.21, updatedAt: "2026-11-10T00:00:00Z" },
      tremor: { sigmaHourly: 0.01, annual: 0.9, level: "elevated", windows: [] },
      cascade: { pressure: 0.1, atRiskUsd: 1000, correlatedOwners: 0 },
    },
    model: "docs/risk-model.md",
  };

  test("pays on 402 with a signed delegate in PAYMENT-SIGNATURE and returns the result and the receipt", async () => {
    const api = mockFetch((req) => {
      if (!req.url.startsWith(RESOURCE)) return undefined;
      const header = req.headers["payment-signature"];
      // The requirements travel in PAYMENT-REQUIRED; the body here is empty to prove the header is read.
      if (!header) return json({}, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequired(required) } });
      const check = verifyPayment(decodePaymentHeader(header), requirement, { blockHeight: 1_005, resource: RESOURCE });
      if (!check.ok) return json({ error: check.reason }, { status: 402 });
      return json(riskCheck, { headers: { "PAYMENT-RESPONSE": encodePaymentResponse({ success: true, transaction: "txhash1", network: "near:testnet", payer: PAYER }) } });
    });
    const rpc = mockFetch(rpcRoute({ blockHeight: 1_000 }));
    restore = installGlobalFetch(rpc.fetch);
    const parry = createParry({ network: "testnet", apiUrl: "https://api.parry.example", rpcUrl: RPC_URL, fetch: api.fetch });
    const out = await parry.paidRiskCheck("alice.testnet", { payer: { accountId: PAYER, privateKey: payerKey }, maxAmount: "10000" });
    expect(out.result).toEqual(riskCheck as never);
    expect(out.payment).toEqual({ success: true, transaction: "txhash1", network: "near:testnet", payer: PAYER });
    expect(out.requirement).toEqual(requirement);
    expect(api.seen).toHaveLength(2);
    expect(api.seen[1]!.headers["x-payment"]).toBeUndefined();
    const sent = decodePaymentHeader(api.seen[1]!.headers["payment-signature"]!);
    expect(sent).toMatchObject({ x402Version: 2, resource: { url: RESOURCE }, accepted: requirement });
    expect(parseSignedDelegate(sent.payload.signedDelegateAction).maxBlockHeight).toBe(1_120n);
  });

  test("reads the requirements from the body and the v1 X-PAYMENT-RESPONSE when a server sends only those", async () => {
    const api = mockFetch((req) => {
      if (!req.headers["payment-signature"]) return json(required, { status: 402 });
      return json(riskCheck, { headers: { "X-PAYMENT-RESPONSE": encodePaymentResponse({ success: true, transaction: "txhash2", network: "near:testnet" }) } });
    });
    const rpc = mockFetch(rpcRoute({ blockHeight: 1_000 }));
    restore = installGlobalFetch(rpc.fetch);
    const parry = createParry({ network: "testnet", apiUrl: "https://api.parry.example", rpcUrl: RPC_URL, fetch: api.fetch });
    const out = await parry.paidRiskCheck("alice.testnet", { payer: { accountId: PAYER, privateKey: payerKey } });
    expect(out.payment?.transaction).toBe("txhash2");
    // A shorter timeout bounds the delegate's lifetime.
    const short = mockFetch((req) => (req.headers["payment-signature"] ? json(riskCheck) : json({ ...required, accepts: [{ ...requirement, maxTimeoutSeconds: 30 }] }, { status: 402 })));
    await createParry({ network: "testnet", apiUrl: "https://api.parry.example", rpcUrl: RPC_URL, fetch: short.fetch }).paidRiskCheck("alice.testnet", { payer: { accountId: PAYER, privateKey: payerKey } });
    expect(parseSignedDelegate(decodePaymentHeader(short.seen[1]!.headers["payment-signature"]!).payload.signedDelegateAction).maxBlockHeight).toBe(1_030n);
  });

  test("refuses to pay above the limit, in another asset or on another network", async () => {
    const answer = (req: PaymentRequirements) => mockFetch(() => json({ ...required, accepts: [req] }, { status: 402 }));
    const payer = { accountId: PAYER, privateKey: payerKey };
    const make = (req: PaymentRequirements) => createParry({ network: "testnet", apiUrl: "https://api.parry.example", fetch: answer(req).fetch });
    await expect(make(requirement).paidRiskCheck("a.testnet", { payer, maxAmount: 9_999n })).rejects.toThrow("above the limit");
    await expect(make({ ...requirement, asset: "evil.testnet" }).paidRiskCheck("a.testnet", { payer })).rejects.toThrow("expected usdc.parry.testnet");
    await expect(make({ ...requirement, network: "near:mainnet" }).paidRiskCheck("a.testnet", { payer })).rejects.toThrow("near:testnet");
  });

  test("a free answer needs no payment", async () => {
    const api = mockFetch(() => json(riskCheck));
    const parry = createParry({ network: "testnet", apiUrl: "https://api.parry.example", fetch: api.fetch });
    const out = await parry.paidRiskCheck("alice.testnet", { payer: { accountId: PAYER, privateKey: payerKey } });
    expect(out.payment).toBeNull();
    expect(out.result.account).toBe("alice.testnet");
  });
});
