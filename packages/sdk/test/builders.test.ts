import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildMandate,
  contractCall,
  createParry,
  nearKitCallOptions,
  NETWORKS,
  openPolicy,
  ownerActions,
  ownerCallAction,
  ownerRequest,
  requestDigest,
} from "../src/index.js";
import { formatEd25519PublicKey, fromBase64, fromUtf8, toBase64Url, toHex, utf8 } from "../src/encoding.js";

const GUARDIAN = formatEd25519PublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(5)));
const ACCOUNT = "0u5a6b7c8d.testnet";
const NOW = 1_800_000_000;

describe("owner actions", () => {
  test("every builder produces the contract's snake_case JSON", () => {
    const order = { asset_index: 54, is_buy: false, price: "3.21", size: "10", reduce_only: true, tif: "Ioc" };
    expect(ownerActions.revokeMandate()).toBe("revoke_mandate");
    expect(ownerActions.clearPending()).toBe("clear_pending");
    expect(ownerActions.pauseGuardian(NOW)).toEqual({ pause_guardian: { until: NOW } });
    expect(ownerActions.pauseGuardian(new Date(NOW * 1000))).toEqual({ pause_guardian: { until: NOW } });
    expect(ownerActions.supply("wrap.testnet", 10n ** 24n)).toEqual({ supply: { token: "wrap.testnet", amount: "1000000000000000000000000" } });
    expect(ownerActions.borrow("usdc.parry.testnet", "5000000")).toEqual({ borrow: { token: "usdc.parry.testnet", amount: "5000000" } });
    expect(ownerActions.repay("usdc.parry.testnet", 7)).toEqual({ repay: { token: "usdc.parry.testnet", amount: "7" } });
    expect(ownerActions.withdraw("wrap.testnet", "1")).toEqual({ withdraw: { token: "wrap.testnet", amount: "1" } });
    expect(ownerActions.transfer("alice.testnet", 5n)).toEqual({ transfer: { receiver_id: "alice.testnet", amount: "5" } });
    expect(ownerActions.ftTransfer("usdc.parry.testnet", "bob.testnet", "9")).toEqual({
      ft_transfer: { token: "usdc.parry.testnet", receiver_id: "bob.testnet", amount: "9" },
    });
    expect(ownerActions.mpcSign("parry-evm", `0x${"AB".repeat(32)}`)).toEqual({ mpc_sign: { path: "parry-evm", payload: "ab".repeat(32), domain_id: 0 } });
    expect(ownerActions.hlOrder(order, 1_700_000_000_000)).toEqual({ hl_order: { order, nonce: 1_700_000_000_000 } });
    expect(ownerActions.upgrade("4hYbLQZx7mHHUqsr1CBr6RLtSuFLNPcEspCw3gpivtrn")).toEqual({ upgrade: { code_hash: "4hYbLQZx7mHHUqsr1CBr6RLtSuFLNPcEspCw3gpivtrn" } });
    const call = ownerActions.call({ receiverId: "lending.parry.testnet", methodName: "storage_deposit", args: { registration_only: true }, deposit: 10n ** 22n, tgas: 15 });
    expect(call).toEqual({
      call: {
        receiver_id: "lending.parry.testnet",
        method_name: "storage_deposit",
        args: "eyJyZWdpc3RyYXRpb25fb25seSI6dHJ1ZX0=",
        deposit: "10000000000000000000000",
        gas: "15000000000000",
      },
    });
    const mandate = buildMandate({ account: ACCOUNT, guardianKey: GUARDIAN, powers: ["repay"], limits: [], maxActionsPerDay: 1, minHealthAfterBps: 10_500, maxSlippageBps: 0, expiresAt: NOW + 60, now: NOW });
    expect(ownerActions.setMandate(mandate)).toEqual({ set_mandate: { mandate } });
  });

  test("builders refuse values the contract would refuse", () => {
    expect(() => ownerActions.supply("wrap.testnet", -1)).toThrow();
    expect(() => ownerActions.supply("wrap.testnet", "1.5")).toThrow();
    expect(() => ownerActions.mpcSign("p", "abcd")).toThrow("32-byte");
    expect(() => ownerActions.mpcSign("p", "ab".repeat(32), 1)).toThrow("domain 0");
    expect(() => ownerActions.call({ receiverId: "x.testnet", methodName: "m", tgas: 301 })).toThrow("tgas");
    expect(() => ownerCallAction(ACCOUNT, [])).toThrow("no actions");
    expect(() => ownerCallAction(ACCOUNT, [ownerActions.mpcSign("p", "00".repeat(32)), "revoke_mandate"])).toThrow("only action");
  });

  test("ownerCallAction is owner_call with 1 yoctoNEAR and 300 Tgas, for wallets and near-kit", () => {
    const call = ownerCallAction(ACCOUNT, [ownerActions.repay("usdc.parry.testnet", "5")]);
    expect(call).toEqual({
      receiverId: ACCOUNT,
      methodName: "owner_call",
      args: { actions: [{ repay: { token: "usdc.parry.testnet", amount: "5" } }] },
      gas: "300000000000000",
      deposit: "1",
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "owner_call", args: { actions: [{ repay: { token: "usdc.parry.testnet", amount: "5" } }] }, gas: "300000000000000", deposit: "1" },
        },
      ],
    });
    expect(nearKitCallOptions(call)).toEqual({ gas: "300000000000000", attachedDeposit: 1n });
  });
});

