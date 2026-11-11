import { afterEach, describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  certificateDigest,
  CLOSE_RHEA_TGAS,
  closeFromWalletActions,
  closePerpAction,
  closeRheaAction,
  closeRheaRounds,
  closeStatus,
  createParry,
  defaultSteps,
  encodeEip1559,
  MAX_CALL_TGAS,
  nep413Payload,
  openPolicy,
  OWNER_CALL_TGAS,
  ownerActions,
  ownerActionsTgas,
  ownerCallAction,
  ownerRequest,
  policyJson,
  repayAaveActions,
  RETRY_CLOSE_TGAS,
  retryCloseAction,
  sealPolicy,
  signNep413,
  subscribe,
  TGAS,
  unwindAction,
  unwindTgas,
  verifyCertificate,
  type Closing,
  type OwnerAction,
  type Policy,
  type RheaLines,
} from "../src/index.js";
import { ParryApi } from "../src/api.js";
import { fromHex, toBase58, toBase64, toHex, utf8 } from "../src/encoding.js";
import { installGlobalFetch, json, mockFetch, RPC_URL, rpcRoute } from "./helpers.js";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("closing actions", () => {
  test("close_rhea names its pool, is the only action of its call and carries 900 Tgas", () => {
    expect(closeRheaAction({ slippageBps: 150, poolId: 2939 })).toEqual({ close_rhea: { slippage_bps: 150, pool_id: 2939 } });
    const call = ownerCallAction("0ua.testnet", [closeRheaAction({ slippageBps: 100, poolId: 7 })]);
    expect(call.args).toEqual({ actions: [{ close_rhea: { slippage_bps: 100, pool_id: 7 } }] });
    expect(call.gas).toBe((900n * TGAS).toString());
    expect(call.deposit).toBe("1");
    expect(call.actions[0].params.gas).toBe(call.gas);
    expect(() => ownerCallAction("0ua.testnet", [closeRheaAction({ slippageBps: 100, poolId: 7 }), unwindAction(["usdc.parry.testnet"])])).toThrow("close_rhea must be the only action");
    expect(() => ownerCallAction("0ua.testnet", [unwindAction([]), "revoke_mandate"])).toThrow("unwind must be the only action");
    // The contract takes 1 to 1000 bps and a pool index.
    expect(() => closeRheaAction({ slippageBps: 5000, poolId: 7 })).toThrow("slippageBps");
    expect(() => closeRheaAction({ slippageBps: 0, poolId: 7 })).toThrow("slippageBps");
    expect(() => closeRheaAction({ slippageBps: 1.5, poolId: 7 })).toThrow("slippageBps");
    expect(() => closeRheaAction({ slippageBps: 100, poolId: -1 })).toThrow("poolId");
    expect(() => closeRheaAction({ slippageBps: 100, poolId: undefined as unknown as number })).toThrow("poolId");
  });

  test("owner calls carry the gas their actions need, up to 1 PGas", () => {
    expect(ownerActionsTgas([ownerActions.repay("usdc.parry.testnet", "5")])).toBe(OWNER_CALL_TGAS);
    expect(ownerActionsTgas([closeRheaAction({ slippageBps: 100, poolId: 1 })])).toBe(CLOSE_RHEA_TGAS);
    // 160 + 130 per protocol token + 25 per listed token, plus 60, at least 600.
    expect(unwindTgas(2, 2)).toBe(600);
    expect(unwindTgas(2)).toBe(160 + 390 + 50 + 60);
    expect(unwindTgas(16, 3)).toBe(MAX_CALL_TGAS);
    expect(() => unwindTgas(16, 4)).toThrow("more than one call may carry");
    expect(() => unwindTgas(17)).toThrow();
    expect(ownerCallAction("0ua.testnet", [unwindAction(["a.testnet", "b.testnet"])], { protocolTokens: 2 }).gas).toBe((600n * TGAS).toString());
    expect(ownerCallAction("0ua.testnet", [unwindAction(["a.testnet", "b.testnet"])]).gas).toBe((660n * TGAS).toString());
    expect(() => unwindAction(Array.from({ length: 17 }, (_, i) => `t${i}.testnet`))).toThrow("at most 16");
  });

  test("retry_close is a plain call anyone may send, with 400 Tgas and no deposit", () => {
    const call = retryCloseAction("0ua.testnet");
    expect(call).toMatchObject({ receiverId: "0ua.testnet", methodName: "retry_close", args: {}, gas: (RETRY_CLOSE_TGAS * 1_000_000_000_000).toString(), deposit: "0" });
    expect(RETRY_CLOSE_TGAS).toBeGreaterThanOrEqual(360);
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
    const short = closePerpAction({ assetIndex: 54, size: -12.34, markPrice: 3.2, szDecimals: 1, slippageBps: 100, nonce: 1_800_000_000_000 }) as unknown as { hl_order: { order: Record<string, unknown> } };
    expect(short.hl_order.order).toEqual({ asset_index: 54, is_buy: true, price: "3.232", size: "12.3", reduce_only: true, tif: "Ioc" });
    const long = closePerpAction({ assetIndex: 54, size: 5, markPrice: 3.2, szDecimals: 1, nonce: 1 }) as unknown as { hl_order: { order: Record<string, unknown> } };
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

describe("closing in rounds", () => {
  const closingAt = (stage: string): Closing => ({
    id: 100,
    collateral: "wrap.testnet",
    debt: "usdc.parry.testnet",
    pool_id: 7,
    slippage_bps: 100,
    sell: "1",
    min_out: "1",
    out: "0",
    repay: "1",
    last: false,
    stage,
    failed: null,
    started_at: 1,
  });
  const lines = (debt: bigint, collateral: bigint): RheaLines => ({
    collateral: collateral > 0n ? [{ token_id: "wrap.testnet", balance: collateral.toString() }] : [],
    supplied: [],
    borrowed: debt > 0n ? [{ token_id: "usdc.parry.testnet", balance: debt.toString() }] : [],
  });

  test("closeStatus reads closing() and the position", () => {
    expect(closeStatus(null, null)).toEqual({ kind: "closed", collateral: "0" });
    expect(closeStatus(null, lines(0n, 5n))).toEqual({ kind: "closed", collateral: "5" });
    expect(closeStatus(null, lines(3n, 9n))).toEqual({ kind: "open", debt: "3", collateral: "9" });
    expect(closeStatus(closingAt("swap"), lines(3n, 9n)).kind).toBe("in_flight");
    expect(closeStatus(closingAt("stuck_repay"), lines(3n, 9n)).kind).toBe("stuck");
  });

  /** A protected account whose rounds follow a script: each close or retry moves to the next state. */
  function fakeChain(states: { closing: Closing | null; position: RheaLines | null }[]) {
    let i = 0;
    const sent: string[] = [];
    return {
      sent,
      read: {
        closing: async () => states[i]!.closing,
        rheaPosition: async () => states[i]!.position,
      },
      sendOwnerActions: async (actions: OwnerAction[]) => {
        sent.push(JSON.stringify(actions));
        i = Math.min(i + 1, states.length - 1);
        return { txHash: `close${sent.length}` };
      },
      sendCall: async (call: { methodName: string }) => {
        sent.push(call.methodName);
        i = Math.min(i + 1, states.length - 1);
        return { txHash: `retry${sent.length}` };
      },
    };
  }

  test("a 1.425-health position closes in two rounds", async () => {
    const chain = fakeChain([
      { closing: null, position: lines(100n, 300n) },
      { closing: null, position: lines(40n, 200n) },
      { closing: null, position: lines(0n, 0n) },
    ]);
    const seen: string[] = [];
    const r = await closeRheaRounds({ account: "0ua.testnet", slippageBps: 300, poolId: 2939, ...chain, onRound: (x) => seen.push(`${x.kind}:${x.after.kind}`) });
    expect(r).toMatchObject({ closed: true, stopped: null, status: { kind: "closed" } });
    expect(r.rounds.map((x) => x.txHash)).toEqual(["close1", "close2"]);
    expect(seen).toEqual(["close:open", "close:closed"]);
    expect(JSON.parse(chain.sent[0]!)).toEqual([{ close_rhea: { slippage_bps: 300, pool_id: 2939 } }]);
  });

  test("a stuck round is retried, and a round in flight is waited for", async () => {
    const chain = fakeChain([
      { closing: closingAt("stuck_repay"), position: lines(40n, 200n) },
      { closing: null, position: lines(0n, 0n) },
    ]);
    const r = await closeRheaRounds({ account: "0ua.testnet", slippageBps: 100, poolId: 1, ...chain });
    expect(r.closed).toBe(true);
    expect(chain.sent).toEqual(["retry_close"]);
    expect(r.rounds[0]).toMatchObject({ kind: "retry", txHash: "retry1" });

    let reads = 0;
    const waiting = await closeRheaRounds({
      account: "0ua.testnet",
      slippageBps: 100,
      poolId: 1,
      read: { closing: async () => (reads++ < 2 ? closingAt("repay") : null), rheaPosition: async () => lines(0n, 0n) },
      sendOwnerActions: async () => {
        throw new Error("nothing to send");
      },
      pollMs: 1,
    });
    expect(waiting).toMatchObject({ closed: true, rounds: [] });
    expect(reads).toBe(3);
    await expect(
      closeRheaRounds({ account: "0ua.testnet", slippageBps: 100, poolId: 1, read: { closing: async () => closingAt("swap"), rheaPosition: async () => null }, sendOwnerActions: async () => ({ txHash: "x" }), pollMs: 1, waitMs: 5 }),
    ).rejects.toThrow("still at stage swap");
  });

  test("stops on a rolled-back round, on a stuck close without a sender, and after maxRounds", async () => {
    const rolled = fakeChain([
      { closing: null, position: lines(100n, 300n) },
      { closing: null, position: lines(100n, 300n) },
    ]);
    expect(await closeRheaRounds({ account: "0ua.testnet", slippageBps: 1, poolId: 1, ...rolled })).toMatchObject({ closed: false, stopped: "rolled_back", rounds: [{ kind: "close" }] });

    const stuck = fakeChain([{ closing: closingAt("stuck_withdraw_out"), position: lines(40n, 200n) }]);
    expect(await closeRheaRounds({ account: "0ua.testnet", slippageBps: 1, poolId: 1, read: stuck.read, sendOwnerActions: stuck.sendOwnerActions })).toMatchObject({ closed: false, stopped: "stuck", rounds: [] });

    const slow = fakeChain([
      { closing: null, position: lines(100n, 300n) },
      { closing: null, position: lines(90n, 280n) },
      { closing: null, position: lines(80n, 260n) },
    ]);
    expect(await closeRheaRounds({ account: "0ua.testnet", slippageBps: 100, poolId: 1, ...slow, maxRounds: 2 })).toMatchObject({ closed: false, stopped: "max_rounds", status: { kind: "open", debt: "80" } });
  });

  test("the client reads closing() and the lending position from the chain", async () => {
    const rpc = mockFetch(
      rpcRoute({
        views: {
          "0ua.testnet.closing": () => closingAt("stuck_verify"),
          "0ub.testnet.closing": () => null,
          "lending.parry.testnet.get_account": (args) => (args["account_id"] === "0ua.testnet" ? { account_id: "0ua.testnet", supplied: [], collateral: [{ token_id: "wrap.testnet", balance: "7", shares: "7", apr: "0" }], borrowed: [{ token_id: "usdc.parry.testnet", balance: "3", shares: "3", apr: "0" }], farms: [] } : null),
        },
      }),
    );
    restore = installGlobalFetch(rpc.fetch);
    const parry = createParry({ network: "testnet", rpcUrl: RPC_URL });
    expect((await parry.closing("0ua.testnet"))?.stage).toBe("stuck_verify");
    expect(await parry.closing("0ub.testnet")).toBeNull();
    expect(await parry.rheaPosition("0ua.testnet")).toEqual({ collateral: [{ token_id: "wrap.testnet", balance: "7" }], supplied: [], borrowed: [{ token_id: "usdc.parry.testnet", balance: "3" }] });
    expect(await parry.rheaPosition("0ub.testnet")).toBeNull();
    const r = await parry.closeRheaRounds({ account: "0ua.testnet", slippageBps: 100, poolId: 1, sendOwnerActions: async () => ({ txHash: "x" }) });
    expect(r).toMatchObject({ closed: false, stopped: "stuck" });
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
