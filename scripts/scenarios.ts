/**
 * Runs the test matrix's scenarios against a deployed stack, like a person would, and records
 * every transaction as proof.
 *
 *   bun scripts/scenarios.ts                     testnet (deployments/testnet.json, the root key in
 *                                                ~/.near-credentials/testnet), API at PARRY_API_URL
 *                                                or the deployment record's hosted one
 *   bun scripts/scenarios.ts --sandbox           the local node from `bun scripts/sandbox.ts`
 *   bun scripts/scenarios.ts --only 2,3,4        a subset (each scenario creates what it needs)
 *   bun scripts/scenarios.ts --align-pool        only realign the testnet exchange pool with the oracle
 *   bun scripts/scenarios.ts --upgrade-accounts  only move the accounts whose owner keys are on hand to the published code
 *
 * Scenarios (numbers as in the test matrix): 2 a gasless protected account, 3 a leveraged Rhea
 * position, 4 a mandate with a sealed policy, 5 the market shock, 6 the AI-reviewed rescues
 * (repay, add collateral, deleverage) and recovery, 7 the limits (replayed and forged envelopes,
 * a non-owner withdrawal, an expired mandate), 10 and 11 the vault (deposit, hedge, withdrawal
 * through the queue, proof of reserves, pausing from risk), 9 an Aave loan on Base Sepolia rescued
 * through Chain Signatures and verified by the MPC network, 12 a paid risk check over x402, 13 the
 * SDK and the MCP server, 8 a Hyperliquid order the protected account signs through Chain
 * Signatures, 14 closing a Rhea position in rounds by selling (a NEAR-wallet owner and a passkey
 * owner through the relayer), 15 closing from the wallet, 16 unwinding accounts, 17 a health
 * certificate issued, anchored and verified, 18 an insurance inflow into the vault's fund.
 * Scenario 1 (sign-in) runs in a browser; filling 8's order and the vault's hedge need
 * Hyperliquid testnet USDC at the derived addresses, and 9 needs Base Sepolia ETH.
 *
 * Proofs go to deployments/testnet-proofs.json (deployments/sandbox-proofs.json with --sandbox).
 * Each scenario account is a fresh subaccount of the deployment root, funded from it. A full run
 * creates seven protected accounts through the relayer, which allows three per address per day:
 * run the relayer with RELAYER_ACCOUNTS_PER_IP=20 for it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateKey, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";
import {
  buildMandate,
  closeFromWalletActions,
  compressedPasskey,
  createParry,
  ownerActions,
  ownerActionsTgas,
  verifyReserves,
  type Decision,
  type HlOrder,
  type OwnerAction,
  type PasskeyAssertion,
  type Policy,
  type Power,
} from "../packages/sdk/src/index";
import { HYPERLIQUID_URL, RPC_URLS } from "../services/src/lib/config";
import { recoverAddress } from "../services/src/lib/evm";
import { submitOrder } from "../services/src/lib/hyperliquid";

const ROOT_DIR = join(import.meta.dir, "..");
/** Local key files (gitignored); PARRY_KEYS_DIR points elsewhere. */
const KEYS_DIR = process.env.PARRY_KEYS_DIR ?? join(ROOT_DIR, ".keys");
const sandbox = process.argv.includes("--sandbox");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",").map(Number)) : null;
const runs = (n: number) => !only || only.has(n);

const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;
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
/** The hosted API in the deployment record, unless PARRY_API_URL names another (a local stack). */
const API = (process.env.PARRY_API_URL ?? dep.api ?? "http://localhost:4000").replace(/\/$/, "");
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

/** A lending action priced with an oracle price past the lending contract's 90 s staleness bound (the feeder runs every 30 s, slower when RPC providers rate limit). */
const STALE_PRICE = /Missing [0-9a-f]{64} price/;