describe("owner requests (passkeys)", () => {
  test("the request text and its challenge", () => {
    const r = ownerRequest({ account: ACCOUNT, network: "testnet", nonce: 3, createdAt: NOW, actions: ["revoke_mandate"] });
    expect(r.text).toBe(`{"account":"${ACCOUNT}","network":"testnet","nonce":3,"created_at":${NOW},"actions":["revoke_mandate"]}`);
    const want = sha256(utf8(`parry-account:v1:${r.text}`));
    expect(toHex(r.challenge)).toBe(toHex(want));
    expect(toHex(requestDigest(r.text))).toBe(toHex(want));
    expect(r.challengeBase64Url).toBe(toBase64Url(want));
    expect(r.challengeBase64Url).not.toMatch(/[=+/]/);
  });

  test("a known digest", () => {
    // SHA-256("parry-account:v1:{}"), computed independently.
    expect(toHex(requestDigest("{}"))).toBe(toHex(sha256(utf8("parry-account:v1:{}"))));
    expect(toHex(requestDigest("{}"))).toHaveLength(64);
  });

  test("the network comes from the client", () => {
    const parry = createParry({ network: "mainnet" });
    const r = parry.ownerRequest({ account: "0uabc.near", nonce: 1, createdAt: NOW, actions: ["clear_pending"] });
    expect(JSON.parse(r.text).network).toBe("mainnet");
    expect(() => ownerRequest({ account: ACCOUNT, network: "testnet", nonce: 0, actions: ["revoke_mandate"] })).toThrow("nonce");
  });
});

describe("mandates", () => {
  const base = {
    account: ACCOUNT,
    guardianKey: GUARDIAN,
    powers: ["repay", "add_collateral", "deleverage"] as const,
    limits: [{ token: "usdc.parry.testnet", reserve: 200_000_000n, daily: "120000000" }],
    maxActionsPerDay: 10,
    minHealthAfterBps: 10_500,
    maxSlippageBps: 200,
    expiresAt: NOW + 30 * 86_400,
    now: NOW,
  };

  test("builds the contract's Mandate JSON", () => {
    const m = buildMandate({ ...base, powers: [...base.powers] });
    expect(m).toEqual({
      guardian_key: GUARDIAN,
      powers: ["repay", "add_collateral", "deleverage"],
      limits: [{ token: "usdc.parry.testnet", reserve: "200000000", daily: "120000000" }],
      max_actions_per_day: 10,
      min_health_after_bps: 10_500,
      max_slippage_bps: 200,
      hl: null,
      evm: null,
      sealed: null,
      expires_at: NOW + 30 * 86_400,
    });
  });

  test("guards are written in snake_case", () => {
    const m = buildMandate({
      ...base,
      powers: ["hl_reduce", "evm_repay"],
      hl: { asset: "NEAR", assetIndex: 54, maxSizeE8: 10n ** 9n, bandBps: 150, hedgeIsBuy: false },
      evm: { chainId: 84532, pool: `0x${"11".repeat(20)}`, asset: `0x${"22".repeat(20)}`, address: `0x${"33".repeat(20)}`, maxAmount: "1000000" },
    });
    expect(m.hl).toEqual({ asset: "NEAR", asset_index: 54, max_size_e8: "1000000000", band_bps: 150, hedge_is_buy: false });
    expect(m.evm).toEqual({ chain_id: 84532, pool: `0x${"11".repeat(20)}`, asset: `0x${"22".repeat(20)}`, address: `0x${"33".repeat(20)}`, max_amount: "1000000" });
  });

  test("a policy is sealed to the enclave and bound to the account", () => {
    const secret = sha256(utf8("enclave"));
    const policy = { triggerScore: 40, triggerHealth: 1.2, targetHealth: 1.6, strategy: "keep-exposure" as const };
    const m = buildMandate({ ...base, powers: ["repay"], policy, sealingPublicKey: toHex(x25519.getPublicKey(secret)) });
    expect(m.sealed).toBeString();
    expect(fromBase64(m.sealed!).length).toBeLessThanOrEqual(2048);
    expect(openPolicy(m.sealed!, { account: ACCOUNT, secret })).toEqual({ ...policy, hlReduceFraction: 0.25, evmTriggerHealth: 1.2 });
    expect(() => openPolicy(m.sealed!, { account: "0uother.testnet", secret })).toThrow("does not open");
  });

  test("refuses what the contract refuses", () => {
    const bad: [Partial<Parameters<typeof buildMandate>[0]>, string][] = [
      [{ guardianKey: "secp256k1:abc" }, "ed25519"],
      [{ powers: [] }, "at least one power"],
      [{ powers: ["withdraw" as never] }, "unknown power"],
      [{ maxActionsPerDay: 0 }, "1 to 48"],
      [{ maxActionsPerDay: 49 }, "1 to 48"],
      [{ minHealthAfterBps: 10_499 }, "1.05"],
      [{ maxSlippageBps: 301 }, "3%"],
      [{ expiresAt: NOW }, "expired"],
      [{ expiresAt: NOW + 181 * 86_400 }, "180 days"],
      [{ powers: ["hl_hedge"] }, "Hyperliquid guard"],
      [{ powers: ["evm_repay"] }, "EVM guard"],
      [{ limits: [{ token: "a.testnet", reserve: 1, daily: 1 }, { token: "a.testnet", reserve: 1, daily: 1 }] }, "duplicate"],
      [{ limits: Array.from({ length: 9 }, (_, i) => ({ token: `t${i}.testnet`, reserve: 1, daily: 1 })) }, "at most 8"],
      [{ hl: { asset: "NEAR", assetIndex: 54, maxSizeE8: 1, bandBps: 301, hedgeIsBuy: false } }, "1 to 300"],
      [{ evm: { chainId: 1, pool: "0x12", asset: `0x${"22".repeat(20)}`, address: `0x${"33".repeat(20)}`, maxAmount: 1 } }, "bad EVM address"],
      [{ policy: { triggerScore: 50, triggerHealth: 1.1, targetHealth: 1.4, strategy: "repay-first" } }, "sealingPublicKey"],
    ];
    for (const [patch, msg] of bad) expect(() => buildMandate({ ...base, powers: [...base.powers], ...patch } as Parameters<typeof buildMandate>[0])).toThrow(msg);
  });
});

