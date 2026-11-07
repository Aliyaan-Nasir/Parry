import { afterEach, describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { createParry, nearToYocto, yoctoToNear } from "../src/index.js";
import { fromBase58, fromBase64, toBase58, toBase64, toBase64Url, toHex } from "../src/encoding.js";
import { installGlobalFetch, json, mockFetch, RPC_URL, rpcRoute } from "./helpers.js";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const mandateView = {
  mandate: {
    guardian_key: "ed25519:11111111111111111111111111111111",
    powers: ["repay"],
    limits: [{ token: "usdc.parry.testnet", reserve: "200000000", daily: "120000000" }],
    max_actions_per_day: 10,
    min_health_after_bps: 10500,
    max_slippage_bps: 200,
    hl: null,
    evm: null,
    sealed: null,
    expires_at: 1_900_000_000,
  },
  set_at: 1,
  paused_until: 0,
  expired: false,
  spent: [["usdc.parry.testnet", "5"]],
  moved_today: [],
  actions_today: 0,
};

describe("chain reads (no API)", () => {
  test("factory, account, vault and risk board views", async () => {
    const seenArgs: unknown[] = [];
    const rpc = mockFetch(
      rpcRoute({
        views: {
          "accounts.parry.testnet.account_id_of": (args) => {
            seenArgs.push(args);
            return args["near_account"] ? "0unear.testnet" : "0upasskey.testnet";
          },
          "0uabc.testnet.mandate": () => mandateView,
          "0unone.testnet.mandate": () => null,
          "0uabc.testnet.nonces": () => [3, 9],
          "vault.parry.testnet.vault_state": () => ({ network: "testnet", paused: false, risk_score: 12 }),
          "risk.parry.testnet.get_enclave": () => ({ index: 1, public_key: "ed25519:abc", wasm_sha256: "00".repeat(32), since: 5, note: "v1" }),
          "risk.parry.testnet.sealing_key": () => ({ public_key: "11".repeat(32), run_id: 7, at: 8, key_index: 1 }),
        },
      }),
    );
    restore = installGlobalFetch(rpc.fetch);
    const parry = createParry({ network: "testnet", rpcUrl: RPC_URL });

    expect(await parry.protectedAccountId({ nearAccount: "alice.testnet" })).toBe("0unear.testnet");
    const key = p256.getPublicKey(p256.utils.randomSecretKey(), false);
    expect(await parry.protectedAccountId({ passkey: key })).toBe("0upasskey.testnet");
    expect(seenArgs).toEqual([
      { passkey: null, near_account: "alice.testnet" },
      { passkey: toHex(p256.Point.fromBytes(key).toBytes(true)), near_account: null },
    ]);
    expect(await parry.mandate("0uabc.testnet")).toEqual(mandateView as never);
    expect(await parry.mandate("0unone.testnet")).toBeNull();
    expect(await parry.nonces("0uabc.testnet")).toEqual({ owner: 3, guardian: 9 });
    expect((await parry.vaultState()).risk_score).toBe(12);
    expect(await parry.enclave()).toEqual({
      key: { index: 1, public_key: "ed25519:abc", wasm_sha256: "00".repeat(32), since: 5, note: "v1" },
      sealingKey: { public_key: "11".repeat(32), run_id: 7, at: 8, key_index: 1 },
    });
  });

  test("mainnet refuses Parry contracts that are not deployed, before any request", async () => {
    const rpc = mockFetch(() => json({}));
    restore = installGlobalFetch(rpc.fetch);
    const parry = createParry({ network: "mainnet", rpcUrl: RPC_URL });
    await expect(parry.vaultState()).rejects.toThrow("not deployed on mainnet");
    await expect(parry.enclave()).rejects.toThrow("not deployed on mainnet");
    await expect(parry.protectedAccountId({ nearAccount: "alice.near" })).rejects.toThrow("not deployed on mainnet");
    expect(rpc.seen).toHaveLength(0);
  });
});

describe("encodings", () => {
  test("base64, base64url, base58 and NEAR amounts", () => {
    const bytes = Uint8Array.from({ length: 70 }, (_, i) => (i * 37) % 256);
    for (let n = 0; n < 8; n++) {
      const b = bytes.subarray(0, n * 7 + (n % 3));
      expect(fromBase64(toBase64(b))).toEqual(b);
      expect(fromBase64(toBase64Url(b))).toEqual(b);
      expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
      expect(toBase64Url(b)).toBe(Buffer.from(b).toString("base64url"));
    }
    expect(toBase58(Uint8Array.of(0, 0, 1, 2))).toBe("115T");
    expect(fromBase58("115T")).toEqual(Uint8Array.of(0, 0, 1, 2));
    expect(nearToYocto("1")).toBe(10n ** 24n);
    expect(nearToYocto("0.5")).toBe(5n * 10n ** 23n);
    expect(nearToYocto(0.1)).toBe(10n ** 23n);
    expect(() => nearToYocto("1e-3")).toThrow();
    expect(() => nearToYocto("-1")).toThrow();
    expect(yoctoToNear(1_500_000_000_000_000_000_000_000n)).toBe("1.5");
    expect(yoctoToNear("1")).toBe("0.000000000000000000000001");
  });
});