async function call(n: Near, from: string, to: string, method: string, args: object, deposit = 0n, tgas = 300): Promise<Outcome> {
  let r = await send(n, from, to, method, args, deposit, tgas);
  if (r.failure && STALE_PRICE.test(r.failure)) {
    // Once the feeder has caught up, the same call goes through.
    await sleep(40_000);
    r = await send(n, from, to, method, args, deposit, tgas);
  }
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
  // The RPC answers a short balance with an opaque "Server error": say what is missing instead.
  const have = Number(await root.getBalance(rootId));
  if (have < fundNear + 0.5) throw new Error(`${rootId} holds ${have} NEAR; ${tag} needs ${fundNear} plus gas`);
  await root.transaction(rootId).createAccount(owner).transfer(owner, `${near(fundNear)} yocto` as never).addKey(k.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" });
  // The owner's key goes to the keychain, so what is left on the account can be recovered later.
  if (!sandbox) writeFileSync(join(homedir(), ".near-credentials", "testnet", `${owner}.json`), JSON.stringify({ account_id: owner, public_key: k.publicKey.toString(), private_key: k.secretKey }), { mode: 0o600 });
  const steps: unknown[] = [];
  // Scenario 2: the relayer creates the protected account and pays for it.
  const created = await api<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: { nearAccount: owner } }).catch(async (e: unknown) => {
    // No protected account came of it: hand the owner's NEAR back to the root rather than strand it.
    await client(owner, k.secretKey).transaction(owner).deleteAccount({ beneficiary: rootId } as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" }).catch(() => null);
    throw e;
  });
  steps.push({ step: `relayer creates ${created.accountId} for ${owner}, gasless for the owner`, tx: explorer(created.txHash) });
  const p: Person = { owner, key: k.secretKey, n: client(owner, k.secretKey), account: created.accountId, steps };
  if (!sandbox) await upgraded(p);
  return p;
}

/** `owner_call` with the gas its actions need (900 Tgas for a close, 600 or more for an unwind). */
const ownerCall = (p: Person, actions: unknown[], deposit = 1n) => call(p.n, p.owner, p.account, "owner_call", { actions }, deposit, ownerActionsTgas(actions as OwnerAction[]));

/** The published account code. The factory cannot be repointed, so it creates accounts on the code it was configured with, and the owner moves each one. */
const ACCOUNT_CODE: string = dep.contracts.account?.codeHash ?? "";

async function upgraded(p: Person, send: (actions: OwnerAction[]) => Promise<Outcome> = (a) => ownerCall(p, a)): Promise<void> {
  if ((await parry.accountCode(p.account).catch(() => null)) === ACCOUNT_CODE) return;
  const o = await send([ownerActions.upgrade(ACCOUNT_CODE)]);
  p.steps.push({ step: `the owner moves the account to the published code ${ACCOUNT_CODE} (upgrade)`, tx: explorer(o.hash) });
}

