import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { openPolicy, toBase58 } from "@parry/sdk";
import { configFromEnv, createMcpHttpHandler, createParryMcpServer, createUsageLedger, DEFAULT_CAPS, type ParryMcpOptions } from "../src/index.js";
import { closingAt, enclaveKey, fakeParry, genuineDecision, sealingSecret } from "./fixtures.js";

const agentSeed = sha256(utf8ToBytes("agent test key"));
const AGENT = { accountId: "agent.parry.testnet", privateKey: `ed25519:${toBase58(new Uint8Array([...agentSeed, ...ed25519.getPublicKey(agentSeed)]))}` };
const READ_TOOLS = [
  "get_position_risk",
  "risk_check",
  "get_market",
  "get_vault",
  "get_reserves",
  "get_guardian_log",
  "verify_guardian_decision",
  "simulate_rescue",
  "get_rescue_route",
  "get_status",
  "get_rates",
  "get_crash_replay",
  "get_liquidation_heatmap",
  "get_prices",
  "verify_record",
  "verify_certificate",
  "get_incidents",
  "get_route_savings",
  "get_closing",
];
const WRITE_TOOLS = ["create_protected_account", "set_mandate", "vault_deposit", "vault_withdraw", "close_position", "unwind_account", "paid_risk_check", "watch_account", "unwatch_account", "issue_certificate"];
/** A read tool that needs the agent's sign-in, so it is listed only with an agent. */
const AGENT_READ_TOOLS = ["list_watched"];

async function connect(opts: ParryMcpOptions) {
  const server = createParryMcpServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    return { error: r.isError === true, text, data: r.structuredContent as Record<string, unknown> | undefined };
  };
  return { client, call };
}

describe("tool listing", () => {
  test("read tools only, without an agent", async () => {
    const { client } = await connect({ parry: fakeParry().parry });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description).toContain("Changes nothing");
    }
  });

  test("write tools with an agent, each stating what it changes and its caps", async () => {
    const { client } = await connect({ parry: fakeParry().parry, agent: AGENT });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...AGENT_READ_TOOLS, ...WRITE_TOOLS].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of WRITE_TOOLS) {
      const t = byName[name]!;
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.description).toContain("Testnet only");
      expect(t.description).toContain("per UTC day");
      expect(t.description).toContain("Changes");
    }
    expect(byName["vault_deposit"]!.description).toContain("at most 1 NEAR per call and 5 call(s) per UTC day");
    expect(byName["create_protected_account"]!.description).toContain("at most 3 call(s)");
    expect(byName["set_mandate"]!.description).toContain("at most 10 call(s)");
    expect(byName["vault_withdraw"]!.description).toContain("at most 5 call(s)");
    expect(byName["set_mandate"]!.description).toContain("never move funds out");
    expect(byName["paid_risk_check"]!.description).toContain("at most 20 call(s)");
  });
});

describe("routes, status and paid checks", () => {
  test("get_rescue_route compares the Rhea pool with a dry-run NEAR Intents quote", async () => {
    const { client } = await connect({ parry: fakeParry().parry });
    const r = await client.callTool({ name: "get_rescue_route", arguments: { amount_near: 10 } });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain("chosen: intents");
  });

  test("get_status reports the services and the gas-key lanes", async () => {
    const { client } = await connect({ parry: fakeParry().parry });
    const r = await client.callTool({ name: "get_status", arguments: {} });
    expect(JSON.stringify(r.content)).toContain("All 2 services up");
    expect(JSON.stringify(r.structuredContent)).toContain("lanes");
  });

  test("paid_risk_check pays from the agent account within its cap", async () => {
    const fake = fakeParry();
    const { client } = await connect({ parry: fake.parry, agent: AGENT });
    const r = await client.callTool({ name: "paid_risk_check", arguments: { account: "alice.testnet" } });
    expect(r.isError).toBeFalsy();
    expect(fake.apiCalls).toContain(`PAID alice.testnet max 50000 by ${AGENT.accountId}`);
    expect(JSON.stringify(r.structuredContent)).toContain("paid-tx");
  });

  test("paid_risk_check refuses on mainnet before paying", async () => {
    const fake = fakeParry("mainnet");
    const { client } = await connect({ parry: fake.parry, agent: AGENT });
    const r = await client.callTool({ name: "paid_risk_check", arguments: { account: "alice.near" } });
    expect(r.isError).toBe(true);
    expect(fake.apiCalls.some((c) => c.startsWith("PAID"))).toBe(false);
  });
});

