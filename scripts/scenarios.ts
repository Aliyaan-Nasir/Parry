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
 * through the queue, proof of reserves, pausing from risk), 9 an Aave loan on Base Sepolia rescued
 * through Chain Signatures and verified by the MPC network, 12 a paid risk check over x402, 13 the
 * SDK and the MCP server, 8 a Hyperliquid order the protected account signs through Chain
 * Signatures. Scenario 1 (sign-in) runs in a browser; filling 8's order and the vault's hedge need
 * Hyperliquid testnet USDC at the derived addresses, and 9 needs Base Sepolia ETH.
 *
 * Proofs go to deployments/testnet-proofs.json (deployments/sandbox-proofs.json with --sandbox).
 * Each scenario account is a fresh subaccount of the deployment root, funded from it. A full run
 * creates seven protected accounts through the relayer, which allows three per address per day:
 * run the relayer with RELAYER_ACCOUNTS_PER_IP=20 for it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKey, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";
import { buildMandate, createParry, verifyReserves, type Decision, type HlOrder, type Policy, type Power } from "../packages/sdk/src/index";
import { HYPERLIQUID_URL, RPC_URLS } from "../services/src/lib/config";
import { recoverAddress } from "../services/src/lib/evm";
import { submitOrder } from "../services/src/lib/hyperliquid";

const ROOT_DIR = join(import.meta.dir, "..");
const sandbox = process.argv.includes("--sandbox");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",").map(Number)) : null;
const runs = (n: number) => !only || only.has(n);

const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;
const API = (process.env.PARRY_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const COLLATERAL = Number(process.env.SCENARIO_COLLATERAL_NEAR ?? 3);
/** Which rescue people scenarios 2 to 6 set up (each needs its own NEAR): repay, add, delev. */
const PEOPLE = new Set((process.env.SCENARIO_PEOPLE ?? "repay,add,delev").split(",").map((x) => x.trim()));
/** What a person needs beyond their collateral: wrapping margin, storage and gas. */
const OVERHEAD = 1.2;

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
/** `scenarios` is the record; `rescue`, `hedge` and `evm` point `pnpm verify` at one proof of each. */
const proofs: {
  network: string;
  scenarios: Record<string, { title: string; ok: boolean; at: string; steps: unknown[] }>;
  rescue?: { decision: string };
  hedge?: { tx: string };
  evm?: { decision: string };
} = existsSync(proofFile)
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

type Outcome = { hash: string; failure: string | null; o: FinalExecutionOutcome | null };

function failureOf(o: FinalExecutionOutcome): string | null {
  for (const s of [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify((s as { Failure: unknown }).Failure).slice(0, 300);
  }
  return null;
}

/** Sends one call; a refusal comes back as `failure` with the transaction's hash, not as a throw. */
/** NEP-297 events in an outcome. */
function eventsOf(o: FinalExecutionOutcome): { event: string; data: unknown }[] {
  return (o.receipts_outcome ?? [])
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)) as { event: string; data: unknown });
}