describe("vault calls and networks", () => {
  const parry = createParry({ network: "testnet" });

  test("deposit, wNEAR deposit, withdraw request and claim", () => {
    const deposit = parry.vaultDepositAction(10n ** 24n);
    expect(deposit).toMatchObject({ receiverId: "vault.parry.testnet", methodName: "deposit", args: {}, gas: "150000000000000", deposit: "1000000000000000000000000" });
    const wnear = parry.vaultDepositWNearAction("2000000000000000000000000");
    expect(wnear).toMatchObject({
      receiverId: "wrap.testnet",
      methodName: "ft_transfer_call",
      args: { receiver_id: "vault.parry.testnet", amount: "2000000000000000000000000", msg: "deposit" },
      gas: "300000000000000",
      deposit: "1",
    });
    expect(parry.requestWithdrawAction(5n)).toMatchObject({ receiverId: "vault.parry.testnet", methodName: "request_withdraw", args: { shares: "5" }, deposit: "1" });
    expect(parry.claimAction()).toMatchObject({ receiverId: "vault.parry.testnet", methodName: "claim", args: {}, deposit: "0", gas: "150000000000000" });
    expect(deposit.actions[0]).toEqual({ type: "FunctionCall", params: { methodName: "deposit", args: {}, gas: "150000000000000", deposit: "1000000000000000000000000" } });
  });

  test("defaults per network, overrides, and contracts not deployed yet", () => {
    expect(parry.contracts).toEqual(NETWORKS.testnet.contracts);
    expect(parry.contracts.signer).toBe("v1.signer-prod.testnet");
    const main = createParry({ network: "mainnet" });
    expect(main.contracts.lending).toBe("contract.main.burrow.near");
    expect(main.contracts.usdc).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect(main.contracts.dex).toBe("v2.ref-finance.near");
    expect(main.contracts.signer).toBe("v1.signer");
    expect(main.notDeployed).toEqual(["factory", "vault", "risk"]);
    expect(() => main.vaultDepositAction(1n)).toThrow("not deployed on mainnet");
    const overridden = createParry({ network: "mainnet", contracts: { vault: "vault.example.near" } });
    expect(overridden.vaultDepositAction(1n).receiverId).toBe("vault.example.near");
    expect(overridden.notDeployed).toEqual(["factory", "risk"]);
    expect(() => createParry({ network: "localnet" as never })).toThrow("testnet");
  });

  test("a generic contract call", () => {
    const c = contractCall("x.testnet", "m", { a: 1 }, { tgas: 30 });
    expect(c.gas).toBe("30000000000000");
    expect(c.deposit).toBe("0");
    expect(fromUtf8(utf8(JSON.stringify(c.args)))).toBe('{"a":1}');
  });
});