describe("read tools", () => {
  test("each returns its documented shape", async () => {
    const { call } = await connect({ parry: fakeParry().parry });
    const risk = await call("get_position_risk", { account: "0uabc.testnet" });
    expect(risk.error).toBe(false);
    expect(Object.keys(risk.data!).sort()).toEqual(["account", "evmAddress", "hyperliquidAddress", "mandate", "owner", "positions", "stats"]);
    expect(risk.text).toContain("score 64 (danger)");

    const check = await call("risk_check", { account: "alice.testnet" });
    expect(Object.keys(check.data!).sort()).toEqual(["account", "checkedAt", "market", "model", "position"]);

    const market = await call("get_market");
    expect(Object.keys(market.data!).sort()).toEqual(["cascade", "near", "tremor"]);

    const vault = await call("get_vault");
    expect(vault.data!["riskScore"]).toBe(18);
    expect(vault.text).toContain("Risk score 18");

    const reserves = await call("get_reserves");
    expect(Object.keys(reserves.data!).sort()).toEqual(["onChainRoot", "reserves", "verification"]);
    const verification = reserves.data!["verification"] as { ok: boolean; onChainMatches: boolean };
    expect(verification.ok).toBe(true);
    expect(verification.onChainMatches).toBe(true);
    expect(reserves.text).toStartWith("Verified");

    const log = await call("get_guardian_log", { account: "0uabc.testnet", limit: 5 });
    expect(Object.keys(log.data!).sort()).toEqual(["items", "next"]);
    expect(log.data!["items"]).toHaveLength(1);

    const sim = await call("simulate_rescue", { account: "0uabc.testnet" });
    expect(Object.keys(sim.data!).sort()).toEqual(["account", "reason", "routes", "steps", "triggered"]);
    expect(sim.text).toBe(`Would act: repay.\n\n${JSON.stringify(sim.data, null, 2)}`);
  });

  test("the guardian log passes its filters to the API", async () => {
    const f = fakeParry();
    const { call } = await connect({ parry: f.parry });
    await call("get_guardian_log", { account: "0uabc.testnet", limit: 5 });
    await call("get_guardian_log");
    expect(f.apiCalls.filter((c) => c.startsWith("GET /v1/guardian/decisions"))).toEqual([
      "GET /v1/guardian/decisions?account=0uabc.testnet&limit=5",
      "GET /v1/guardian/decisions?limit=10",
    ]);
  });

  test("verify_guardian_decision checks the decision against the risk board key", async () => {
    const { call } = await connect({ parry: fakeParry().parry });
    const v = await call("verify_guardian_decision", { id: genuineDecision().id });
    expect(v.error).toBe(false);
    expect(v.text).toStartWith("Verified.");
    expect(v.data!["enclavePublicKey"]).toBe(enclaveKey);
    expect((v.data!["verification"] as { checks: { status: string }[] }).checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
  });

  test("API failures come back as tool errors", async () => {
    const { call } = await connect({ parry: fakeParry().parry });
    const r = await call("get_position_risk", { account: "0unknown.testnet" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("404");
  });
});

describe("write tools", () => {
  test("vault_deposit: per-call cap and per-day count", async () => {
    const f = fakeParry();
    const { call } = await connect({ parry: f.parry, agent: AGENT });
    const big = await call("vault_deposit", { amount_near: 1.5 });
    expect(big.error).toBe(true);
    expect(big.text).toContain("at most 1 NEAR per call");
    for (let i = 0; i < DEFAULT_CAPS.depositPerDay; i++) {
      const r = await call("vault_deposit", { amount_near: "0.2" });
      expect(r.error).toBe(false);
      expect(r.data!["remainingToday"]).toBe(DEFAULT_CAPS.depositPerDay - i - 1);
    }
    const over = await call("vault_deposit", { amount_near: "0.2" });
    expect(over.error).toBe(true);
    expect(over.text).toContain("5 call(s) per UTC day");
    expect(f.sent).toHaveLength(5);
    expect(f.sent[0]).toMatchObject({ receiverId: "vault.parry.testnet", methodName: "deposit", deposit: "200000000000000000000000", gas: "150000000000000" });
  });

  test("vault_withdraw and create_protected_account are counted per day; the count resets the next UTC day", async () => {
    const f = fakeParry();
    let now = new Date("2026-11-10T23:59:00Z");
    const { call } = await connect({ parry: f.parry, agent: AGENT, now: () => now });
    for (let i = 0; i < 5; i++) expect((await call("vault_withdraw", { shares: "1000" })).error).toBe(false);
    expect((await call("vault_withdraw", { shares: "1000" })).text).toContain("cap is 5");
    for (let i = 0; i < 3; i++) expect((await call("create_protected_account")).data!["accountId"]).toBe("0uagent.testnet");
    expect((await call("create_protected_account")).error).toBe(true);
    expect(f.apiCalls.filter((c) => c === "POST /v1/relay/create-account")).toHaveLength(3);
    now = new Date("2026-11-11T00:01:00Z");
    expect((await call("vault_withdraw", { shares: "1000" })).error).toBe(false);
    expect(f.sent.filter((c) => c.methodName === "request_withdraw")).toHaveLength(6);
    expect(f.sent[0]).toMatchObject({ methodName: "request_withdraw", args: { shares: "1000" }, deposit: "1" });
  });

  test("set_mandate sends owner_call on the agent's protected account with a sealed policy, capped at 10 a day", async () => {
    const f = fakeParry();
    const { call } = await connect({ parry: f.parry, agent: AGENT, caps: { setMandatePerDay: 2 } });
    const args = {
      powers: ["repay", "add_collateral"],
      limits: [{ token: "usdc.parry.testnet", reserve: "200000000", daily: "100000000" }],
      expires_in_days: 7,
      policy: { trigger_score: 55, trigger_health: 1.2, target_health: 1.5, strategy: "repay-first" },
    };
    const r = await call("set_mandate", args);
    expect(r.error).toBe(false);
    const sent = f.sent[0]!;
    expect(sent).toMatchObject({ receiverId: "0uagent.testnet", methodName: "owner_call", deposit: "1", gas: "300000000000000" });
    const mandate = (sent.args["actions"] as { set_mandate: { mandate: { sealed: string } } }[])[0]!.set_mandate.mandate;
    expect(mandate).toMatchObject({ guardian_key: enclaveKey, powers: ["repay", "add_collateral"], max_actions_per_day: 4, min_health_after_bps: 11_000, max_slippage_bps: 100 });
    expect(openPolicy(mandate["sealed"], { account: "0uagent.testnet", secret: sealingSecret })).toMatchObject({ triggerScore: 55, strategy: "repay-first" });
    expect((await call("set_mandate", args)).error).toBe(false);
    const third = await call("set_mandate", args);
    expect(third.error).toBe(true);
    expect(third.text).toContain("cap is 2");
    expect(f.sent).toHaveLength(2);
    expect(DEFAULT_CAPS.setMandatePerDay).toBe(10);
  });

  test("close_position closes the agent's position in rounds through the API's pool, retrying a stuck round", async () => {
    const f = fakeParry("testnet", [
      { closing: null, debt: 100n, collateral: 300n },
      { closing: closingAt("stuck_repay"), debt: 60n, collateral: 200n },
      { closing: null, debt: 0n, collateral: 0n },
    ]);
    const { call } = await connect({ parry: f.parry, agent: AGENT });
    const r = await call("close_position", { slippage_bps: 200 });
    expect(r.error).toBe(false);
    expect(r.text).toContain("Closed the position on 0uagent.testnet in 2 round(s)");
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]).toMatchObject({ receiverId: "0uagent.testnet", methodName: "owner_call", deposit: "1", gas: "900000000000000", args: { actions: [{ close_rhea: { slippage_bps: 200, pool_id: 2939 } }] } });
    expect(f.sent[1]).toMatchObject({ receiverId: "0uagent.testnet", methodName: "retry_close", deposit: "0", gas: "400000000000000" });
    expect(r.data).toMatchObject({ closed: true, poolId: 2939, remainingToday: DEFAULT_CAPS.closePerDay - 1 });
    // Nothing to close: nothing is counted or sent.
    const again = await call("close_position", {});
    expect(again.text).toContain("nothing to close");
    expect(f.sent).toHaveLength(2);
    // Slippage above the cap is refused before anything is sent.
    expect((await call("close_position", { slippage_bps: 500 })).text).toContain("capped at 300 bps");
  });

  test("get_closing says where a close stands", async () => {
    const f = fakeParry("testnet", [{ closing: closingAt("stuck_withdraw_out"), debt: 5n, collateral: 9n }]);
    const { call } = await connect({ parry: f.parry });
    const r = await call("get_closing", { account: "0uabc.testnet" });
    expect(r.text).toContain("stuck at stuck_withdraw_out");
    expect(r.data!["status"]).toMatchObject({ kind: "stuck" });
  });

  test("unwind_account sends everything home to the agent account with the gas the unwind needs", async () => {
    const f = fakeParry();
    const { call } = await connect({ parry: f.parry, agent: AGENT, caps: { unwindPerDay: 1 } });
    const r = await call("unwind_account", {});
    expect(r.error).toBe(false);
    expect(f.sent[0]).toMatchObject({ receiverId: "0uagent.testnet", methodName: "owner_call", deposit: "1", gas: "660000000000000", args: { actions: [{ unwind: { tokens: ["usdc.parry.testnet", "wrap.testnet"] } }] } });
    expect((await call("unwind_account", {})).text).toContain("cap is 1");
    expect(f.sent).toHaveLength(1);
  });

  test("invalid input is refused before anything is counted or sent", async () => {
    const f = fakeParry();
    const { call } = await connect({ parry: f.parry, agent: AGENT });
    expect((await call("set_mandate", { powers: ["withdraw"], limits: [] })).error).toBe(true);
    expect((await call("vault_withdraw", { shares: "0" })).error).toBe(true);
    expect((await call("vault_deposit", { amount_near: "1e3" })).error).toBe(true);
    expect(f.sent).toHaveLength(0);
  });

  test("mainnet: every write tool refuses and nothing is read or sent", async () => {
    const f = fakeParry("mainnet");
    const { call } = await connect({ parry: f.parry, agent: AGENT });
    const results = [
      await call("create_protected_account"),
      await call("set_mandate", { powers: ["repay"], limits: [] }),
      await call("vault_deposit", { amount_near: "0.1" }),
      await call("vault_withdraw", { shares: "10" }),
      await call("close_position", {}),
      await call("unwind_account", {}),
    ];
    for (const r of results) {
      expect(r.error).toBe(true);
      expect(r.text).toContain("testnet only");
      expect(r.text).toContain("mainnet");
    }
    expect(f.sent).toHaveLength(0);
    expect(f.apiCalls).toHaveLength(0);
  });
});

describe("Streamable HTTP", () => {
  const post = (body: unknown) =>
    new Request("https://api.parry.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });

  test("initialize, list tools and call one, statelessly", async () => {
    const handler = createMcpHttpHandler({ parry: fakeParry().parry });
    const init = await handler(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(initBody.result.serverInfo.name).toBe("parry");
    expect(initBody.result.instructions).toContain("testnet");
    const list = await handler(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools.sort()).toEqual([...READ_TOOLS].sort());
    const market = await handler(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_market", arguments: {} } }));
    const result = ((await market.json()) as { result: { structuredContent: { near: { priceUsd: number } } } }).result;
    expect(result.structuredContent.near.priceUsd).toBe(3.2);
  });

  test("GET is not allowed on the stateless endpoint", async () => {
    const res = await createMcpHttpHandler({ parry: fakeParry().parry })(new Request("https://api.parry.example/mcp"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("write caps hold across requests through the shared ledger", async () => {
    const f = fakeParry();
    const handler = createMcpHttpHandler({ parry: f.parry, agent: AGENT, ledger: createUsageLedger(), caps: { createPerDay: 1 } });
    const create = (id: number) => handler(post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "create_protected_account", arguments: {} } }));
    const first = ((await (await create(1)).json()) as { result: { isError?: boolean } }).result;
    const second = ((await (await create(2)).json()) as { result: { isError?: boolean } }).result;
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBe(true);
  });
});

describe("configuration from the environment", () => {
  test("defaults to testnet, read-only", () => {
    const c = configFromEnv({ PARRY_API_URL: "https://api.parry.example" });
    expect(c.options.parry.network).toBe("testnet");
    expect(c.options.agent).toBeUndefined();
  });

  test("an agent needs both variables and an ed25519 key", () => {
    expect(() => configFromEnv({ PARRY_AGENT_ACCOUNT_ID: "a.testnet" })).toThrow("both");
    expect(() => configFromEnv({ PARRY_AGENT_ACCOUNT_ID: "a.testnet", PARRY_AGENT_PRIVATE_KEY: "secp256k1:abc" })).toThrow("ed25519");
    const c = configFromEnv({ PARRY_AGENT_ACCOUNT_ID: AGENT.accountId, PARRY_AGENT_PRIVATE_KEY: AGENT.privateKey });
    expect(c.options.agent?.accountId).toBe(AGENT.accountId);
    expect(c.notes.join(" ")).not.toContain(AGENT.privateKey);
  });

  test("mainnet notes that writes refuse; bad networks fail", () => {
    const c = configFromEnv({ PARRY_NETWORK: "mainnet", PARRY_AGENT_ACCOUNT_ID: "a.near", PARRY_AGENT_PRIVATE_KEY: AGENT.privateKey });
    expect(c.options.parry.network).toBe("mainnet");
    expect(c.notes.join(" ")).toContain("refuse every call on mainnet");
    expect(() => configFromEnv({ PARRY_NETWORK: "localnet" })).toThrow("testnet or mainnet");
  });
});

describe("market, replay, verification and incident tools", () => {
  test("read the API and summarise", async () => {
    const { call } = await connect({ parry: fakeParry().parry });
    const rates = await call("get_rates");
    expect(rates.error).toBe(false);
    expect(rates.text).toContain("1 Rhea assets; Hyperliquid NEAR funding 10.95 % a year");
    const replay = await call("get_crash_replay");
    expect(replay.text).toContain("median warning 44 h");
    expect((replay.data!["crashes"] as { guardianSteps: number }[])[0]!.guardianSteps).toBe(0);
    expect((await call("get_liquidation_heatmap", { network: "testnet" })).text).toContain("1 borrowers on testnet");
    expect((await call("get_prices", { tokens: ["wNEAR"] })).text).toContain("1 price(s)");
    expect((await call("verify_record", { id: "ab".repeat(32) })).text).toContain("certificate: verified");
    expect((await call("get_incidents", { account: "0uabc.testnet" })).text).toContain("1 open");
    expect((await call("get_route_savings")).text).toContain("$1.50");
  });

  test("verify_certificate checks the reader independently", async () => {
    const { call } = await connect({ parry: fakeParry().parry });
    const okay = await call("verify_certificate", { hash: "ab".repeat(32), reader: "lender.testnet" });
    expect(okay.text).toStartWith("Verified: health is at least 1.3");
    const other = await call("verify_certificate", { hash: "ab".repeat(32), reader: "someone.testnet" });
    expect(other.text).toContain("NOT verified: reader failed");
  });
});

describe("watch and certificate tools", () => {
  test("sign in once with the agent key and act as the agent's protected account", async () => {
    const fake = fakeParry();
    const { call } = await connect({ parry: fake.parry, agent: AGENT });
    const listed = await call("list_watched");
    expect(listed.text).toContain("1 watched account(s)");
    const watched = await call("watch_account", { account: "bob.testnet", score: 50, health: 1.2, label: "Bob" });
    expect(watched.error).toBe(false);
    expect(watched.data!["remainingToday"]).toBe(DEFAULT_CAPS.watchPerDay - 1);
    expect((await call("unwatch_account", { account: "bob.testnet" })).error).toBe(false);
    expect(fake.apiCalls.filter((c) => c.startsWith("POST /v1/auth/verify"))).toHaveLength(1);
    expect(fake.apiCalls).toContain("PUT /v1/watch/bob.testnet as Bearer agent-token");
    const cert = await call("issue_certificate", { reader: "lender.testnet", threshold: 1.3, ttl_secs: 3600 });
    expect(cert.error).toBe(false);
    expect(cert.data!["selfCheck"]).toBe(true);
  });

  test("certificates are capped by ttl and per day, and refused on mainnet", async () => {
    const { call } = await connect({ parry: fakeParry().parry, agent: AGENT, caps: { certificatesPerDay: 1 } });
    expect((await call("issue_certificate", { reader: "lender.testnet", threshold: 1.3, ttl_secs: 30 * 86_400 })).text).toContain("ttl_secs is at most");
    expect((await call("issue_certificate", { reader: "lender.testnet", threshold: 1.3, ttl_secs: 3600 })).error).toBe(false);
    expect((await call("issue_certificate", { reader: "lender.testnet", threshold: 1.3, ttl_secs: 3600 })).text).toContain("the cap is 1 call(s) per UTC day");
    const main = await connect({ parry: fakeParry("mainnet").parry, agent: AGENT });
    expect((await main.call("watch_account", { account: "bob.near", score: 50, health: 1.2 })).text).toContain("testnet only");
  });
});