async function send(n: Near, from: string, to: string, method: string, args: object, deposit = 0n, tgas = 300): Promise<Outcome> {
  const tx = n.transaction(from).functionCall(to, method, args, { gas: `${tgas} Tgas` as never, attachedDeposit: `${deposit} yocto` as never });
  await tx.sign();
  const hash = tx.getHash() ?? "";
  try {
    const o = (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
    return { hash: o.transaction?.hash ?? hash, failure: failureOf(o), o };
  } catch (e) {
    const panic = (e as { panic?: string }).panic;
    if (panic === undefined) throw e;
    return { hash, failure: panic, o: null };
  }
}

async function call(n: Near, from: string, to: string, method: string, args: object, deposit = 0n, tgas = 300): Promise<Outcome> {
  const r = await send(n, from, to, method, args, deposit, tgas);
  if (r.failure) throw new Error(`${to}.${method} failed in ${r.hash}: ${r.failure}`);
  return r;
}

/** Views go to the runner's RPC first and fall back to the other public providers when it is rate limited. */
const VIEW_RPCS = sandbox ? [RPC] : [...new Set([RPC, ...RPC_URLS])];

async function view<T>(account: string, method: string, args: object = {}): Promise<T> {
  let last = "";
  for (let attempt = 0; attempt < VIEW_RPCS.length * 2; attempt++) {
    const res = await fetch(VIEW_RPCS[attempt % VIEW_RPCS.length]!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
    }).catch((e) => e as Error);
    if (res instanceof Error || res.status === 429 || res.status >= 500) {
      last = res instanceof Error ? res.message : `HTTP ${res.status}`;
      await sleep(500 * (attempt + 1));
      continue;
    }
    const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { code?: number; message?: string } };
    if (body.error?.code === -429) {
      last = body.error.message ?? "rate limited";
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!body.result?.result) throw new Error(`${account}.${method}: ${body.result?.error ?? JSON.stringify(body.error).slice(0, 200)}`);
    return JSON.parse(Buffer.from(body.result.result).toString());
  }
  throw new Error(`${account}.${method}: ${last}`);
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
  // The owner's key goes to the keychain, so what is left on the account can be recovered later.
  if (!sandbox) writeFileSync(join(homedir(), ".near-credentials", "testnet", `${owner}.json`), JSON.stringify({ account_id: owner, public_key: k.publicKey.toString(), private_key: k.secretKey }), { mode: 0o600 });
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
  // Decisions made before this run's mandates (an earlier run's, on a reused owner) do not count.
  const since = new Date().toISOString();
  // 2, 3 and 4 for three people, one per rescue kind.
  if (PEOPLE.has("repay")) {
    // SCENARIO_REPAY_OWNER reuses an earlier run's owner (its key is in the keychain) and its open
    // position, and only sets the mandate again: after an enclave build changes the guardian key.
    const reuse = process.env.SCENARIO_REPAY_OWNER;
    if (reuse) {
      const key = (JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${reuse}.json`), "utf8")) as { private_key: string }).private_key;
      const account = await view<string>(c("factory"), "account_id_of", { near_account: reuse });
      people.repay = { owner: reuse, key, n: client(reuse, key), account, steps: [{ step: `relayer creates ${account} for ${reuse}, gasless for the owner (an earlier run)` }] };
    } else {
      const repayer = (people.repay = await person("repay", COLLATERAL + OVERHEAD));
      await position(repayer);
      const faucet = await ownerCall(repayer, [{ call: { receiver_id: c("usdc"), method_name: "faucet", args: Buffer.from("{}").toString("base64"), deposit: "0", gas: "30000000000000" } }]);
      repayer.steps.push({ step: "the account takes test USDC from the faucet as its rescue reserve", tx: explorer(faucet.hash) });
    }
    await mandate(people.repay, ["repay"], [{ token: c("usdc"), reserve: "100000000", daily: "60000000" }], policy("repay-first"));
  }

  if (PEOPLE.has("add")) {
    const adder = (people.add = await person("adder", COLLATERAL + 1 + OVERHEAD));
    await position(adder, 1);
    await mandate(adder, ["add_collateral"], [{ token: c("wnear"), reserve: near(1).toString(), daily: near(1).toString() }], policy("keep-exposure"));
  }

  if (PEOPLE.has("delev")) {
    const delev = (people.delev = await person("delev", COLLATERAL + OVERHEAD));
    await position(delev);
    await mandate(delev, ["deleverage"], [{ token: c("wnear"), reserve: near(COLLATERAL).toString(), daily: near(COLLATERAL / 2).toString() }], policy("deleverage-only"));
  }

  // A reused owner adds no new account or position: the earlier records stand.
  if (!process.env.SCENARIO_REPAY_OWNER) {
    save(2, "A protected account without gas", true, Object.values(people).map((p) => p.steps[0]));
    save(3, "A leveraged Rhea position", true, Object.values(people).flatMap((p) => p.steps.filter((s) => /supply|borrow|funds/.test(JSON.stringify(s)))));
  }
  save(4, "A mandate with a sealed policy", true, Object.values(people).flatMap((p) => p.steps.filter((s) => /mandate/.test(JSON.stringify(s)))));

  // 5: the market shock (rate limited by the oracle: 60 s per caller).
  await sleep(20_000);
  const before = Object.fromEntries(await Promise.all(Object.entries(people).map(async ([k, p]) => [k, await health(p.account)])));
  const shock = await api<{ txHash: string; shock: unknown }>("/v1/shock", { method: "POST", body: { bps: -2000 } });
  save(5, "The market shock moves the price", true, [{ step: "NEAR -20% on the testnet oracle for 30 minutes", tx: explorer(shock.txHash), healthBefore: before }]);

  // 6: alerts, AI review, rescue, recovery.
  if (!runs(6)) return;
  const steps6: unknown[] = [];
  let ok6 = true;
  for (const [kind, p] of Object.entries(people)) {
    try {
      const d = await until(`a ${kind} decision for ${p.account}`, Number(process.env.SCENARIO_DECISION_MS ?? 8 * 60_000), async () => {
        const log = await api<{ items: Decision[] }>(`/v1/guardian/decisions?account=${p.account}&limit=5`);
        return log.items.find((x) => x.createdAt > since && (x.outcome === "executed" || x.outcome === "rejected_by_review" || x.outcome === "refused" || x.outcome === "rolled_back"));
      });
      decisions[kind] = d;
      if (d.outcome === "executed" && !proofs.rescue) proofs.rescue = { decision: d.id };
      const alerts = await api<{ title: string }[]>(`/v1/alerts?account=${p.account}`);
      const v = await api<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(`/v1/guardian/decisions/${d.id}/verify`);
      // The monitor reads the position again within seconds of the rescue: wait for that reading.
      const after = d.outcome === "executed"
        ? await until("the position's health after the rescue", 3 * 60_000, async () => {
            const h = await health(p.account);
            return h !== null && h > (before[kind] ?? 0) + 0.05 ? h : null;
          }).catch(() => health(p.account))
        : await health(p.account);
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
  const p = people.repay ?? (await person("limits", 1));
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
  // Refused at the signature check here; that a correctly signed one cannot parse either is the
  // account's unit test `guardian_can_never_withdraw_or_transfer_out` (no guardian action withdraws).
  await refused("a forged guardian envelope asking to withdraw (with the enclave's signature it would not parse either: no guardian action withdraws)", send(root, rootId, p.account, "guardian_execute", { envelope: withdrawEnvelope, signature: Buffer.alloc(64, 7).toString("base64") }, 0n, 300), /withdraw|unknown variant|parse|signature/i);
  // An expired mandate: the guardian stops acting for it.
  const e = await person("expiry", 1);
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
  // SCENARIO_VAULT_ACCOUNT deposits from an existing account with a key in the keychain.
  const existing = process.env.SCENARIO_VAULT_ACCOUNT;
  const p: Person = existing
    ? (() => {
        const key = (JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${existing}.json`), "utf8")) as { private_key: string }).private_key;
        return { owner: existing, key, n: client(existing, key), account: "", steps: [] };
      })()
    : await person("vault", Number(process.env.SCENARIO_VAULT_NEAR ?? 1) + 1);
  const before = await view<{ total_shares: string }>(c("vault"), "vault_state").catch(() => null);
  const amount = Number(process.env.SCENARIO_VAULT_NEAR ?? 1);
  const dep1 = await call(p.n, p.owner, c("vault"), "deposit", {}, near(amount), 150);
  steps.push({ step: `deposit ${amount} NEAR into the vault (staked into LiNEAR, EARN minted at NAV)`, tx: explorer(dep1.hash) });
  const refund = dep1.o ? (eventsOf(dep1.o).find((e) => e.event === "deposit_refunded")?.data as { reason?: string } | undefined) : undefined;
  if (refund) return save(10, "Vault deposit, hedge, withdrawal through the queue, proof of reserves", false, [...steps, { step: "the vault refused the deposit and refunded it", reason: refund.reason }]);
  const shares = await view<string>(c("vault"), "ft_balance_of", { account_id: p.owner });
  steps.push({ step: `EARN balance ${Number(BigInt(shares) / 10n ** 18n) / 1e6}`, totalSharesBefore: before?.total_shares });
  // The short needs margin in the vault's Hyperliquid account: until it has some, the hedge target
  // is capped at zero and there is nothing to wait for.
  const funded = (await api<{ hedge: { accountValueUsd: number; address: string | null } }>("/v1/vault")).hedge;
  const hedge =
    funded.accountValueUsd > 0
      ? await until("a hedge position after the deposit", 10 * 60_000, async () => {
          const s = await api<{ hedge: { currentNear: number; targetNear: number } }>("/v1/vault");
          return s.hedge.currentNear > 0 ? s.hedge : null;
        }).catch((e) => ({ error: String(e) }))
      : { pending: `the hedge account ${funded.address ?? "(not reported yet)"} holds no Hyperliquid margin yet; the keeper signs the short once it does` };
  steps.push({ step: "the keeper rebalances: a Chain Signatures order shorts NEAR on Hyperliquid", hedge });
  const lastOrder = (await api<{ hedge: { lastOrder: { tx: string } | null } }>("/v1/vault")).hedge.lastOrder;
  if (lastOrder) {
    proofs.hedge = { tx: lastOrder.tx };
    steps.push({ step: "the order's signing transaction", tx: explorer(lastOrder.tx) });
  }
  // Withdrawals pay out in LiNEAR: register with it first (NEP-145), or the payout waits as a claim.
  await call(p.n, p.owner, dep.external?.linear ?? "linear-protocol.testnet", "storage_deposit", { account_id: p.owner, registration_only: true }, 1_250_000_000_000_000_000_000n, 10);
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
  const title = "pending" in hedge ? "Vault deposit, withdrawal through the queue, proof of reserves (the hedge waits for margin)" : "Vault deposit, hedge, withdrawal through the queue, proof of reserves";
  save(10, title, paid === true && rv.ok && !("error" in hedge), steps);
}

