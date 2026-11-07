import { afterEach, describe, expect, test } from "bun:test";
import { createParry, ParryApiError, type Decision } from "../src/index.js";
import { installGlobalFetch, json, mockFetch, RPC_URL, rpcRoute } from "./helpers.js";

const API = "https://api.parry.example/";

describe("API reads", () => {
  test("each read calls its documented path and returns the body", async () => {
    const api = mockFetch((req) => json({ url: req.url, method: req.method, body: req.body ?? null }));
    const parry = createParry({ network: "testnet", apiUrl: API, fetch: api.fetch });
    const calls: [Promise<unknown>, string, string?][] = [
      [parry.stats(), "/v1/stats"],
      [parry.config(), "/v1/config"],
      [parry.market(), "/v1/market"],
      [parry.account("0uabc.testnet"), "/v1/accounts/0uabc.testnet"],
      [parry.positions("0uabc.testnet"), "/v1/accounts/0uabc.testnet/positions"],
      [parry.history("0uabc.testnet:rhea:main"), "/v1/positions/0uabc.testnet%3Arhea%3Amain/history?hours=24"],
      [parry.history("p", 6), "/v1/positions/p/history?hours=6"],
      [parry.riskCheck("alice.testnet"), "/v1/risk/alice.testnet"],
      [parry.simulate("0uabc.testnet"), "/v1/simulate/0uabc.testnet", "POST"],
      [parry.decisions(), "/v1/guardian/decisions"],
      [parry.decisions({ account: "0uabc.testnet", limit: 5, cursor: "c1" }), "/v1/guardian/decisions?account=0uabc.testnet&limit=5&cursor=c1"],
      [parry.decision("ab12"), "/v1/guardian/decisions/ab12"],
      [parry.verification("ab12"), "/v1/guardian/decisions/ab12/verify"],
      [parry.alerts("0uabc.testnet"), "/v1/alerts?account=0uabc.testnet"],
      [parry.alerts("0uabc.testnet", { status: "open" }), "/v1/alerts?account=0uabc.testnet&status=open"],
      [parry.vault(), "/v1/vault"],
      [parry.vaultHistory(), "/v1/vault/history?days=7"],
      [parry.vaultHistory(30), "/v1/vault/history?days=30"],
      [parry.reserves(), "/v1/vault/reserves"],
      [parry.rates(), "/v1/rates"],
      [parry.status(), "/v1/status"],
      [parry.rescueQuote(12.5), "/v1/quotes/rescue?amountNear=12.5"],
    ];
    for (const [promise, path, method] of calls) {
      const out = (await promise) as { url: string; method: string };
      expect(out.url).toBe(`https://api.parry.example${path}`);
      expect(out.method).toBe(method ?? "GET");
    }
    expect(api.seen.every((r) => r.headers["accept"] === "application/json")).toBe(true);
  });

  test("relays post the documented bodies", async () => {
    const api = mockFetch((req) => json({ txHash: "tx", accountId: "0unew.testnet", echo: req.body }));
    const parry = createParry({ network: "testnet", apiUrl: API, fetch: api.fetch });
    const assertion = { authenticator_data: "AAAA", client_data_json: "{}", signature: "00".repeat(64) };
    await parry.relayOwnerRequest('{"account":"0uabc.testnet"}', assertion);
    await parry.createProtectedAccount({ nearAccount: "alice.testnet" });
    await parry.createProtectedAccount({ passkey: `02${"11".repeat(32)}` });
    await parry.relayDelegate("BASE64");
    expect(api.seen.map((r) => [r.method, r.url.replace(API.slice(0, -1), ""), r.body, r.headers["content-type"]])).toEqual([
      ["POST", "/v1/relay/owner", { request: '{"account":"0uabc.testnet"}', assertion }, "application/json"],
      ["POST", "/v1/relay/create-account", { nearAccount: "alice.testnet" }, "application/json"],
      ["POST", "/v1/relay/create-account", { passkey: `02${"11".repeat(32)}` }, "application/json"],
      ["POST", "/v1/relay/delegate", { signedDelegateAction: "BASE64" }, "application/json"],
    ]);
  });

  test("errors carry the status and the body", async () => {
    const api = mockFetch(() => json({ error: "rate limited" }, { status: 429 }));
    const parry = createParry({ network: "testnet", apiUrl: API, fetch: api.fetch });
    const err = await parry.riskCheck("alice.testnet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParryApiError);
    expect((err as ParryApiError).status).toBe(429);
    expect((err as ParryApiError).body).toEqual({ error: "rate limited" });
    expect((err as Error).message).toBe("Parry API /v1/risk/alice.testnet answered 429: rate limited");
  });

  test("API reads need an apiUrl", async () => {
    const parry = createParry({ network: "testnet" });
    await expect(parry.market()).rejects.toThrow("no apiUrl");
  });
});

describe("verifyDecision on the client", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  test("reads the decision from the API and the enclave key from the risk board", async () => {
    const decision = { id: "ab", review: { signedText: "x", signature: "0x00", signingAddress: "0x00", reviewHash: "00" }, envelope: null } as unknown as Decision;
    const api = mockFetch((req) => (req.url.endsWith("/v1/guardian/decisions/ab") ? json(decision) : undefined));
    const rpc = mockFetch(
      rpcRoute({
        views: {
          "risk.parry.testnet.get_enclave": () => ({ index: 0, public_key: "ed25519:11111111111111111111111111111111", wasm_sha256: "00".repeat(32), since: 1, note: "" }),
          "risk.parry.testnet.sealing_key": () => null,
        },
      }),
    );
    restore = installGlobalFetch(rpc.fetch);
    const parry = createParry({ network: "testnet", apiUrl: API, rpcUrl: RPC_URL, fetch: api.fetch });
    const v = await parry.verifyDecision("ab");
    expect(v.id).toBe("ab");
    expect(v.ok).toBe(false);
    expect(rpc.seen.length).toBe(2);
  });
});
