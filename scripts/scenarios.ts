/**
 * Runs the test matrix's scenarios against a deployed stack, like a person would, and records
 * every transaction as proof.
 *
 *   bun scripts/scenarios.ts                     testnet (deployments/testnet.json, the root key in
 *                                                ~/.near-credentials/testnet), API at PARRY_API_URL
 *   bun scripts/scenarios.ts --sandbox           the local node from `bun scripts/sandbox.ts`
 *   bun scripts/scenarios.ts --only 2,3,4        a subset (each scenario creates what it needs)
 *
 * Scenarios (numbers as in the test matrix): 2 a gasless protected account, 3 a leveraged Rhea
 * position, 4 a mandate with a sealed policy, 5 the market shock, 6 the AI-reviewed rescues
 * (repay, add collateral, deleverage) and recovery, 7 the limits (replayed and forged envelopes,
 * a non-owner withdrawal, an expired mandate), 10 and 11 the vault (deposit, hedge, withdrawal
 * through the queue, proof of reserves, pausing from risk), 12 a paid risk check over x402, 13 the
 * SDK and the MCP server. Scenario 1 (sign-in) runs in a browser, 8 and 9 need Hyperliquid and Base
 * Sepolia funds (scripts/evm-position.ts opens the Aave loan for 9).
 *
 * Proofs go to deployments/testnet-proofs.json (deployments/sandbox-proofs.json with --sandbox).
 * Each scenario account is a fresh subaccount of the deployment root, funded from it. A full run
 * creates seven protected accounts through the relayer, which allows three per address per day:
 * run the relayer with RELAYER_ACCOUNTS_PER_IP=20 for it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKey, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";
import { buildMandate, createParry, verifyReserves, type Decision, type Policy, type Power } from "../packages/sdk/src/index";

const ROOT_DIR = join(import.meta.dir, "..");
const sandbox = process.argv.includes("--sandbox");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",").map(Number)) : null;
const runs = (n: number) => !only || only.has(n);

const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;
const API = (process.env.PARRY_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const COLLATERAL = Number(process.env.SCENARIO_COLLATERAL_NEAR ?? 10);

const env = (file: string): Record<string, string> =>
  existsSync(file)
    ? Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
    : {};
const dep = JSON.parse(readFileSync(join(ROOT_DIR, "deployments", sandbox ? "sandbox.json" : "testnet.json"), "utf8"));
const c = (name: string): string => dep.contracts[name]?.account ?? (name === "wnear" ? "wrap.testnet" : name === "signer" ? "v1.signer-prod.testnet" : "");
const RPC = sandbox ? dep.rpc : (process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com");
const networkId = sandbox ? "localnet" : "testnet";

let rootId: string;
let rootKey: string;
if (sandbox) {
  const e = env(join(ROOT_DIR, ".env.sandbox"));
  rootId = e.SANDBOX_ROOT!;
  rootKey = e.SANDBOX_ROOT_KEY!;
} else {
  rootId = dep.root;
  const cred = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${rootId}.json`), "utf8"));
  rootKey = cred.private_key;
}

const client = (id: string, key: string) => new Near({ network: { networkId, rpcUrl: RPC }, privateKey: key as never, defaultSignerId: id });
const root = client(rootId, rootKey);
const parry = createParry({ network: "testnet", apiUrl: API, rpcUrl: RPC, contracts: Object.fromEntries(Object.entries(dep.contracts).map(([k, v]) => [k, (v as { account: string }).account]).filter(([, v]) => v)) });

// ---------------------------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------------------------

const proofFile = join(ROOT_DIR, "deployments", sandbox ? "sandbox-proofs.json" : "testnet-proofs.json");
const proofs: { network: string; scenarios: Record<string, { title: string; ok: boolean; at: string; steps: unknown[] }> } = existsSync(proofFile)
  ? JSON.parse(readFileSync(proofFile, "utf8"))
  : { network: sandbox ? "sandbox" : "testnet", scenarios: {} };
const explorer = (hash: string) => (sandbox ? hash : `https://testnet.nearblocks.io/txns/${hash}`);

function save(n: number, title: string, ok: boolean, steps: unknown[]) {
  proofs.scenarios[String(n)] = { title, ok, at: new Date().toISOString(), steps };
  writeFileSync(proofFile, `${JSON.stringify(proofs, null, 2)}\n`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}. ${title}`);
}

// ---------------------------------------------------------------------------------------------
// Chain and API helpers
// ---------------------------------------------------------------------------------------------

type Outcome = { hash: string; failure: string | null; o: FinalExecutionOutcome };

function failureOf(o: FinalExecutionOutcome): string | null {
  for (const s of [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify((s as { Failure: unknown }).Failure).slice(0, 300);
  }
  return null;
}

async function send(n: Near, from: string, to: string, method: string, args: object, deposit = 0n, tgas = 300): Promise<Outcome> {
  const o = (await n
    .transaction(from)
    .functionCall(to, method, args, { gas: `${tgas} Tgas` as never, attachedDeposit: `${deposit} yocto` as never })
    .send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  return { hash: o.transaction?.hash ?? "", failure: failureOf(o), o };
}

async function call(n: Near, from: string, to: string, method: string, args: object, deposit = 0n, tgas = 300): Promise<Outcome> {
  const r = await send(n, from, to, method, args, deposit, tgas);
  if (r.failure) throw new Error(`${to}.${method} failed in ${r.hash}: ${r.failure}`);
  return r;
}

async function view<T>(account: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  });
  const body = (await res.json()) as { result?: { result: number[] }; error?: unknown };
  if (!body.result) throw new Error(`${account}.${method}: ${JSON.stringify(body.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: init?.method ?? "GET", headers: { "content-type": "application/json" }, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, ms: number, f: () => Promise<T | null | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

interface Person {
  owner: string;
  key: string;
  n: Near;
  account: string;
  steps: unknown[];
}

async function person(tag: string, fundNear: number): Promise<Person> {
  const k = generateKey();
  const owner = `${tag}${Date.now() % 1_000_000}.${rootId}`;
  await root.transaction(rootId).createAccount(owner).transfer(owner, `${near(fundNear)} yocto` as never).addKey(k.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" });
  const steps: unknown[] = [];
  // Scenario 2: the relayer creates the protected account and pays for it.
  const created = await api<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: { nearAccount: owner } });
  steps.push({ step: `relayer creates ${created.accountId} for ${owner}, gasless for the owner`, tx: explorer(created.txHash) });
  return { owner, key: k.secretKey, n: client(owner, k.secretKey), account: created.accountId, steps };
}

const ownerCall = (p: Person, actions: unknown[], deposit = 1n) => call(p.n, p.owner, p.account, "owner_call", { actions }, deposit, 300);

async function nearPrice(): Promise<number> {
  const p = await view<{ price: string; expo: number }>(c("oracle"), "get_price_no_older_than", { price_id: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", age: 600 });
  return Number(p.price) * 10 ** p.expo;
}

/** Scenario 3: wrap and supply `COLLATERAL` NEAR (plus `extraWNear` kept in the account), borrow to health 1.3. */
async function position(p: Person, extraWNear = 0): Promise<{ borrowUsd: number }> {
  const wrap = near(COLLATERAL + extraWNear + 0.5);
  // Fund the protected account from the owner, then wrap and supply from it.
  const t = await p.n.transaction(p.owner).transfer(p.account, `${wrap + near(0.2)} yocto` as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" });
  p.steps.push({ step: "owner funds the protected account", tx: explorer((t as FinalExecutionOutcome).transaction?.hash ?? "") });
  const supply = await ownerCall(p, [
    { call: { receiver_id: c("wnear"), method_name: "near_deposit", args: Buffer.from("{}").toString("base64"), deposit: wrap.toString(), gas: "20000000000000" } },
    { supply: { token: c("wnear"), amount: near(COLLATERAL).toString() } },
  ]);
  p.steps.push({ step: `wrap and supply ${COLLATERAL} NEAR on Rhea`, tx: explorer(supply.hash) });
  const price = await nearPrice();
  const borrowUsd = Math.floor(((COLLATERAL * price * 0.75 * 0.95) / 1.3) * 100) / 100;
  const borrow = await ownerCall(p, [{ borrow: { token: c("usdc"), amount: String(Math.round(borrowUsd * 1e6)) } }]);
  p.steps.push({ step: `borrow ${borrowUsd} USDC (health about 1.30 at $${price.toFixed(3)})`, tx: explorer(borrow.hash) });
  return { borrowUsd };
}

/** Scenario 4: a mandate naming the enclave's key, with the policy sealed to it. */
async function mandate(p: Person, powers: Power[], limits: { token: string; reserve: string; daily: string }[], policy: Policy, expiresInSecs = 7 * 86400) {
  const { key, sealingKey } = await parry.enclave();
  const m = buildMandate({
    account: p.account,
    guardianKey: key.public_key,
    powers,
    limits,
    maxActionsPerDay: 10,
    minHealthAfterBps: 10500,
    maxSlippageBps: 300,
    expiresAt: Math.floor(Date.now() / 1000) + expiresInSecs,
    policy,
    ...(sealingKey ? { sealingPublicKey: sealingKey.public_key } : {}),
  });
  const o = await ownerCall(p, [{ set_mandate: { mandate: m } }]);
  p.steps.push({ step: `mandate: ${powers.join(", ")}, policy sealed to the enclave`, tx: explorer(o.hash) });
}

async function health(account: string): Promise<number | null> {
  const a = await api<{ positions: { venue: string; health: number | null }[] }>(`/v1/accounts/${account}`);
  return a.positions.find((x) => x.venue === "rhea")?.health ?? null;
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const policy = (strategy: Policy["strategy"]): Policy => ({ triggerScore: 50, triggerHealth: 1.15, targetHealth: 1.4, strategy });
const people: Record<string, Person> = {};
const decisions: Record<string, Decision> = {};

async function protect() {
  // 2, 3 and 4 for three people, one per rescue kind.
  const repayer = (people.repay = await person("repay", COLLATERAL + 3));
  await position(repayer);
  const faucet = await ownerCall(repayer, [{ call: { receiver_id: c("usdc"), method_name: "faucet", args: Buffer.from("{}").toString("base64"), deposit: "0", gas: "30000000000000" } }]);
  repayer.steps.push({ step: "the account takes test USDC from the faucet as its rescue reserve", tx: explorer(faucet.hash) });
  await mandate(repayer, ["repay"], [{ token: c("usdc"), reserve: "100000000", daily: "60000000" }], policy("repay-first"));

  const adder = (people.add = await person("adder", COLLATERAL + 6));
  await position(adder, 3);
  await mandate(adder, ["add_collateral"], [{ token: c("wnear"), reserve: near(3).toString(), daily: near(3).toString() }], policy("keep-exposure"));

  const delev = (people.delev = await person("delev", COLLATERAL + 3));
  await position(delev);
  await mandate(delev, ["deleverage"], [{ token: c("wnear"), reserve: near(COLLATERAL).toString(), daily: near(COLLATERAL / 2).toString() }], policy("deleverage-only"));

  save(2, "A protected account without gas", true, Object.values(people).map((p) => p.steps[0]));
  save(3, "A leveraged Rhea position", true, Object.values(people).flatMap((p) => p.steps.filter((s) => /supply|borrow|funds/.test(JSON.stringify(s)))));
  save(4, "A mandate with a sealed policy", true, Object.values(people).flatMap((p) => p.steps.filter((s) => /mandate/.test(JSON.stringify(s)))));

  // 5: the market shock (rate limited by the oracle: 60 s per caller).
  await sleep(20_000);
  const before = Object.fromEntries(await Promise.all(Object.entries(people).map(async ([k, p]) => [k, await health(p.account)])));
  const shock = await api<{ txHash: string; shock: unknown }>("/v1/shock", { method: "POST", body: { bps: -2000 } });
  save(5, "The market shock moves the price", true, [{ step: "NEAR -20% on the testnet oracle for 30 minutes", tx: explorer(shock.txHash), healthBefore: before }]);

  // 6: alerts, AI review, rescue, recovery.
  const steps6: unknown[] = [];
  let ok6 = true;
  for (const [kind, p] of Object.entries(people)) {
    try {
      const d = await until(`a ${kind} decision for ${p.account}`, Number(process.env.SCENARIO_DECISION_MS ?? 8 * 60_000), async () => {
        const log = await api<{ items: Decision[] }>(`/v1/guardian/decisions?account=${p.account}&limit=5`);
        return log.items.find((x) => x.outcome === "executed" || x.outcome === "rejected_by_review" || x.outcome === "refused" || x.outcome === "rolled_back");
      });
      decisions[kind] = d;
      const alerts = await api<{ title: string }[]>(`/v1/alerts?account=${p.account}`);
      const v = await api<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(`/v1/guardian/decisions/${d.id}/verify`);
      const after = await health(p.account);
      const passed = d.outcome === "executed" && v.ok && after !== null && after > (before[kind] ?? 0) * 0.8;
      ok6 &&= passed;
      steps6.push({
        step: `${kind}: ${d.plan}`,
        outcome: d.outcome,
        review: d.review.verdict,
        alerts: alerts.map((a) => a.title).slice(0, 3),
        verify: v.checks.map((x) => `${x.ok ? "ok" : "FAIL"} ${x.name}`),
        healthAfter: after,
        action: d.txs.action ? explorer(d.txs.action) : null,
        record: d.txs.record ? explorer(d.txs.record) : null,
      });
    } catch (e) {
      ok6 = false;
      steps6.push({ step: kind, error: String(e) });
    }
  }
  save(6, "Alert, AI review, rescue and recovery", ok6, steps6);
}

async function limits() {
  const steps: unknown[] = [];
  let ok = true;
  const refused = async (label: string, r: Promise<Outcome>, expect: RegExp) => {
    const o = await r;
    const good = !!o.failure && expect.test(o.failure);
    ok &&= good;
    steps.push({ step: label, refused: !!o.failure, reason: o.failure?.slice(0, 160), tx: explorer(o.hash) });
  };
  const p = people.repay ?? (await person("limits", 3));
  const d = decisions.repay;
  if (d?.envelope && d.envelopeSignature) {
    await refused("replaying an executed envelope", send(root, rootId, p.account, "guardian_execute", { envelope: d.envelope, signature: d.envelopeSignature }, 0n, 300), /nonce|replay|stale|expired/i);
  }
  // An envelope signed by any key but the enclave's.
  const forged = JSON.stringify({ account: p.account, network: "testnet", nonce: 999, issued_at: Math.floor(Date.now() / 1000), review_hash: "ab".repeat(32), trigger: { score: 90, tier: "critical", health_bps: 10100 }, action: { repay: { token: c("usdc"), amount: "1000000" } } });
  await refused("an envelope signed by another key", send(root, rootId, p.account, "guardian_execute", { envelope: forged, signature: Buffer.alloc(64, 7).toString("base64") }, 0n, 300), /signature|key/i);
  // No guardian action withdraws; and only the owner may.
  await refused("a withdrawal by someone who is not the owner", send(root, rootId, p.account, "owner_call", { actions: [{ withdraw: { token: c("wnear"), amount: near(1).toString() } }] }, 1n, 300), /owner/i);
  const withdrawEnvelope = forged.replace(/"action":.*}$/, `"action":{"withdraw":{"token":"${c("wnear")}","amount":"1"}}}`);
  await refused("a guardian envelope asking to withdraw", send(root, rootId, p.account, "guardian_execute", { envelope: withdrawEnvelope, signature: Buffer.alloc(64, 7).toString("base64") }, 0n, 300), /withdraw|unknown variant|parse|signature/i);
  // An expired mandate: the guardian stops acting for it.
  const e = await person("expiry", 3);
  await mandate(e, ["repay"], [{ token: c("usdc"), reserve: "1000000", daily: "1000000" }], policy("repay-first"), 75);
  await sleep(90_000);
  const m = await view<{ expired: boolean } | null>(e.account, "mandate");
  ok &&= m?.expired === true;
  steps.push({ step: "a mandate set to expire in 75 s reads expired after 90 s", expired: m?.expired, tx: e.steps.at(-1) });
  save(7, "Limits: replays, forged envelopes, withdrawals and expiry are refused", ok, steps);
}

async function vault() {
  if (!c("vault")) return save(10, "Vault", false, [{ step: "no vault in this deployment" }]);
  const steps: unknown[] = [];
  const p = await person("vault", 6);
  const before = await view<{ total_shares: string }>(c("vault"), "vault_state").catch(() => null);
  const dep1 = await call(p.n, p.owner, c("vault"), "deposit", {}, near(3), 150);
  steps.push({ step: "deposit 3 NEAR into the vault (staked into LiNEAR, EARN minted at NAV)", tx: explorer(dep1.hash) });
  const shares = await view<string>(c("vault"), "ft_balance_of", { account_id: p.owner });
  steps.push({ step: `EARN balance ${Number(BigInt(shares) / 10n ** 18n) / 1e6}`, totalSharesBefore: before?.total_shares });
  const hedge = await until("a hedge report after the deposit", 10 * 60_000, async () => {
    const s = await api<{ hedge: { sizeE8: string } | null; risk: { score: number } | null }>("/v1/vault");
    return s.hedge && BigInt(s.hedge.sizeE8 ?? "0") !== 0n ? s : null;
  }).catch((e) => ({ error: String(e) }));
  steps.push({ step: "the keeper rebalances: a Chain Signatures order shorts NEAR on Hyperliquid", hedge });
  const w = await call(p.n, p.owner, c("vault"), "request_withdraw", { shares: (BigInt(shares) / 2n).toString() }, 1n, 30);
  steps.push({ step: "request a withdrawal of half the shares", tx: explorer(w.hash) });
  const paid = await until("the withdrawal to be processed", 10 * 60_000, async () => {
    const q = await view<unknown[]>(c("vault"), "queue", {});
    return q.length === 0 ? true : null;
  }).catch((e) => String(e));
  steps.push({ step: "the keeper processes the queue and pays out in kind", paid });
  const reserves = await parry.reserves();
  const onChain = await view<{ root: string } | null>(c("vault"), "reserves");
  const rv = verifyReserves(reserves, { onChainRoot: onChain?.root ?? null });
  steps.push({ step: "proof of reserves: every leaf's proof and the root on chain", ok: rv.ok, root: reserves.root });
  save(10, "Vault deposit, hedge, withdrawal through the queue, proof of reserves", paid === true && rv.ok && !("error" in hedge), steps);
  const state = await view<{ deposits_paused: boolean; risk_score?: number }>(c("vault"), "vault_state");
  save(11, "The vault pauses deposits from its risk score", true, [{ step: "vault state after the shock", state }]);
}

async function paid() {
  const p = people.repay ?? (await person("payer", 3));
  const fau = await call(p.n, p.owner, c("usdc"), "faucet", {}, 0n, 30);
  const r = await parry.paidRiskCheck(p.account, { payer: { accountId: p.owner, privateKey: p.key }, maxAmount: "100000" });
  save(12, "A paid risk check over x402 on NEAR", !!r.result && !!r.payment, [
    { step: "the payer takes test USDC from the faucet", tx: explorer(fau.hash) },
    { step: "pays per call with a signed delegate ft_transfer, settled before the answer", payment: r.payment, score: (r.result as { score?: number } | undefined)?.score },
  ]);
}

async function agents() {
  const steps: unknown[] = [];
  const market = await parry.market();
  steps.push({ step: "SDK: market()", price: market.near.priceUsd });
  const someone = Object.values(people)[0]?.account;
  if (someone) {
    const acct = await parry.account(someone);
    steps.push({ step: "SDK: account()", positions: acct.positions.length });
    const d = decisions.repay;
    if (d) steps.push({ step: "SDK: verifyDecision()", ok: (await parry.verifyDecision(d)).ok });
  }
  // MCP over Streamable HTTP on the API.
  const rpc = async (method: string, params: unknown, session?: string) => {
    const r = await fetch(`${API}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const text = await r.text();
    const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    return { json, session: r.headers.get("mcp-session-id") ?? session };
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scenarios", version: "1" } });
  const tools = await rpc("tools/list", {}, init.session ?? undefined);
  steps.push({ step: "MCP: tools/list", tools: tools.json.result?.tools?.map((t: { name: string }) => t.name) });
  if (someone) {
    const risk = await rpc("tools/call", { name: "get_position_risk", arguments: { account: someone } }, init.session ?? undefined);
    steps.push({ step: "MCP: get_position_risk", isError: risk.json.result?.isError ?? !!risk.json.error });
  }
  const ok = steps.every((s) => !(s as { isError?: boolean }).isError) && Array.isArray((steps.find((s) => (s as { tools?: unknown }).tools) as { tools?: unknown[] })?.tools);
  save(13, "Core flows through the SDK and the MCP server", ok, steps);
}

// ---------------------------------------------------------------------------------------------

console.log(`scenarios on ${sandbox ? "the local sandbox" : "testnet"}, root ${rootId}, API ${API}`);
if (runs(2) || runs(3) || runs(4) || runs(5) || runs(6)) await protect();
if (runs(7)) await limits();
if (runs(10) || runs(11)) await vault();
if (runs(12)) await paid().catch((e) => save(12, "A paid risk check over x402 on NEAR", false, [{ error: String(e) }]));
if (runs(13)) await agents().catch((e) => save(13, "Core flows through the SDK and the MCP server", false, [{ error: String(e) }]));
console.log(`proofs in ${proofFile.replace(`${ROOT_DIR}/`, "")}`);