async function vaultPause() {
  if (!c("vault")) return save(11, "The vault pauses deposits from its risk score", false, [{ step: "no vault in this deployment" }]);
  // A score of 70 or more pauses deposits and one under 60 resumes them (the sandbox suite drives
  // the score across both); here the live state must agree with the enclave's latest score.
  const state = await view<{ risk_paused: boolean; risk_score: number | null }>(c("vault"), "vault_state");
  const score = state.risk_score ?? 0;
  const consistent = score >= 70 ? state.risk_paused : score < 60 ? !state.risk_paused : true;
  save(11, "The vault pauses deposits from its risk score", state.risk_score !== null && consistent, [
    { step: `the enclave's latest score is ${state.risk_score ?? "missing"}; deposits are ${state.risk_paused ? "paused" : "open"} (70 pauses, under 60 resumes)`, ok: consistent },
  ]);
}

async function paid() {
  const p = people.repay ?? (await person("payer", 1));
  // NEP-145: the payer registers with the token before it can hold any.
  const reg = await view<unknown>(c("usdc"), "storage_balance_of", { account_id: p.owner }).catch(() => null);
  if (!reg) await call(p.n, p.owner, c("usdc"), "storage_deposit", { account_id: p.owner, registration_only: true }, near(0.0125), 30);
  const fau = await call(p.n, p.owner, c("usdc"), "faucet", {}, 0n, 30);
  const r = await parry.paidRiskCheck(p.account, { payer: { accountId: p.owner, privateKey: p.key }, maxAmount: "100000" });
  save(12, "A paid risk check over x402 on NEAR", !!r.result && !!r.payment, [
    { step: "the payer takes test USDC from the faucet", tx: explorer(fau.hash) },
    {
      step: "pays per call with a signed delegate ft_transfer, settled before the answer",
      payment: r.payment,
      tx: r.payment?.transaction ? explorer(r.payment.transaction) : null,
      score: (r.result as { position?: { score?: number } | null } | undefined)?.position?.score,
    },
  ]);
}