async function nearPrice(): Promise<number> {
  const p = await view<{ price: string; expo: number }>(c("oracle"), "get_price_no_older_than", { price_id: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", age: 600 });
  return Number(p.price) * 10 ** p.expo;
}

/**
 * Scenario 3: wrap and supply `collateral` NEAR (plus `extraWNear` kept in the account), borrow to
 * `targetHealth`. `send` runs owner actions (a passkey owner's go through the relayer), and
 * `fund` pays the account its NEAR (the owner's wallet, or the root for a passkey owner).
 */
async function position(
  p: Person,
  extraWNear = 0,
  o: { collateral?: number; targetHealth?: number; send?: (actions: OwnerAction[]) => Promise<Outcome>; fund?: (yocto: bigint) => Promise<string> } = {},
): Promise<{ borrowUsd: number }> {
  const collateral = o.collateral ?? COLLATERAL;
  const health = o.targetHealth ?? 1.3;
  const send = o.send ?? ((a: OwnerAction[]) => ownerCall(p, a));
  const fund = o.fund ?? (async (amount: bigint) => ((await p.n.transaction(p.owner).transfer(p.account, `${amount} yocto` as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome).transaction?.hash ?? "");
  const wrap = near(collateral + extraWNear + 0.5);
  // Fund the protected account, then wrap and supply from it.
  const t = await fund(wrap + near(0.2));
  p.steps.push({ step: "the protected account is funded", tx: explorer(t) });
  const supply = await send([
    { call: { receiver_id: c("wnear"), method_name: "near_deposit", args: Buffer.from("{}").toString("base64"), deposit: wrap.toString(), gas: "20000000000000" } },
    { supply: { token: c("wnear"), amount: near(collateral).toString() } },
  ]);
  p.steps.push({ step: `wrap and supply ${collateral} NEAR on Rhea`, tx: explorer(supply.hash) });
  const price = await nearPrice();
  const borrowUsd = Math.floor(((collateral * price * 0.75 * 0.95) / health) * 100) / 100;
  const borrow = await send([{ borrow: { token: c("usdc"), amount: String(Math.round(borrowUsd * 1e6)) } }]);
  p.steps.push({ step: `borrow ${borrowUsd} USDC (health about ${health.toFixed(3)} at $${price.toFixed(3)})`, tx: explorer(borrow.hash) });
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
    save(3, "A leveraged Rhea position", true, Object.values(people).flatMap((p) => p.steps.filter((s) => /supply|borrow|fund/.test(JSON.stringify(s)))));
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
  save(7, "Mandate enforcement: replays, forged envelopes, withdrawals and expiry are refused", ok, steps);
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
  // SCENARIO_EVM_REUSE keeps the loan and the mandate an earlier run opened, and only waits for the guardian.
  if (!process.env.SCENARIO_EVM_REUSE) {
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
  } else {
    // The earlier run's record holds the loan's transactions; the mandate is set again (with the
    // current guardian key) from the EVM guard already on chain.
    p.steps.push(...((proofs.scenarios["9"]?.steps ?? []) as { step?: string }[]).filter((x) => /protected account|basescan|Aave:/.test(x.step ?? "")));
    const onChain = await view<{ mandate: { evm: { chain_id: number; pool: string; asset: string; address: string; max_amount: string } } }>(p.account, "mandate");
    const g = onChain.mandate.evm;
    const { key, sealingKey } = await parry.enclave();
    const m = buildMandate({
      account: p.account, guardianKey: key.public_key, powers: ["evm_repay"], limits: [], maxActionsPerDay: 10, minHealthAfterBps: 10500, maxSlippageBps: 300,
      evm: { chainId: g.chain_id, pool: g.pool, asset: g.asset, address: g.address, maxAmount: g.max_amount },
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400, policy: { ...policy("repay-first"), evmTriggerHealth: 1.2 },
      ...(sealingKey ? { sealingPublicKey: sealingKey.public_key } : {}),
    });
    const set = await ownerCall(p, [{ set_mandate: { mandate: m } }]);
    p.steps.push({ step: "mandate: evm_repay on the Aave pool for the account's own address", tx: explorer(set.hash) });
  }
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
// Closing, unwinding, certificates and the insurance fund
// ---------------------------------------------------------------------------------------------

const DEX = dep.contracts.dex?.account ?? "ref-finance-101.testnet";
const POOL = Number(dep.dexPool);
const CLOSE_COLLATERAL = Number(process.env.SCENARIO_CLOSE_COLLATERAL_NEAR ?? 0.6);
const CLOSE_SLIPPAGE_BPS = Number(process.env.SCENARIO_CLOSE_SLIPPAGE_BPS ?? 500);
/** A close round sends 900 Tgas, checked against the pessimistic gas price: the owner holds about 1.1 NEAR for it. */
const CLOSE_GAS_NEAR = 1.2;

/** The transaction's outcome (for its events), looked up by hash. */
async function outcome(hash: string, sender: string): Promise<FinalExecutionOutcome | null> {
  for (const url of VIEW_RPCS) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" } }) }).catch(() => null);
    const body = (await r?.json().catch(() => null)) as { result?: FinalExecutionOutcome } | null;
    if (body?.result) return body.result;
  }
  return null;
}

const eventData = (o: FinalExecutionOutcome | null, name: string) => (o ? eventsOf(o).filter((e) => e.event === name).map((e) => e.data as Record<string, unknown>) : []);

/**
 * The exchange pool is a testnet pool with little depth and no arbitrage: after a close round sells
 * NEAR into it, the root buys NEAR back with test USDC until the pool's price is the oracle's again,
 * as arbitrage would on mainnet. Returns the swap's transaction, or null when the pool was in line.
 */
async function alignPool(): Promise<string | null> {
  const pool = await view<{ amounts: string[]; token_account_ids: string[] }>(DEX, "get_pool", { pool_id: POOL });
  const iNear = pool.token_account_ids.indexOf(c("wnear"));
  const nearIn = Number(BigInt(pool.amounts[iNear]!) / 10n ** 18n) / 1e6;
  const usdcIn = Number(pool.amounts[1 - iNear]) / 1e6;
  const price = await nearPrice();
  const targetUsdc = Math.sqrt(nearIn * usdcIn * price);
  if (targetUsdc <= usdcIn * 1.002) return null;
  const amount = String(Math.ceil(((targetUsdc - usdcIn) / 0.9975) * 1e6));
  const have = BigInt(await view<string>(c("usdc"), "ft_balance_of", { account_id: rootId }));
  if (have < BigInt(amount)) await call(root, rootId, c("usdc"), "mint", { account_id: rootId, amount: "1000000000" }, 1n, 30);
  const msg = JSON.stringify({ actions: [{ pool_id: POOL, token_in: c("usdc"), token_out: c("wnear"), amount_in: amount, min_amount_out: "0" }] });
  const o = await call(root, rootId, c("usdc"), "ft_transfer_call", { receiver_id: DEX, amount, msg }, 1n, 150);
  return o.hash;
}

// A passkey owner: a P-256 key in software standing in for the authenticator, as WebAuthn signs.

interface PasskeyPerson extends Person {
  secret: Uint8Array;
}

async function passkeyPerson(tag: string): Promise<PasskeyPerson> {
  const secret = p256.utils.randomSecretKey();
  const passkey = compressedPasskey(p256.getPublicKey(secret, true));
  const created = await api<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: { passkey } });
  // The key stays in the private keys folder, so what is left in the account can be recovered later.
  if (!sandbox) writeFileSync(join(KEYS_DIR, `passkey-${tag}-${created.accountId.slice(0, 12)}.json`), JSON.stringify({ account: created.accountId, passkey, secret: Buffer.from(secret).toString("hex") }), { mode: 0o600 });
  return { owner: `passkey ${passkey.slice(0, 10)}...`, key: "", n: root, account: created.accountId, secret, steps: [{ step: `relayer creates ${created.accountId} for a passkey, gasless for the owner`, tx: explorer(created.txHash) }] };
}

function assertion(secret: Uint8Array, challengeBase64Url: string): PasskeyAssertion {
  const clientData = JSON.stringify({ type: "webauthn.get", challenge: challengeBase64Url, origin: "http://localhost:3000", crossOrigin: false });
  // rp id hash, flags (user present | user verified), counter.
  const auth = new Uint8Array([...sha256(new TextEncoder().encode("localhost")), 0x05, 0, 0, 0, 1]);
  const signed = new Uint8Array([...auth, ...sha256(new TextEncoder().encode(clientData))]);
  const sig = p256.sign(signed, secret, { lowS: true });
  return { authenticator_data: Buffer.from(auth).toString("base64url"), client_data_json: clientData, signature: Buffer.from(sig).toString("hex") };
}

/** A passkey-signed owner request, relayed by the relayer (which attaches the gas the actions need). */
async function relayOwner(p: PasskeyPerson, actions: OwnerAction[], retried = false): Promise<Outcome> {
  if (!retried) {
    const first = await relayOwner(p, actions, true).catch((e: Error) => e);
    if (!(first instanceof Error)) return first;
    if (!STALE_PRICE.test(first.message)) throw first;
    await sleep(40_000);
  }
  const { owner } = await parry.nonces(p.account);
  const req = parry.ownerRequest({ account: p.account, nonce: owner + 1, actions });
  const r = await fetch(`${API}/v1/relay/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: p.account, request: req.text, assertion: assertion(p.secret, req.challengeBase64Url) }) });
  const body = (await r.json()) as { txHash?: string; error?: string };
  if (!r.ok || !body.txHash) throw new Error(`relay: ${body.error ?? r.status}`);
  const o = await outcome(body.txHash, dep.services?.relayer ?? `relayer.${rootId}`);
  return { hash: body.txHash, failure: o ? failureOf(o) : null, o };
}

const lines = async (account: string) => (await view<{ collateral: { token_id: string; balance: string }[]; borrowed: { token_id: string; balance: string }[]; supplied: { token_id: string; balance: string }[] } | null>(c("lending"), "get_account", { account_id: account })) ?? { collateral: [], borrowed: [], supplied: [] };

/**
 * 14 for one owner: close the Rhea position round by round with the SDK (`closeRheaRounds`), the
 * pool brought back to the oracle's price between rounds.
 */
async function closeInRounds(p: Person, send: (actions: OwnerAction[]) => Promise<Outcome>, label: string): Promise<boolean> {
  const outcomes = new Map<string, Outcome>();
  const aligned = await alignPool();
  if (aligned) p.steps.push({ step: "the root brings the exchange pool to the oracle's price", tx: explorer(aligned) });
  const rounds = () => parry.closeRheaRounds({
    account: p.account,
    slippageBps: CLOSE_SLIPPAGE_BPS,
    poolId: POOL,
    sendOwnerActions: async (actions) => {
      const o = await send(actions);
      outcomes.set(o.hash, o);
      return { txHash: o.hash };
    },
    sendCall: async (callData) => {
      const o = await call(root, rootId, callData.receiverId, callData.methodName, callData.args, 0n, Number(BigInt(callData.gas) / 10n ** 12n));
      outcomes.set(o.hash, o);
      return { txHash: o.hash };
    },
    onRound: async (round) => {
      const o = outcomes.get(round.txHash)?.o ?? null;
      const progress = eventData(o, "close_progress")[0];
      const closed = eventData(o, "position_closed")[0];
      const rolled = eventData(o, "close_rolled_back")[0];
      p.steps.push({
        step: `${label}: ${round.kind === "retry" ? "retry_close" : "close_rhea"} round ${p.steps.filter((x) => /round \d/.test(JSON.stringify(x))).length + 1}${closed ? ", position closed" : progress ? ", progress" : rolled ? `, rolled back at ${String(rolled.stage)}` : ""}`,
        tx: explorer(round.txHash),
        ...(closed ? { position_closed: closed } : progress ? { close_progress: progress } : rolled ? { close_rolled_back: rolled } : {}),
        after: round.after.kind,
      });
      if (round.after.kind === "open") {
        const tx = await alignPool();
        if (tx) p.steps.push({ step: "the root brings the exchange pool back to the oracle's price", tx: explorer(tx) });
      }
    },
  });
  let r = await rounds();
  // A round refused at its read (a stale oracle price) moved nothing: once the feeder caught up, go on.
  const refusedAtRead = () => r.stopped === "rolled_back" && eventData(outcomes.get(r.rounds.at(-1)?.txHash ?? "")?.o ?? null, "close_rolled_back")[0]?.stage === "read";
  for (let i = 0; i < 2 && refusedAtRead(); i++) {
    await sleep(40_000);
    r = await rounds();
  }
  const after = await lines(p.account);
  const ok = r.closed && after.borrowed.length === 0 && after.collateral.every((x) => BigInt(x.balance) === 0n);
  p.steps.push({ step: `${label}: ${r.closed ? `closed in ${r.rounds.length} round(s)` : `not closed (${r.stopped})`}; lending position now ${JSON.stringify({ collateral: after.collateral.length, borrowed: after.borrowed.length })}`, ok });
  return ok;
}

const closers: { wallet?: Person; passkey?: PasskeyPerson; fromWallet?: Person } = {};

/** 14 and 17: close in rounds by selling, for a NEAR-wallet owner and a passkey owner; a certificate first, while the position is healthy. */
async function closeBySelling() {
  const title = "Closing a Rhea position in rounds by selling collateral (a NEAR-wallet owner and a passkey owner through the relayer)";
  let ok = true;
  const steps: unknown[] = [];
  try {
    // A NEAR-wallet owner: its own owner_call carries 900 Tgas per round.
    const a = (closers.wallet = await person("closer", CLOSE_COLLATERAL + 0.7 + CLOSE_GAS_NEAR + 0.3));
    await upgraded(a);
    await position(a, 0, { collateral: CLOSE_COLLATERAL, targetHealth: 1.425 });
    if (runs(17)) await certificate(a);
    if (!(await closeInRounds(a, (x) => ownerCall(a, x), "wallet owner"))) ok = false;
    steps.push(...a.steps);
  } catch (e) {
    ok = false;
    steps.push({ step: "wallet owner", error: String(e).slice(0, 400) });
  }
  try {
    // A passkey owner: every request goes through the relayer, which attaches the 900 Tgas.
    // SCENARIO_PASSKEY_REUSE names an earlier run's passkey file (.keys/passkey-*.json) and
    // closes the position that account already holds.
    const reuse = process.env.SCENARIO_PASSKEY_REUSE;
    const b = (closers.passkey = reuse
      ? (() => {
          const f = JSON.parse(readFileSync(reuse, "utf8")) as { account: string; secret: string };
          return { owner: "passkey (an earlier run)", key: "", n: root, account: f.account, secret: Uint8Array.from(Buffer.from(f.secret, "hex")), steps: [] } as PasskeyPerson;
        })()
      : await passkeyPerson("closer"));
    const send = (x: OwnerAction[]) => relayOwner(b, x).then((o) => {
      if (o.failure) throw new Error(`relayed request failed in ${o.hash}: ${o.failure}`);
      return o;
    });
    await upgraded(b, send);
    // The passkey owner has no NEAR wallet: the root pays the account its collateral (the unwind sends it back).
    const fund = async (amount: bigint) => ((await root.transaction(rootId).transfer(b.account, `${amount} yocto` as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome).transaction?.hash ?? "";
    if ((await lines(b.account)).borrowed.length === 0) await position(b, 0, { collateral: CLOSE_COLLATERAL, targetHealth: 1.425, send, fund });
    if (!(await closeInRounds(b, send, "passkey owner"))) ok = false;
    steps.push(...b.steps);
  } catch (e) {
    ok = false;
    steps.push({ step: "passkey owner", error: String(e).slice(0, 400) });
  }
  save(14, title, ok, steps);
}

/** 15: the owner repays from the wallet: sends the debt token to the account, then repay and withdraw in one owner call. */
async function closeFromWallet() {
  const title = "Closing a Rhea position from the wallet (repay with the owner's own USDC, then withdraw the collateral)";
  const p = (closers.fromWallet = await person("walletclose", CLOSE_COLLATERAL + 0.7 + 0.8));
  try {
    await upgraded(p);
    await position(p, 0, { collateral: CLOSE_COLLATERAL });
    // The owner's own test USDC: register, take it from the faucet.
    await call(p.n, p.owner, c("usdc"), "storage_deposit", { account_id: p.owner, registration_only: true }, near(0.0125), 30);
    const fau = await call(p.n, p.owner, c("usdc"), "faucet", {}, 0n, 30);
    p.steps.push({ step: "the owner takes test USDC from the faucet into the wallet", tx: explorer(fau.hash) });
    const before = await lines(p.account);
    const debtInner = BigInt(before.borrowed.find((x) => x.token_id === c("usdc"))?.balance ?? "0");
    // USDC has 12 extra decimals in lending; repay a cent more than the debt for the interest that accrues meanwhile.
    const debt = (debtInner + 10n ** 12n - 1n) / 10n ** 12n + 10_000n;
    const collateral = before.collateral.find((x) => x.token_id === c("wnear"))?.balance ?? "0";
    const flow = closeFromWalletActions({ account: p.account, debtToken: c("usdc"), debtAmount: debt, collateralToken: c("wnear"), collateralAmount: collateral });
    const t = await call(p.n, p.owner, flow.transfer.receiverId, flow.transfer.methodName, flow.transfer.args, BigInt(flow.transfer.deposit), Number(BigInt(flow.transfer.gas) / 10n ** 12n));
    p.steps.push({ step: `the owner sends ${Number(debt) / 1e6} USDC to the protected account`, tx: explorer(t.hash) });
    const o = await ownerCall(p, flow.actions);
    p.steps.push({ step: "repay the whole debt and withdraw all the collateral (one owner call)", tx: explorer(o.hash) });
    const after = await lines(p.account);
    const ok = after.borrowed.length === 0 && after.collateral.every((x) => BigInt(x.balance) === 0n);
    p.steps.push({ step: `lending position after: ${after.borrowed.length} debt line(s), ${after.collateral.filter((x) => BigInt(x.balance) > 0n).length} collateral line(s); the cent over the debt stays supplied`, ok });
    save(15, title, ok, p.steps);
  } catch (e) {
    save(15, title, false, [...p.steps, { error: String(e).slice(0, 400) }]);
  }
}

/** 16: unwind each closed account: mandate revoked, supplies withdrawn, tokens and spare NEAR sent home. */
async function unwind() {
  const title = "Unwinding a protected account (mandate revoked, lending withdrawn, tokens and NEAR sent to the owner)";
  const steps: unknown[] = [];
  let ok = true;
  const tokens = [c("usdc"), c("wnear")];
  const check = (label: string, o: Outcome) => {
    const unwound = eventData(o.o, "unwound")[0];
    const partial = eventData(o.o, "unwind_partial");
    const good = !o.failure && !!unwound && partial.length === 0;
    ok &&= good;
    steps.push({ step: `${label}: unwind`, tx: explorer(o.hash), unwound, unwind_partial: partial, ok: good });
  };
  const owners = [closers.wallet, closers.fromWallet].filter((p): p is Person => !!p);
  if (owners.length === 0 && !closers.passkey) owners.push(await person("unwind", 1.5));
  for (const p of owners) {
    try {
      await upgraded(p);
      // The owner registers with each token so the transfers land.
      for (const t of tokens) {
        const reg = await view<unknown>(t, "storage_balance_of", { account_id: p.owner }).catch(() => null);
        if (!reg) await call(p.n, p.owner, t, "storage_deposit", { account_id: p.owner, registration_only: true }, near(0.0125), 30);
      }
      check(`${p.owner} (NEAR-wallet owner, owner_call)`, await ownerCall(p, [ownerActions.unwind(tokens)]));
    } catch (e) {
      ok = false;
      steps.push({ step: p.owner, error: String(e).slice(0, 400) });
    }
  }
  if (closers.passkey) {
    // A passkey owner names where everything goes: here the root, which is registered with both tokens.
    try {
      check("passkey owner (relayed owner_execute)", await relayOwner(closers.passkey, [ownerActions.unwind(tokens, rootId)]));
    } catch (e) {
      ok = false;
      steps.push({ step: "passkey owner", error: String(e).slice(0, 400) });
    }
  }
  save(16, title, ok, steps);
}

/** 17: an enclave-signed health certificate for a reader, anchored on the risk board, verified by the SDK and the API. */
async function certificate(p: Person) {
  const title = "A health certificate: issued by the enclave, anchored on the risk board, verified";
  const steps: unknown[] = [];
  try {
    const token = await parry.signIn(p.account, p.key);
    const reader = rootId;
    const cert = await parry.issueCertificate(token, { account: p.account, reader, threshold: 1.2, ttlSecs: 86_400, venue: "rhea", anchor: true });
    const body = JSON.parse(cert.certificate) as Record<string, unknown>;
    steps.push({ step: `the enclave certifies "${String(body.statement)}" for ${reader} until ${new Date(Number(body.expires_at) * 1000).toISOString()}`, hash: cert.hash, block_height: body.block_height });
    steps.push({ step: "the anchor on the risk board (enclave-signed certificate report)", tx: cert.anchorTx ? explorer(cert.anchorTx) : null });
    // The anchor is read at final finality: give the anchoring transaction's block a few seconds to be final.
    const sdk = await until("the anchor at final finality", 60_000, async () => {
      const v = await parry.verifyCertificate(cert.hash, { reader });
      return v.ok ? v : null;
    }).catch(() => parry.verifyCertificate(cert.hash, { reader }));
    steps.push({ step: "the SDK verifies it against the chain", checks: sdk.checks.map((x) => `${x.status} ${x.name}`) });
    const apiCheck = await api<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(`/v1/verify/${cert.hash}`);
    steps.push({ step: "the API's verification", checks: apiCheck.checks.map((x) => `${x.ok ? "ok" : "FAIL"} ${x.name}`) });
    // Above the position's health, the enclave refuses and signs nothing.
    const refused = await parry.issueCertificate(token, { account: p.account, reader, threshold: 5, ttlSecs: 3600, venue: "rhea", anchor: false }).then(
      () => "signed (unexpected)",
      (e) => String((e as Error).message ?? e).slice(0, 160),
    );
    steps.push({ step: "a threshold above the position's health is refused", answer: refused });
    const ok = sdk.ok && apiCheck.ok && !!cert.anchorTx && /below the threshold/.test(refused);
    save(17, title, ok, steps);
  } catch (e) {
    save(17, title, false, [...steps, { error: String(e).slice(0, 400) }]);
  }
}

/**
 * 18: 10 % of the staking yield moves into the insurance fund. LiNEAR folds a validator's staking
 * rewards into its price when `epoch_update_rewards` runs for it (anyone may call it); the vault
 * skims when it reads a rate above the highest it has seen (a deposit reads it), and the next
 * vault report announces the inflow.
 */
async function insuranceInflow() {
  const title = "An insurance inflow: 10% of the vault's staking yield moves into its fund";
  const steps: unknown[] = [];
  const since = new Date().toISOString();
  try {
    const linear = dep.external?.linear ?? "linear-protocol.testnet";
    const before = await view<{ linear: string; value_usd_e6: string }>(c("vault"), "insurance");
    const state = await view<{ linear_rate_e24: string }>(c("vault"), "vault_state");
    const updateRewards = async () => {
      const validators = await view<{ account_id: string; staked_amount: string }[]>(linear, "get_validators", { offset: 0, limit: 20 });
      for (const v of validators.filter((x) => BigInt(x.staked_amount) > 0n)) {
        const o = await send(root, rootId, linear, "epoch_update_rewards", { validator_id: v.account_id }, 0n, 200);
        if (!o.failure) steps.push({ step: `LiNEAR epoch_update_rewards for ${v.account_id}`, tx: explorer(o.hash) });
      }
    };
    let rate = await view<string>(linear, "ft_price");
    if (BigInt(rate) <= BigInt(state.linear_rate_e24)) {
      await updateRewards();
      rate = await view<string>(linear, "ft_price");
    }
    // LiNEAR's rate rises once per epoch: wait for the next one when this epoch's rewards are already in.
    if (BigInt(rate) <= BigInt(state.linear_rate_e24)) {
      rate = await until("LiNEAR's rate to rise (the next epoch)", Number(process.env.SCENARIO_EPOCH_MS ?? 0), async () => {
        await updateRewards();
        const r = await view<string>(linear, "ft_price");
        return BigInt(r) > BigInt(state.linear_rate_e24) ? r : null;
      }).catch(() => rate);
    }
    steps.push({ step: `LiNEAR rate ${state.linear_rate_e24} last seen by the vault, now ${rate}` });
    if (BigInt(rate) <= BigInt(state.linear_rate_e24)) return save(18, title, false, [...steps, { step: "waits for LiNEAR's next epoch: the rate has not risen since the vault last read it" }]);
    // A deposit makes the vault read the rate (and skim); the root deposits the minimum.
    const d = await call(root, rootId, c("vault"), "deposit", {}, near(0.5), 150);
    steps.push({ step: "a 0.5 NEAR deposit makes the vault read the higher rate and skim the fund's share", tx: explorer(d.hash) });
    const inflow = await until("an insurance_inflow event", Number(process.env.SCENARIO_INSURANCE_MS ?? 15 * 60_000), async () => {
      const ins = await api<{ events: { kind: string; at: string | null; tx: string; linear?: string }[] }>("/v1/vault/insurance");
      return ins.events.find((e) => e.kind === "inflow" && (e.at ?? "") > since);
    });
    const after = await view<{ linear: string; value_usd_e6: string }>(c("vault"), "insurance");
    steps.push({ step: `the vault report announces insurance_inflow of ${inflow.linear} LiNEAR`, tx: explorer(inflow.tx), fundBefore: before, fundAfter: after });
    save(18, title, BigInt(after.linear) > BigInt(before.linear), steps);
  } catch (e) {
    save(18, title, false, [...steps, { error: String(e).slice(0, 400) }]);
  }
}

// ---------------------------------------------------------------------------------------------

console.log(`scenarios on ${sandbox ? "the local sandbox" : "testnet"}, root ${rootId}, API ${API}`);
/**
 * --upgrade-accounts: every protected account whose owner key is on hand (the scenario
 * owners in the keychain, the passkey files) moves to the published account code. Accounts that
 * are gone or already on it are left alone.
 */
async function upgradeAll(): Promise<void> {
  const code = async (account: string) => parry.accountCode(account).catch(() => null);
  const keychain = join(homedir(), ".near-credentials", "testnet");
  let moved = 0;
  for (const file of readdirSync(keychain).filter((f) => f.endsWith(`.${rootId}.json`))) {
    const owner = file.slice(0, -".json".length);
    const account = await parry.protectedAccountId({ nearAccount: owner }).catch(() => null);
    const now = account ? await code(account) : null;
    if (!account || !now || now === ACCOUNT_CODE) continue;
    const key = (JSON.parse(readFileSync(join(keychain, file), "utf8")) as { private_key: string }).private_key;
    const o = await ownerCall({ owner, key, n: client(owner, key), account, steps: [] }, [ownerActions.upgrade(ACCOUNT_CODE)]).catch((e: Error) => ({ hash: "", failure: e.message, o: null }));
    console.log(`${o.failure ? "FAIL" : "ok  "} ${account} (${owner}) ${o.failure ?? explorer(o.hash)}`);
    if (!o.failure) moved++;
  }
  const keys = KEYS_DIR;
  for (const file of readdirSync(keys).filter((f) => f.startsWith("passkey-"))) {
    const k = JSON.parse(readFileSync(join(keys, file), "utf8")) as { account: string; secret: string };
    const now = await code(k.account);
    if (!now || now === ACCOUNT_CODE) continue;
    const p: PasskeyPerson = { owner: "passkey", key: "", n: root, account: k.account, secret: Uint8Array.from(Buffer.from(k.secret, "hex")), steps: [] };
    const o = await relayOwner(p, [ownerActions.upgrade(ACCOUNT_CODE)]).catch((e: Error) => ({ hash: "", failure: e.message, o: null }));
    console.log(`${o.failure ? "FAIL" : "ok  "} ${k.account} (passkey) ${o.failure ?? explorer(o.hash)}`);
    if (!o.failure) moved++;
  }
  console.log(`${moved} accounts moved to ${ACCOUNT_CODE}`);
}

if (process.argv.includes("--upgrade-accounts")) {
  await upgradeAll();
  process.exit(0);
}

// --align-pool alone: bring the testnet exchange pool back to the oracle's price and stop.
if (process.argv.includes("--align-pool")) {
  const tx = await alignPool();
  console.log(tx ? `pool aligned: ${explorer(tx)}` : "the pool is in line with the oracle");
  process.exit(0);
}
if (runs(2) || runs(3) || runs(4) || runs(5) || runs(6)) await protect();
if (runs(7)) await limits();
if (runs(8) && !sandbox) await hlOrder().catch((e) => save(8, "A Hyperliquid order signed by the protected account through Chain Signatures", false, [{ error: String(e), details: (e as { details?: unknown }).details }]));
if (runs(9) && !sandbox) await evmRescue();
if (runs(10)) await vault();
if (runs(11)) await vaultPause();
if (runs(12)) await paid().catch((e) => save(12, "A paid risk check over x402 on NEAR", false, [{ error: String(e) }]));
if (runs(13)) await agents().catch((e) => save(13, "Core flows through the SDK and the MCP server", false, [{ error: String(e) }]));
if (runs(14) || runs(17)) await closeBySelling();
if (runs(15)) await closeFromWallet();
if (runs(16)) await unwind();
if (runs(18)) await insuranceInflow();
console.log(`proofs in ${proofFile.replace(`${ROOT_DIR}/`, "")}`);
