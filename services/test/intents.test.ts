import { describe, expect, test } from "bun:test";
import { createGrantCredential } from "@near-intents-agent-api/sdk";
import { confidentialRefill, INTENTS_USDC, INTENTS_WNEAR, intentsAgentApi, prepareRescueReserve, rescueReservePolicy } from "../src/lib/intents";

/** A recording stand-in for the Agent API: every request is kept, every answer is a plausible body. */
function recorder() {
  const calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fetchFn: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body });
    const reply = url.pathname.endsWith("/generate-intent")
      ? { type: "agent_create", correlation_id: "c-1", agent_id: "ag-1", intent: { standard: "nep413", payload: {} }, preview: { summary: "" } }
      : { quote: { amount_out: "24700000" }, warnings: [] };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch: fetchFn };
}

describe("confidential rescue reserve (NEAR Intents Agent API)", () => {
  test("exists only on mainnet, with a partner key", () => {
    expect(intentsAgentApi({ apiKey: "k", network: "testnet" })).toBeNull();
    expect(intentsAgentApi({ apiKey: "", network: "mainnet" })).toBeNull();
    expect(intentsAgentApi({ apiKey: "k", network: "mainnet" })).not.toBeNull();
  });

  test("the policy only swaps wNEAR and USDC privately and pays out only to the protected account", () => {
    const p = rescueReservePolicy("0uabc.near", { perSwapNearYocto: "10000000000000000000000000", dailyUsd: 500 });
    expect(p.actions).toEqual(["swap", "withdraw"]);
    expect(p.confidential).toBe(true);
    expect(p.assets).toEqual([INTENTS_WNEAR, INTENTS_USDC]);
    expect(p.destinations).toEqual({ mode: "only", list: [{ action: "withdraw", chain: "near", address: "0uabc.near", memo: null }] });
    expect(p.budget.daily_usd).toBe("500");
  });

  test("the owner signs the reserve's creation; Parry keeps only a grant", async () => {
    const r = recorder();
    const api = intentsAgentApi({ apiKey: "partner-key", network: "mainnet", fetch: r.fetch })!;
    const { intent, grant } = await prepareRescueReserve(api, { account_id: "alice.near", public_key: "ed25519:abc" }, "0uabc.near", { perSwapNearYocto: "1", dailyUsd: 100 });
    expect(intent.agent_id).toBe("ag-1");
    expect(grant.token.startsWith("ngt_")).toBe(true);
    const call = r.calls[0]!;
    expect(call.headers.get("x-api-key")).toBe("partner-key");
    expect((call.body as { owner: unknown }).owner).toEqual({ type: "near", account_id: "alice.near", public_key: "ed25519:abc" });
  });

  test("a dry refill previews a confidential swap and a withdrawal to the account, moving nothing", async () => {
    const r = recorder();
    const api = intentsAgentApi({ apiKey: "partner-key", network: "mainnet", fetch: r.fetch })!.forGrant(createGrantCredential().token);
    const out = await confidentialRefill(api, "ag-1", "0uabc.near", "10000000000000000000000000", "24000000", { dry: true });
    expect(out.dry).toBe(true);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]!.body).toMatchObject({ origin_asset: INTENTS_WNEAR, destination_asset: INTENTS_USDC, confidential: true, dry: true, min_amount_out: "24000000" });
    expect(r.calls[1]!.body).toMatchObject({ asset: INTENTS_USDC, chain: "near", recipient: "0uabc.near", dry: true });
    expect(r.calls.every((c) => c.headers.get("x-grant-token")?.startsWith("ngt_"))).toBe(true);
  });
});

describe("Hyperliquid margin route (1Click)", () => {
  test("quotes USDC on NEAR to USDC on HyperCore for the vault's address, as a dry run", async () => {
    const { marginQuote, HYPERCORE_USDC } = await import("../src/lib/routes");
    let sent: Record<string, unknown> = {};
    const fake = (async (_u: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ quote: { amountOut: "9967480400", depositAddress: "abc" } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await marginQuote(100, "0x8ba1f109551bd432803012645ac136ddd64dba72", fake);
    expect(sent).toMatchObject({ dry: true, destinationAsset: HYPERCORE_USDC, amount: "100000000", recipient: "0x8ba1f109551bd432803012645ac136ddd64dba72" });
    expect(r.quote).toEqual({ outUsd: 99.674804, depositAddress: "abc", dry: true });
  });
});