/**
 * 9: an Aave loan on Base Sepolia at the account's Chain Signatures address, rescued by the
 * guardian (approve, then repay) and verified by the MPC network. One test owner is kept in the
 * keychain (`evm-owner.<root>`), so its derived address needs Base Sepolia ETH only once; the
 * first run creates it, prints the address and stops.
 */
async function evmRescue() {
  const title = "An Aave position on Base Sepolia rescued through Chain Signatures";
  const ownerId = `evm-owner.${rootId}`;
  const credDir = join(homedir(), ".near-credentials", "testnet");
  const credFile = join(credDir, `${ownerId}.json`);
  let p: Person;
  if (!existsSync(credFile)) {
    const k = generateKey();
    // The owner signs a few 300 Tgas calls (checked against the pessimistic gas price) and pays their gas.
    await root.transaction(rootId).createAccount(ownerId).transfer(ownerId, `${near(Number(process.env.SCENARIO_EVM_NEAR ?? 1.2))} yocto` as never).addKey(k.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    mkdirSync(credDir, { recursive: true });
    writeFileSync(credFile, JSON.stringify({ account_id: ownerId, public_key: k.publicKey.toString(), private_key: k.secretKey }), { mode: 0o600 });
    const created = await api<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: { nearAccount: ownerId } });
    p = { owner: ownerId, key: k.secretKey, n: client(ownerId, k.secretKey), account: created.accountId, steps: [{ step: "protected account", tx: explorer(created.txHash) }] };
  } else {
    const key = (JSON.parse(readFileSync(credFile, "utf8")) as { private_key: string }).private_key;
    const account = await view<string>(c("factory"), "account_id_of", { near_account: ownerId });
    p = { owner: ownerId, key, n: client(ownerId, key), account, steps: [] };
  }
  const open = Bun.spawnSync(["bun", "scripts/evm-position.ts", p.account, "--eth", "0.003", "--health", "1.15"], {
    cwd: ROOT_DIR,
    env: { ...process.env, OWNER_ACCOUNT_ID: p.owner, OWNER_PRIVATE_KEY: p.key, PARRY_NETWORK: "testnet" },
  });
  const out = open.stdout.toString() + open.stderr.toString();
  if (open.exitCode === 2) return save(9, title, false, [{ step: "fund the account's Base Sepolia address with ETH, then run again", detail: out.trim().split("\n").slice(-1)[0] }]);
  if (open.exitCode !== 0) return save(9, title, false, [{ step: "open the Aave loan", error: out.slice(-600) }]);
  p.steps.push(...out.split("\n").filter((l) => /basescan|Aave:/.test(l)).map((l) => ({ step: l })));
  const guard = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { chain_id: number; pool: string; asset: string; address: string; max_amount: string };
  const { key, sealingKey } = await parry.enclave();
  const m = buildMandate({
    account: p.account, guardianKey: key.public_key, powers: ["evm_repay"], limits: [], maxActionsPerDay: 10, minHealthAfterBps: 10500, maxSlippageBps: 300,
    evm: { chainId: guard.chain_id, pool: guard.pool, asset: guard.asset, address: guard.address, maxAmount: guard.max_amount },
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400, policy: { ...policy("repay-first"), evmTriggerHealth: 1.2 },
    ...(sealingKey ? { sealingPublicKey: sealingKey.public_key } : {}),
  });
  const set = await ownerCall(p, [{ set_mandate: { mandate: m } }]);
  p.steps.push({ step: "mandate: evm_repay on the Aave pool for the account's own address", tx: explorer(set.hash) });
  const wait = Number(process.env.SCENARIO_DECISION_MS ?? 8 * 60_000);
  for (const action of ["evm_approve", "evm_repay"]) {
    const d = await until(`${action} for ${p.account}`, wait, async () => {
      const log = await api<{ items: Decision[] }>(`/v1/guardian/decisions?account=${p.account}&limit=10`);
      return log.items.find((x) => x.action === action && x.outcome === "executed" && x.txs.evm);
    }).catch((e) => e as Error);
    if (d instanceof Error) return save(9, title, false, [...p.steps, { step: action, error: d.message }]);
    p.steps.push({ step: `${action}: ${d.plan}`, near: explorer(d.txs.action!), base: `https://sepolia.basescan.org/tx/${d.txs.evm}` });
    if (action === "evm_repay") proofs.evm = { decision: d.id };
  }
  // The MPC network verifies once the Base Sepolia block is final (about 20 minutes).
  const verified = await until("the MPC network's verification", Number(process.env.SCENARIO_VERIFY_MS ?? 40 * 60_000), async () => {
    const d = await api<Decision>(`/v1/guardian/decisions/${proofs.evm!.decision}`);
    return d.txs.evmVerify ? d : null;
  }).catch(() => null);
  p.steps.push({ step: "verify_foreign_transaction on the MPC signer", tx: verified?.txs.evmVerify ? explorer(verified.txs.evmVerify) : null, result: verified?.txs.evmVerified ?? "pending" });
  save(9, title, verified?.txs.evmVerified === "verified", p.steps);
}

