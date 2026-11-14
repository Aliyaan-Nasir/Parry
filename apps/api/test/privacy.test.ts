import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "@parryguard/services/lib/db";
import { alertView } from "../src/stream";
import { decision, type DecisionRow } from "../src/views";

// A decision as the guardian stores it, in the formats enclave/src/modes.rs writes: the full plan
// names the owner's sealed target and step order, the review's reasoning their trigger.
const PLAN =
  "Repay 3.81 USDC from the reserve: health 1.122 to 1.450 (target 1.45). Chose repay: the first step in the order repay, add_collateral, deleverage, hl_reduce, evm_repay that the mandate allows and that moves health toward 1.45.";
const WHY = "Chose repay: the first step in the order repay, add_collateral, deleverage, hl_reduce, evm_repay that the mandate allows and that moves health toward 1.45.";
const REASONING = "Health 1.12 is below the owner's trigger of 1.15; repaying 3.81 USDC reaches the 1.45 target within the daily limit.";
const FACTS = { account: "0uowner.testnet", target_health: 1.45, owner_trigger: { score: 60, health: 1.15 }, plan: PLAN };
const PUBLIC_RECORD = JSON.stringify({ kind: "decision", id: "d-new", account: "0uowner.testnet", action: "repay", plan: "Repay 3.81 USDC from the reserve.", review: { review_hash: "aa" } });
const LEGACY_RECORD = JSON.stringify({ kind: "decision", id: "d-old", account: "0uowner.testnet", action: "repay", plan: PLAN, review: { review_hash: "bb" } });

const row = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: "d-old",
  account: "0uowner.testnet",
  venue: "rhea",
  action: "repay",
  plan: PLAN,
  public_plan: null,
  trigger: { score: 58, tier: "danger", health_bps: 11220 },
  outcome: "executed",
  review: { model: "z-ai/glm-5.3-flash", chat_id: "c1", review_hash: "bb", request_hash: "11", response_hash: "22", verdict: "approve", reasoning: REASONING, signing_address: "0xabc", signed_text: "m:11:22", signature: "0x00", signature_kind: "provider_tee" },
  envelope: '{"review_hash":"bb"}',
  envelope_signature: "c2ln",
  txs: { action: "tx-a", record: "tx-r" },
  health_before: 1.122,
  health_after: 1.45,
  routes: null,
  detail: "",
  explanation: { step: "repay", why: WHY, skipped: [{ step: "add_collateral", reason: "the Rhea loan is not at the owner's trigger" }] },
  facts: FACTS,
  decision_json: LEGACY_RECORD,
  decision_signature: "c2ln",
  created_at: new Date("2026-11-14T11:38:57Z"),
  ...over,
});

/** Everything that names the owner's sealed policy or the review's reasoning. */
const SECRETS = ["target", "owner's trigger", "the order", "1.450", "1.45 target", "Chose", "skipped", "owner_trigger", "target_health", REASONING.slice(0, 40)];
const leaks = (body: unknown) => SECRETS.filter((s) => JSON.stringify(body).includes(s));

