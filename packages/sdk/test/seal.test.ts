import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { openPolicy, policyJson, rustFloat, sealPolicy, type Policy } from "../src/index.js";
import { fromBase64, fromHex, toBase64, utf8 } from "../src/encoding.js";
import { sealedVector } from "./fixtures/vectors.js";

const secret = sha256(utf8("enclave sealing secret"));
const enclavePk = x25519.getPublicKey(secret);
const policy: Policy = { triggerScore: 60, triggerHealth: 1.15, targetHealth: 1.45, strategy: "repay-first" };

describe("sealed policies", () => {
  test("round trip", () => {
    const sealed = sealPolicy(policy, { account: "0uabc.testnet", sealingPublicKey: enclavePk });
    expect(sealed.length).toBe(32 + 12 + policyJson(policy).length + 16);
    expect(openPolicy(sealed, { account: "0uabc.testnet", secret })).toEqual({ ...policy, hlReduceFraction: 0.25, evmTriggerHealth: 1.2 });
    expect(openPolicy(toBase64(sealed), { account: "0uabc.testnet", secret }).strategy).toBe("repay-first");
  });

  test("random ephemeral key and nonce per seal", () => {
    const a = sealPolicy(policy, { account: "0uabc.testnet", sealingPublicKey: enclavePk });
    const b = sealPolicy(policy, { account: "0uabc.testnet", sealingPublicKey: enclavePk });
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  test("bound to the account and the enclave key, and tamper evident", () => {
    const sealed = sealPolicy(policy, { account: "0uabc.testnet", sealingPublicKey: enclavePk });
    expect(() => openPolicy(sealed, { account: "0uother.testnet", secret })).toThrow("does not open");
    expect(() => openPolicy(sealed, { account: "0uabc.testnet", secret: sha256(utf8("other")) })).toThrow("does not open");
    const flipped = sealed.slice();
    flipped[50]! ^= 1;
    expect(() => openPolicy(flipped, { account: "0uabc.testnet", secret })).toThrow("does not open");
    expect(() => openPolicy(sealed.subarray(0, 59), { account: "0uabc.testnet", secret })).toThrow("too short");
  });

  test("the plaintext is the enclave's Policy JSON", () => {
    expect(policyJson({ ...policy, targetHealth: 2, hlReduceFraction: 0.5, evmTriggerHealth: 1.3 })).toBe(
      '{"trigger_score":60,"trigger_health":1.15,"target_health":2.0,"strategy":"repay-first","hl_reduce_fraction":0.5,"evm_trigger_health":1.3}',
    );
    expect(() => policyJson({ ...policy, triggerScore: 101 })).toThrow("0 to 100");
    expect(() => policyJson({ ...policy, triggerHealth: 1.6 })).toThrow("at most 1.5");
    expect(() => policyJson({ ...policy, evmTriggerHealth: 1.6 })).toThrow("at most 1.5");
    expect(() => policyJson({ ...policy, strategy: "yolo" as never })).toThrow("strategy");
    expect(() => policyJson({ ...policy, hlReduceFraction: 2 })).toThrow("0 to 1");
    expect(() => policyJson({ ...policy, targetHealth: Number.NaN })).toThrow("finite");
  });

  test("numbers are written as serde_json writes an f64", () => {
    const cases: [number, string][] = [
      [0, "0.0"],
      [1, "1.0"],
      [2, "2.0"],
      [1.15, "1.15"],
      [0.25, "0.25"],
      [123456, "123456.0"],
      [1e15, "1000000000000000.0"],
      [1e16, "1e16"],
      [1.5e17, "1.5e17"],
      [0.0001, "0.0001"],
      [0.00001, "0.00001"],
      [0.000001, "1e-6"],
      [1.25e-7, "1.25e-7"],
      [-1.5, "-1.5"],
      [12345.678, "12345.678"],
    ];
    for (const [x, want] of cases) expect(rustFloat(x)).toBe(want);
  });

  test("refuses a key of the wrong size", () => {
    expect(() => sealPolicy(policy, { account: "a", sealingPublicKey: "abcd" })).toThrow("32 bytes");
  });

  test("the cross-language fixture matches what the SDK writes today", () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "sealed.json"), "utf8"));
    expect(committed).toEqual(sealedVector());
    expect(
      openPolicy(fromBase64(committed.sealed), { account: committed.account, secret: fromHex(committed.enclave_secret) }),
    ).toEqual({
      triggerScore: 55,
      triggerHealth: 1.15,
      targetHealth: 2,
      strategy: "keep-exposure",
      hlReduceFraction: 0.000001,
      evmTriggerHealth: 1.3,
    });
  });
});