/**
 * Scenario 8: the protected account signs a Hyperliquid order for its own derived address through
 * Chain Signatures. The signature must recover to that address, as Hyperliquid recovers it; the
 * order fills once the address holds Hyperliquid testnet USDC, and Hyperliquid's answer is kept.
 */
async function hlOrder() {
  const title = "A Hyperliquid order signed by the protected account through Chain Signatures";
  // A 300 Tgas call is checked against the pessimistic gas price, so the owner needs about 0.35 NEAR up front.
  const p = await person("perp", Number(process.env.SCENARIO_PERP_NEAR ?? 0.6));
  const { hyperliquidAddress } = await api<{ hyperliquidAddress: string }>(`/v1/accounts/${p.account}`);
  const mids = (await (await fetch(`${HYPERLIQUID_URL}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })).json()) as Record<string, string>;
  const mark = Number(mids.NEAR);
  // A short of 3 NEAR (over Hyperliquid's $10 minimum), immediate-or-cancel, 3 % under the mark.
  const order: HlOrder = { asset_index: Number(process.env.HYPERLIQUID_NEAR_INDEX ?? 54), is_buy: false, price: String(Number((mark * 0.97).toPrecision(5))), size: "3", reduce_only: false, tif: "Ioc" };
  const nonce = Date.now();
  const o = await ownerCall(p, [{ hl_order: { order, nonce } }]);
  const ev = o.o ? eventsOf(o.o).find((e) => e.event === "hyperliquid_signed") : undefined;
  const digest = (ev?.data as { digest?: string } | undefined)?.digest;
  const value = (o.o?.status as { SuccessValue?: string } | undefined)?.SuccessValue;
  const sig = value ? (JSON.parse(Buffer.from(value, "base64").toString()) as { r: string; s: string; v: number }) : null;
  p.steps.push({ step: `the account signs a Hyperliquid order (sell 3 NEAR at ${order.price}) through Chain Signatures`, tx: explorer(o.hash), digest });
  if (!sig || !digest) return save(8, title, false, [...p.steps, { step: "no signature came back", status: o.o?.status }]);
  const signer = `0x${recoverAddress(Buffer.from(digest, "hex"), sig).replace(/^0x/, "")}`;
  const ok = signer.toLowerCase() === hyperliquidAddress.toLowerCase();
  p.steps.push({ step: "the MPC signature recovers to the account's derived Hyperliquid address", signer, hyperliquidAddress, ok });
  const res = await submitOrder(order, nonce, sig).catch((e) => ({ status: "error", response: String(e) }));
  p.steps.push({ step: "Hyperliquid's answer (the order fills once the address holds testnet USDC)", response: res });
  save(8, title, ok, p.steps);
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
if (runs(8) && !sandbox) await hlOrder().catch((e) => save(8, "A Hyperliquid order signed by the protected account through Chain Signatures", false, [{ error: String(e), details: (e as { details?: unknown }).details }]));
if (runs(9) && !sandbox) await evmRescue();
if (runs(10)) await vault();
if (runs(11)) await vaultPause();
if (runs(12)) await paid().catch((e) => save(12, "A paid risk check over x402 on NEAR", false, [{ error: String(e) }]));
if (runs(13)) await agents().catch((e) => save(13, "Core flows through the SDK and the MCP server", false, [{ error: String(e) }]));
console.log(`proofs in ${proofFile.replace(`${ROOT_DIR}/`, "")}`);
