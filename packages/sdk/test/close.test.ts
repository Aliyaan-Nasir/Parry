import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  certificateDigest,
  closeFromWalletActions,
  closePerpAction,
  closeRheaAction,
  createParry,
  defaultSteps,
  encodeEip1559,
  nep413Payload,
  openPolicy,
  ownerCallAction,
  ownerRequest,
  policyJson,
  repayAaveActions,
  sealPolicy,
  signNep413,
  subscribe,
  unwindAction,
  verifyCertificate,
  type Policy,
} from "../src/index.js";
import { ParryApi } from "../src/api.js";
import { fromHex, toBase58, toBase64, toHex, utf8 } from "../src/encoding.js";
import { json, mockFetch } from "./helpers.js";

describe("closing actions", () => {
  test("close_rhea is the only action of its call", () => {
    expect(closeRheaAction(150)).toEqual({ close_rhea: { slippage_bps: 150 } });
    expect(ownerCallAction("0ua.testnet", [closeRheaAction()]).args).toEqual({ actions: [{ close_rhea: { slippage_bps: 100 } }] });
    expect(() => ownerCallAction("0ua.testnet", [closeRheaAction(), unwindAction(["usdc.parry.testnet"])])).toThrow("close_rhea must be the only action");
    expect(() => closeRheaAction(5000)).toThrow();
  });

  test("closing from the wallet: transfer the debt token, then repay and withdraw", () => {
    const c = closeFromWalletActions({ account: "0ua.testnet", debtToken: "usdc.parry.testnet", debtAmount: 150_000_000n, collateralToken: "wrap.testnet", collateralAmount: "100000000000000000000000000" });
    expect(c.transfer).toMatchObject({ receiverId: "usdc.parry.testnet", methodName: "ft_transfer", deposit: "1" });
    expect(c.transfer.args).toMatchObject({ receiver_id: "0ua.testnet", amount: "150000000" });
    expect(c.actions).toEqual([{ repay: { token: "usdc.parry.testnet", amount: "150000000" } }, { withdraw: { token: "wrap.testnet", amount: "100000000000000000000000000" } }]);
  });

  test("unwind names its tokens once, with a target for passkey owners", () => {
    expect(unwindAction(["a.testnet", "b.testnet"])).toEqual({ unwind: { tokens: ["a.testnet", "b.testnet"] } });
    expect(unwindAction(["a.testnet"], "me.testnet")).toEqual({ unwind: { tokens: ["a.testnet"], to: "me.testnet" } });
    expect(() => unwindAction(["a.testnet", "a.testnet"])).toThrow();
    const r = ownerRequest({ account: "0ua.testnet", network: "testnet", nonce: 3, actions: [unwindAction(["a.testnet"], "me.testnet")], createdAt: 1_800_000_000 });
    expect(JSON.parse(r.text).actions[0].unwind.to).toBe("me.testnet");
  });

  test("a perp close is a reduce-only IOC order on the other side, priced through the mark", () => {
    const short = closePerpAction({ assetIndex: 54, size: -12.34, markPrice: 3.2, szDecimals: 1, slippageBps: 100, nonce: 1_800_000_000_000 }) as { hl_order: { order: Record<string, unknown> } };
    expect(short.hl_order.order).toEqual({ asset_index: 54, is_buy: true, price: "3.232", size: "12.3", reduce_only: true, tif: "Ioc" });
    const long = closePerpAction({ assetIndex: 54, size: 5, markPrice: 3.2, szDecimals: 1, nonce: 1 }) as { hl_order: { order: Record<string, unknown> } };
    expect(long.hl_order.order).toMatchObject({ is_buy: false, price: "3.168", size: "5" });
    expect(() => closePerpAction({ assetIndex: 54, size: 0, markPrice: 3, szDecimals: 1 })).toThrow();
  });

  test("the Aave repay is approve then repay at consecutive nonces, each an mpc_sign of its hash", () => {
    const [approve, repay] = repayAaveActions({
      chainId: 84532,
      nonce: 7,
      pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      amount: 25_000_000n,
      onBehalfOf: "0x33aacfd7ed3dd010f659455155e820bfcddf1af1",
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    expect(approve.unsignedTx.startsWith("0x02")).toBe(true);
    expect(approve.unsignedTx).toContain("095ea7b3");
    expect(repay.unsignedTx).toContain("573ade81");
    expect(approve.signingHash).toBe(toHex(keccak_256(fromHex(approve.unsignedTx.slice(2)))));
    expect(repay.action).toEqual({ mpc_sign: { path: "parry-evm", payload: repay.signingHash, domain_id: 0 } });
    // A known EIP-1559 encoding: chain 1, nonce 0, no fees, empty data.
    expect(encodeEip1559({ chainId: 1, nonce: 0, maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, gasLimit: 21_000n, to: `0x${"11".repeat(20)}`, value: 1n, data: new Uint8Array() })).toBe(
      `0x02df0180808082520894${"11".repeat(20)}0180c0`,
    );
  });
});

describe("sealed policy steps", () => {
  const secret = sha256(utf8("enclave sealing secret"));
  const policy: Policy = { triggerScore: 60, triggerHealth: 1.15, targetHealth: 1.45, strategy: "keep-exposure" };

  test("defaults follow the strategy, and the JSON carries steps only when given", () => {
    expect(defaultSteps("keep-exposure")).toEqual(["add_collateral", "repay", "deleverage", "hl_reduce", "evm_repay"]);
    expect(defaultSteps("deleverage-only")[0]).toBe("deleverage");
    expect(policyJson(policy)).not.toContain("steps");
    expect(policyJson({ ...policy, steps: ["deleverage", "repay"] })).toBe(
      '{"trigger_score":60,"trigger_health":1.15,"target_health":1.45,"strategy":"keep-exposure","hl_reduce_fraction":0.25,"evm_trigger_health":1.2,"steps":["deleverage","repay"]}',
    );
  });

  test("validation refuses unknown, repeated and empty step lists", () => {
    expect(() => policyJson({ ...policy, steps: [] })).toThrow("at least one");
    expect(() => policyJson({ ...policy, steps: ["repay", "repay"] })).toThrow("at most once");
    expect(() => policyJson({ ...policy, steps: ["transfer" as never] })).toThrow("not one of");
  });

  test("the order survives sealing", () => {
    const sealed = sealPolicy({ ...policy, steps: ["hl_reduce", "repay"] }, { account: "0ua.testnet", sealingPublicKey: x25519.getPublicKey(secret) });
    expect(openPolicy(sealed, { account: "0ua.testnet", secret }).steps).toEqual(["hl_reduce", "repay"]);
  });
});

describe("health certificates", () => {
  const seed = sha256(utf8("certificate enclave"));
  const key = `ed25519:${toBase58(ed25519.getPublicKey(seed))}`;
  const oldKey = `ed25519:${toBase58(ed25519.getPublicKey(sha256(utf8("older build"))))}`;
  const body = {
    kind: "parry-health-certificate",
    version: 1,
    account: "0ua.testnet",
    reader: "lender.testnet",
    venue: "rhea",
    threshold: 1.2,
    block_height: 1000,
    block_hash: "11111111111111111111111111111111",
    issued_at: 1_800_000_000,
    expires_at: 1_800_086_400,
    statement: "health is at least 1.2",
  };
  const certificate = JSON.stringify(body);
  const digest = certificateDigest(certificate);
  const cert = { hash: toHex(digest), certificate, signature: toBase64(ed25519.sign(digest, seed)), enclavePublicKey: key, anchorTx: "tx1", createdAt: "" };
  const history = [
    { public_key: oldKey, since: 1_700_000_000 },
    { public_key: key, since: 1_799_000_000 },
    { public_key: oldKey, since: 1_900_000_000 },
  ];

  test("verifies against the key in force at issue time, with reader and anchor", () => {
    const v = verifyCertificate(cert, { enclaveHistory: history, now: 1_800_000_100, reader: "lender.testnet", anchor: { hash: cert.hash, reader: "lender.testnet", expires_at: body.expires_at, at: 1_800_000_010 } });
    expect(v.checks.map((c) => [c.name, c.status])).toEqual([
      ["hash", "pass"],
      ["statement", "pass"],
      ["signature", "pass"],
      ["expiry", "pass"],
      ["reader", "pass"],
      ["anchor", "pass"],
    ]);
    expect(v.ok).toBe(true);
    expect(v.enclavePublicKey).toBe(key);
  });

  test("fails when expired, for another reader, tampered, signed by another key or not anchored", () => {
    expect(verifyCertificate(cert, { enclaveHistory: history, now: body.expires_at + 1 }).ok).toBe(false);
    expect(verifyCertificate(cert, { enclaveHistory: history, now: 1_800_000_100, reader: "other.testnet" }).ok).toBe(false);
    const tampered = { ...cert, certificate: certificate.replace("1.2", "1.5") };
    expect(verifyCertificate(tampered, { enclaveHistory: history, now: 1_800_000_100 }).checks.find((c) => c.name === "hash")!.status).toBe("fail");
    expect(verifyCertificate(cert, { enclavePublicKey: oldKey, now: 1_800_000_100 }).checks.find((c) => c.name === "signature")!.status).toBe("fail");
    expect(verifyCertificate(cert, { enclaveHistory: history, now: 1_800_000_100, anchor: null }).ok).toBe(false);
  });
});

describe("NEP-413 sign-in", () => {
  test("the payload is the borsh layout the API checks, signed with the account key", () => {
    const seed = sha256(utf8("owner"));
    const pk = ed25519.getPublicKey(seed);
    const privateKey = `ed25519:${toBase58(new Uint8Array([...seed, ...pk]))}`;
    const nonce = new Uint8Array(32).fill(9);
    const p = nep413Payload("hi", nonce, "parry");
    expect(new DataView(p.buffer, p.byteOffset).getUint32(0, true)).toBe(2 ** 31 + 413);
    const s = signNep413(privateKey, "hi", nonce, "parry");
    expect(s.publicKey).toBe(`ed25519:${toBase58(pk)}`);
    expect(ed25519.verify(Uint8Array.from(Buffer.from(s.signature, "base64")), sha256(p), pk)).toBe(true);
  });

  test("signIn runs the challenge and returns the token", async () => {
    const seed = sha256(utf8("owner"));
    const privateKey = `ed25519:${toBase58(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]))}`;
    const { fetch, seen } = mockFetch((r) =>
      r.url.endsWith("/v1/auth/challenge") ? json({ nonce: "ab".repeat(32), message: "Sign in", recipient: "parry" }) : r.url.endsWith("/v1/auth/verify") ? json({ token: "t0k" }) : undefined,
    );
    const parry = createParry({ network: "testnet", apiUrl: "https://api.test", fetch });
    expect(await parry.signIn("0ua.testnet", privateKey)).toBe("t0k");
    expect((seen[1]!.body as { nep413: { publicKey: string } }).nep413.publicKey).toStartWith("ed25519:");
  });
});

describe("subscribe", () => {
  test("uses an EventSource when there is one", () => {
    const listeners: string[] = [];
    let url = "";
    class FakeSource {
      onerror: ((e: unknown) => void) | null = null;
      constructor(u: string) {
        url = u;
      }
      addEventListener(type: string) {
        listeners.push(type);
      }
      close() {}
    }
    const stop = subscribe(new ParryApi("https://api.test"), { events: ["alert", "price"], account: "0ua.testnet", onEvent: () => {}, eventSource: FakeSource });
    expect(url).toBe("https://api.test/v1/stream?events=alert%2Cprice&account=0ua.testnet");
    expect(listeners).toEqual(["alert", "price"]);
    stop();
  });

  test("falls back to polling and emits only what changed", async () => {
    let price = 3;
    const { fetch } = mockFetch((r) => (r.url.includes("/v1/market") ? json({ near: { priceUsd: price, updatedAt: String(price) } }) : undefined));
    const got: unknown[] = [];
    const stop = subscribe(new ParryApi("https://api.test", fetch), { events: ["price"], onEvent: (_e, d) => got.push(d), eventSource: null, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(0);
    price = 3.1;
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(got[0]).toMatchObject({ id: "wrap.near", priceUsd: 3.1 });
  });
});