describe("decision privacy (views)", () => {
  test("the public view carries the action and everything public verification needs, and nothing of the sealed policy", () => {
    const d = decision(row());
    expect(leaks(d)).toEqual([]);
    expect(d.plan).toBe("Repay 3.81 USDC from the reserve.");
    expect(d.publicPlan).toBe("Repay 3.81 USDC from the reserve.");
    expect(d.visibility).toBe("public");
    expect(d.explanation).toBeNull();
    expect("facts" in d).toBe(false);
    expect("reasoning" in d.review).toBe(false);
    // A record an earlier enclave build signed names the full plan: only the owner gets it.
    expect(d.decisionJson).toBeNull();
    expect(d.decisionSignature).toBeNull();
    expect(d.review).toMatchObject({ model: "z-ai/glm-5.3-flash", chatId: "c1", reviewHash: "bb", requestHash: "11", responseHash: "22", verdict: "approve", signingAddress: "0xabc", signedText: "m:11:22", signature: "0x00" });
    expect(d.review.reasoningHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toMatchObject({ id: "d-old", account: "0uowner.testnet", venue: "rhea", action: "repay", outcome: "executed", envelope: '{"review_hash":"bb"}', envelopeSignature: "c2ln" });
    expect(d.txs).toMatchObject({ action: "tx-a", record: "tx-r" });
  });

  test("the owner's view is the full record", () => {
    const d = decision(row(), { owner: true });
    expect(d.visibility).toBe("owner");
    expect(d.plan).toBe(PLAN);
    expect(d.review.reasoning).toBe(REASONING);
    expect(d.explanation?.why).toBe(WHY);
    expect(d.facts).toEqual(FACTS);
    expect(d.decisionJson).toBe(LEGACY_RECORD);
  });

  test("a new decision serves the enclave's public plan and its public signed record to everyone", () => {
    const d = decision(row({ id: "d-new", public_plan: "Repay 3.81 USDC from the reserve.", decision_json: PUBLIC_RECORD }));
    expect(d.plan).toBe("Repay 3.81 USDC from the reserve.");
    expect(d.decisionJson).toBe(PUBLIC_RECORD);
    expect(d.decisionSignature).toBe("c2ln");
    expect(leaks(d)).toEqual([]);
  });

  test("a stored public plan that names the policy is redacted anyway", () => {
    expect(decision(row({ public_plan: "Repay 3.81 USDC: health 1.122 to 1.450 (target 1.45)." })).plan).toBe("Repay 3.81 USDC from the reserve.");
  });

  test("a guardian alert written before the public plan reads redacted to everyone but the owner", () => {
    const a = { id: "1", account: "0uowner.testnet", kind: "guardian", severity: "info", title: "Guardian executed: add collateral", body: PLAN.replace("Repay 3.81 USDC", "Add 1.0000 wNEAR collateral"), status: "open", created_at: new Date(), updated_at: new Date() };
    expect(alertView(a).body).toBe("Add 1.0000 wNEAR collateral from the reserve.");
    expect(alertView(a, { owner: true }).body).toBe(a.body);
    expect(alertView({ ...a, kind: "risk", body: "Health 1.12 is under your alert threshold 1.2." }).body).toContain("threshold");
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("decision privacy (routes)", () => {
  const sql = postgres(url ?? "postgres://invalid", { onnotice: () => {} });
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  const owner = { authorization: "Bearer t-owner" };
  const stranger = { authorization: "Bearer t-stranger" };

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    const { createApp } = await import("../src/app");
    app = createApp(sql) as never;
    await sql`INSERT INTO auth_sessions (token, account, expires_at) VALUES ('t-owner', '0uowner.testnet', now() + interval '1 hour'), ('t-stranger', '0ustranger.testnet', now() + interval '1 hour')`;
    const r = row();
    await sql`INSERT INTO decisions (id, account, venue, action, plan, public_plan, trigger, outcome, review, envelope, envelope_signature, txs, health_before, health_after, detail, explanation, facts, decision_json, decision_signature)
      VALUES (${r.id}, ${r.account}, ${r.venue}, ${r.action}, ${r.plan}, ${null}, ${sql.json(r.trigger)}, ${r.outcome}, ${sql.json(r.review)}, ${r.envelope}, ${r.envelope_signature}, ${sql.json(r.txs as never)},
        ${r.health_before}, ${r.health_after}, ${r.detail}, ${sql.json(r.explanation as never)}, ${sql.json(r.facts as never)}, ${r.decision_json!}, ${r.decision_signature!})`;
    await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES ('0uowner.testnet', 'guardian', 'info', 'guardian:d-old', 'Guardian executed: repay', ${PLAN})`;
  });
  afterAll(() => sql.end());

  for (const [who, headers] of [["anonymous", {}], ["another signed-in account", stranger]] as const) {
    test(`${who}: the list, the record, the alerts and the incidents carry no target, trigger, order or reasoning`, async () => {
      const list = await app.request("/v1/guardian/decisions?account=0uowner.testnet", { headers });
      expect(list.headers.get("vary")?.toLowerCase()).toContain("authorization");
      const page = (await list.json()) as { items: { plan: string; visibility: string }[] };
      expect(page.items[0]).toMatchObject({ plan: "Repay 3.81 USDC from the reserve.", visibility: "public" });
      expect(leaks(page)).toEqual([]);
      expect(leaks(await (await app.request("/v1/guardian/decisions?limit=10", { headers })).json())).toEqual([]);
      expect(leaks(await (await app.request("/v1/guardian/decisions/d-old", { headers })).json())).toEqual([]);
      expect(leaks(await (await app.request("/v1/alerts?account=0uowner.testnet", { headers })).json())).toEqual([]);
    });
  }

  test("the decision's own account, signed in, gets the full record", async () => {
    const page = (await (await app.request("/v1/guardian/decisions?account=0uowner.testnet", { headers: owner })).json()) as { items: { plan: string; visibility: string; review: { reasoning: string }; facts: unknown }[] };
    expect(page.items[0]!.visibility).toBe("owner");
    expect(page.items[0]!.plan).toBe(PLAN);
    expect(page.items[0]!.review.reasoning).toBe(REASONING);
    expect(page.items[0]!.facts).toEqual(FACTS);
    const one = (await (await app.request("/v1/guardian/decisions/d-old", { headers: owner })).json()) as { plan: string };
    expect(one.plan).toBe(PLAN);
    const alerts = (await (await app.request("/v1/alerts?account=0uowner.testnet", { headers: owner })).json()) as { body: string }[];
    expect(alerts[0]!.body).toBe(PLAN);
  });

  test("the server-side verify answers for everyone without the private text", async () => {
    const v = await app.request("/v1/guardian/decisions/d-old/verify");
    expect(v.status).toBe(200);
    expect(leaks(await v.json())).toEqual([]);
  });
});
