/**
 * Deploys Parry from reproducible builds, step by step and idempotently (a step that is already
 * done is skipped, so a rerun picks up where a failure stopped).
 *
 *   bun scripts/deploy.ts [--wasm-dir contracts/target/near-reproducible/<commit>] [--enclave-key ed25519:...] [--enclave-wasm-sha256 <hex>]
 *   bun scripts/deploy.ts --network mainnet [...]                     print the mainnet plan and its cost, send nothing
 *   bun scripts/deploy.ts --network mainnet --confirm-mainnet [...]   deploy to mainnet (the launch, MAINNET.md)
 *
 * Testnet deploys everything, including the test tokens, the oracle with the market shock, the
 * lending contract (mainnet's exact wasm) and a seeded exchange pool. #mainnet deploys only
 * Parry's own contracts (risk board, vault, the published account code and the factory) and
 * wires them to mainnet's live lending, oracle, exchange, wNEAR, LiNEAR, USDC and MPC signer,
 * as deployments/mainnet.json plans them.
 *
 * Keys: the root account and every account this script creates keep their keys in the NEAR
 * CLI's legacy keychain (~/.near-credentials/<network>/<account>.json), never in the repo;
 * service wallet keys are also written to the gitignored `.env.services` (`.env.services.mainnet`).
 * Output: deployments/<network>.json (account, code hash, transaction and commit per contract).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKey, MlDsa65KeyPair, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";

const ROOT_DIR = join(import.meta.dir, "..");
/** Local key files (gitignored); PARRY_KEYS_DIR points elsewhere. */
const KEYS_DIR = process.env.PARRY_KEYS_DIR ?? join(ROOT_DIR, ".keys");
const argv = process.argv;
const NETWORK: "testnet" | "mainnet" = argv[argv.indexOf("--network") + 1] === "mainnet" && argv.includes("--network") ? "mainnet" : "testnet";
const MAINNET = NETWORK === "mainnet";
const CONFIRMED = argv.includes("--confirm-mainnet");
/** #mainnet: the plan (root, live protocol ids, exchange pool, vault parameters). */
const planned = MAINNET
  ? (JSON.parse(readFileSync(join(ROOT_DIR, "deployments", "mainnet.json"), "utf8")) as {
      root: string;
      status: string;
      external: Record<string, string>;
      dexPool: number;
      params: { hyperliquidNearIndex: number; hedgeRatioBps: number; maxLeverageX100: number; bandBps: number; depositCapNear: string; minDepositNear: string };
    })
  : null;
const RPC = process.env.NEAR_RPC_URL ?? (MAINNET ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const ROOT = process.env.PARRY_ROOT ?? (planned ? planned.root : "parry.testnet");
/** The funded account that creates the testnet root (its key in the keychain or .keys/). */
const BOOTSTRAP = process.env.PARRY_BOOTSTRAP ?? "";
const CRED_DIR = join(homedir(), ".near-credentials", NETWORK);
const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/**
 * `--only risk,vault,account`: (re)deploy only these contracts ("account" is the published global
 * code, "accounts" the factory); every other step still runs and stays idempotent. A reproducible
 * build at another commit has other code hashes (NEP-330 names the commit), so an upgrade of some
 * contracts names them here instead of redeploying the rest.
 */
const ONLY = arg("only")?.split(",").map((x) => x.trim()).filter(Boolean) ?? null;
const wanted = (name: string) => !ONLY || ONLY.includes(name);

const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT_DIR }).stdout.toString().trim();
const wasmDir = arg("wasm-dir") ?? join(ROOT_DIR, "contracts", "target", "near-reproducible", commit);
/** The commit the deployed wasm was built from (its reproducible build directory), which its NEP-330 metadata names. */
const builtFrom = /^[0-9a-f]{40}$/.test(wasmDir.split("/").filter(Boolean).pop() ?? "") ? wasmDir.split("/").filter(Boolean).pop()! : commit;
const depFile = join(ROOT_DIR, "deployments", `${NETWORK}.json`);
type Dep = {
  network: string;
  status: string;
  root: string;
  commit: string;
  contracts: Record<string, { account: string; codeHash?: string; tx?: string; commit?: string; source?: string; migrated?: boolean; verified?: string; factoryCode?: string }>;
  dexPool?: number;
  enclave?: Record<string, string>;
  services?: Record<string, string>;
  /** The transactions that added the service gas keys and the treasury's post-quantum key. */
  keys?: { gasKeys?: Record<string, { account: string; lanes: number; tx?: string }>; postQuantum?: { account: string; scheme: string; tx?: string; signedTx?: string } };
  external?: Record<string, string>;
  params?: unknown;
  updatedAt?: string;
};
const fresh: Dep = { network: NETWORK, status: "deployed", root: ROOT, commit, contracts: {} };
const recorded: Dep | null = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : null;
// The mainnet file starts as the plan; the first confirmed run turns it into the record.
const dep: Dep = recorded && recorded.status !== "planned" ? recorded : { ...fresh, ...(planned ? { external: planned.external, dexPool: planned.dexPool, params: planned.params } : {}) };

function save() {
  mkdirSync(join(ROOT_DIR, "deployments"), { recursive: true });
  dep.updatedAt = new Date().toISOString();
  writeFileSync(depFile, `${JSON.stringify(dep, null, 2)}\n`);
}

function b58(buf: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(buf).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}
const codeHash = (code: Uint8Array) => b58(createHash("sha256").update(code).digest());

function keyOf(account: string): string | null {
  for (const f of [join(CRED_DIR, `${account}.json`), join(KEYS_DIR, `${account}.json`)]) {
    if (existsSync(f)) return (JSON.parse(readFileSync(f, "utf8")) as { private_key: string }).private_key;
  }
  return null;
}

function storeKey(account: string, publicKey: string, privateKey: string) {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(join(CRED_DIR, `${account}.json`), JSON.stringify({ account_id: account, public_key: publicKey, private_key: privateKey }), { mode: 0o600 });
}

function client(account: string): Near {
  const key = keyOf(account);
  if (!key) throw new Error(`no key for ${account} in ${CRED_DIR}`);
  return new Near({ network: { networkId: NETWORK, rpcUrl: RPC }, privateKey: key as never, defaultSignerId: account });
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: T; error?: { cause?: { name?: string } } };
  if (r.error) throw Object.assign(new Error(r.error.cause?.name ?? JSON.stringify(r.error)), { rpc: r.error });
  return r.result as T;
}

async function account(id: string): Promise<{ amount: string; code_hash: string } | null> {
  return rpc<{ amount: string; code_hash: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: id }).catch(() => null);
}

async function viewCall<T>(id: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", { request_type: "call_function", finality: "optimistic", account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (!r.result) throw new Error(`${id}.${method}: ${r.error ?? "no result"}`);
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

function hashOf(o: FinalExecutionOutcome): string {
  return o.transaction?.hash ?? o.transaction_outcome?.id ?? "";
}

function failure(o: FinalExecutionOutcome): string | null {
  for (const s of [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify((s as { Failure: unknown }).Failure).slice(0, 500);
  }
  return null;
}

async function call(from: string, to: string, method: string, args: object, deposit = 0n, tgas = 100): Promise<FinalExecutionOutcome> {
  const o = (await client(from).transaction(from).functionCall(to, method, args, { gas: `${tgas} Tgas` as never, attachedDeposit: `${deposit} yocto` as never }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  const f = failure(o);
  if (f) throw new Error(`${to}.${method} failed (${hashOf(o)}): ${f}`);
  return o;
}

const NEAR_USD_ID = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const USDC_USD_ID = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
async function sourcePrices(): Promise<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[]> {
  // The prices mainnet Rhea lending uses, read with a free mainnet view call.
  const out = [];
  for (const id of [NEAR_USD_ID, USDC_USD_ID]) {
    const r = (await (await fetch("https://free.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: "aggregate-oracle.near", method_name: "get_price_unsafe", args_base64: Buffer.from(JSON.stringify({ price_identifier: id })).toString("base64") } }) })).json()) as { result: { result: number[] } };
    out.push({ id, price: JSON.parse(Buffer.from(r.result.result).toString()) });
  }
  return out;
}

function step(name: string) {
  console.log(`\n== ${name}`);
}

/** Creates `sub.parry.testnet` with a fresh full-access key (or skips when it exists). */
async function subaccount(name: string, balance: number): Promise<string> {
  const id = `${name}.${ROOT}`;
  if (await account(id)) {
    console.log(`exists  ${id}`);
    return id;
  }
  const k = generateKey();
  const o = (await client(ROOT).transaction(ROOT).createAccount(id).transfer(id, `${near(balance)} yocto` as never).addKey(k.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  const f = failure(o);
  if (f) throw new Error(`create ${id}: ${f}`);
  storeKey(id, k.publicKey.toString(), k.secretKey);
  console.log(`created ${id} (${hashOf(o)})`);
  return id;
}

function wasm(name: string): Uint8Array {
  const f = join(wasmDir, `parry_${name}.wasm`);
  if (!existsSync(f)) throw new Error(`missing ${f}: run contracts/scripts/build.sh --reproducible ${commit}`);
  const code = new Uint8Array(readFileSync(f));
  // Never deploy a build that carries a builder's local paths.
  if (Buffer.from(code).toString("latin1").includes("/Users/")) throw new Error(`${f} carries local file paths: deploy only reproducible builds`);
  return code;
}

/**
 * Deploys `name`'s wasm to `id` and calls `init` once (skipped when the same code is there). With
 * `migrate`, new code on an existing contract runs `migrate()` in the same batch, so the state is
 * never read with a layout it does not have; a contract already migrated refuses it (the whole
 * batch reverts) and the code alone is deployed.
 */
async function deploy(name: string, id: string, init: { method: string; args: object } | null, opts: { migrate?: boolean } = {}) {
  if (!wanted(name)) {
    console.log(`skip    ${id} (not in --only)`);
    return;
  }
  const code = wasm(name);
  const hash = codeHash(code);
  const a = await account(id);
  if (a?.code_hash === hash) {
    console.log(`same    ${id} ${hash}`);
    return;
  }
  const fresh = !a || a.code_hash === "11111111111111111111111111111111";
  const send = async (migrate: boolean) => {
    let tx = client(id).transaction(id).deployContract(id, code);
    if (init && fresh) tx = tx.functionCall(id, init.method, init.args, { gas: "100 Tgas" as never });
    if (migrate) tx = tx.functionCall(id, "migrate", {}, { gas: "100 Tgas" as never });
    return (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  };
  let migrated = !!opts.migrate && !fresh;
  let o = await send(migrated);
  if (migrated && /already migrated/.test(failure(o) ?? "")) {
    migrated = false;
    o = await send(false);
  }
  const f = failure(o);
  if (f) throw new Error(`deploy ${id}: ${f}`);
  dep.contracts[name] = { account: id, codeHash: hash, tx: hashOf(o), commit: builtFrom, source: "contracts/" + name, ...(migrated ? { migrated: true } : {}) };
  save();
  console.log(`deployed ${id} ${hash} (${hashOf(o)})${migrated ? ", state migrated in the same batch" : ""}`);
}

/** Contract accounts and their opening balances (code storage at 1 NEAR per 100 kB, plus room for state). */
const CONTRACT_ACCOUNTS: readonly (readonly [string, number])[] = MAINNET
  ? [["risk", 4], ["vault", 4], ["accounts", 3]]
  : [["usdc", 2.5], ["boost", 2.2], ["oracle", 2.5], ["risk", 5], ["lending", 12], ["vault", 4.5], ["accounts", 2.5]];
/**
 * Service wallets and their opening balances, which include their gas keys' prepaid NEAR (the
 * agent wallet backs the MCP write tools, which exist on testnet only). The top-up service
 * refills each to this balance from the treasury.
 */
const WALLETS: readonly (readonly [string, number])[] = MAINNET
  ? [["treasury", 5], ["monitor", 2], ["guardian", 2], ["keeper", 3], ["relayer", 5], ["api", 0.5], ["enclave", 2]]
  : [["treasury", 2], ["monitor", 1.5], ["guardian", 3], ["keeper", 3.5], ["relayer", 6], ["api", 0.5], ["agent", 1], ["enclave", 3]];
/** Gas keys: the wallet, its nonce lanes and the NEAR prepaid into the key (out of the wallet's balance). */
const GAS_KEYS: readonly (readonly [string, number, number])[] = [
  ["monitor", 4, 0.5],
  ["keeper", 8, 2],
  ["relayer", 8, 1],
];
/** Protocols Parry uses but does not own; on testnet the lending, oracle and USDC ids are filled in once deployed. */
const X: Record<string, string> = planned
  ? { ...planned.external }
  : { wnear: "wrap.testnet", linear: "linear-protocol.testnet", dex: "ref-finance-101.testnet", signer: "v1.signer-prod.testnet" };

/** The storage NEAR a contract's code locks (1 NEAR per 100 kB), and ten times that, burnt, for global code. */
const storageNear = (bytes: number) => bytes / 100_000;

/** #mainnet: what a confirmed run would create and spend, checked against the root's balance. */
async function mainnetPlan(): Promise<void> {
  const code = (name: string) => readFileSync(join(wasmDir, `parry_${name}.wasm`)).length;
  const rows: [string, number][] = [];
  for (const [name, bal] of CONTRACT_ACCOUNTS) rows.push([`${name}.${ROOT}: account with ${name === "accounts" ? "the factory" : `the ${name}`} (${(code(name === "accounts" ? "accounts" : name) / 1000).toFixed(0)} kB of code)`, bal]);
  for (const [name, bal] of WALLETS) {
    const key = GAS_KEYS.find(([n]) => n === name);
    rows.push([`${name}.${ROOT}: service wallet${key ? `, ${key[2]} NEAR of it prepaid into a gas key with ${key[1]} lanes` : ""}`, bal]);
  }
  const accountCode = code("account");
  rows.push([`publish the protected-account code by hash (${(accountCode / 1000).toFixed(0)} kB, burns 10x storage)`, storageNear(accountCode) * 10]);
  rows.push(["transaction fees and storage registrations (LiNEAR, wNEAR, USDC)", 1]);
  const total = rows.reduce((a, [, n]) => a + n, 0);
  console.log(`#mainnet plan under ${ROOT} (dry run: nothing is sent without --confirm-mainnet)\n`);
  for (const [what, n] of rows) console.log(`  ${n.toFixed(2).padStart(7)} NEAR  ${what}`);
  console.log(`  ${total.toFixed(2).padStart(7)} NEAR  total from ${ROOT}\n`);
  const root = await account(ROOT);
  console.log(root ? `${ROOT} holds ${(Number(BigInt(root.amount) / 10n ** 21n) / 1000).toFixed(2)} NEAR` : `${ROOT} does not exist yet: register it with a mainnet wallet first`);
  console.log(keyOf(ROOT) ? `a key for ${ROOT} is in ${CRED_DIR}` : `no key for ${ROOT} in ${CRED_DIR}`);
  console.log(`wired to: ${Object.entries(X).map(([k, v]) => `${k} ${v}`).join(", ")}, exchange pool ${planned!.dexPool}`);
}

async function main() {
  if (MAINNET && !CONFIRMED) return mainnetPlan();
  step("root account");
  if (MAINNET) {
    if (!(await account(ROOT))) throw new Error(`${ROOT} does not exist: register it with a mainnet wallet first (MAINNET.md)`);
    console.log(`exists  ${ROOT}`);
  } else if (!(await account(ROOT))) {
    if (!BOOTSTRAP) throw new Error(`${ROOT} does not exist: set PARRY_BOOTSTRAP to a funded testnet account that creates it`);
    const boot = keyOf(BOOTSTRAP);
    if (!boot) throw new Error(`no key for the bootstrap account ${BOOTSTRAP}`);
    const bal = await account(BOOTSTRAP);
    if (!bal) throw new Error(`fund ${BOOTSTRAP} with testnet NEAR first`);
    const k = generateKey();
    // Room for the transaction itself: prepaid gas is charged at a pessimistic gas price.
    const keep = near(0.5);
    const amount = BigInt(bal.amount) - keep;
    await call(BOOTSTRAP, NETWORK, "create_account", { new_account_id: ROOT, new_public_key: k.publicKey.toString() }, amount, 100);
    storeKey(ROOT, k.publicKey.toString(), k.secretKey);
    console.log(`created ${ROOT} with ${Number(amount / 10n ** 21n) / 1000} NEAR`);
  } else console.log(`exists  ${ROOT}`);

  step("contract and wallet accounts");
  const ids: Record<string, string> = {};
  for (const [n, bal] of CONTRACT_ACCOUNTS) ids[n] = await subaccount(n, bal);
  const wallets: Record<string, string> = {};
  for (const [n, bal] of WALLETS) wallets[n] = await subaccount(n, bal);
  dep.services = wallets;
  save();

  step("service keys and gas-key lanes");
  // OutLayer binds the enclave's keys to the build and the calling account, so every service
  // calls it from `enclave`, each with its own key. Monitor, keeper and relayer also get a gas
  // key with nonce lanes on their own account, for parallel transactions.
  const env: string[] = [`PARRY_NETWORK=${NETWORK}`, `ENCLAVE_ACCOUNT_ID=${wallets.enclave}`, `X402_PAY_TO=${wallets.api}`];
  // The services that run the enclave: the risk engine (risk reports), the keeper (vault reports,
  // the sealing key), the guardian, and the API (health certificates).
  for (const svc of ["risk", "keeper", "guardian", "api"]) {
    const file = join(KEYS_DIR, `enclave-${svc}.json`);
    if (!existsSync(file)) {
      const k = generateKey();
      const o = (await client(wallets.enclave!).transaction(wallets.enclave!).addKey(k.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
      if (failure(o)) throw new Error(`enclave key: ${failure(o)}`);
      writeFileSync(file, JSON.stringify({ account_id: wallets.enclave, public_key: k.publicKey.toString(), private_key: k.secretKey }), { mode: 0o600 });
    }
    env.push(`ENCLAVE_KEY_${svc.toUpperCase()}=${(JSON.parse(readFileSync(file, "utf8")) as { private_key: string }).private_key}`);
  }
  for (const [svc, lanes, prepaid] of GAS_KEYS) {
    const id = wallets[svc]!;
    const file = join(KEYS_DIR, `${svc}-gas-key.json`);
    if (!existsSync(file)) {
      const k = generateKey();
      const o = (await client(id).transaction(id).addKey(k.publicKey.toString(), { type: "gasKeyFullAccess", numNonces: lanes }).transferToGasKey(k.publicKey.toString(), `${near(prepaid)} yocto` as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
      if (failure(o)) throw new Error(`gas key for ${svc}: ${failure(o)}`);
      writeFileSync(file, JSON.stringify({ account_id: id, public_key: k.publicKey.toString(), private_key: k.secretKey, lanes, tx: hashOf(o) }), { mode: 0o600 });
    }
    const g = JSON.parse(readFileSync(file, "utf8")) as { public_key: string; private_key: string; lanes: number; tx?: string };
    dep.keys = { ...dep.keys, gasKeys: { ...dep.keys?.gasKeys, [svc]: { account: id, lanes: g.lanes, tx: g.tx } } };
    const P = svc.toUpperCase();
    env.push(`${P}_ACCOUNT_ID=${id}`, `${P}_PRIVATE_KEY=${g.private_key}`, `${P}_PUBLIC_KEY=${g.public_key}`, `${P}_LANES=${g.lanes}`);
  }
  for (const svc of ["guardian", "agent"].filter((w) => wallets[w])) {
    env.push(`${svc.toUpperCase()}_ACCOUNT_ID=${wallets[svc]}`, `${svc.toUpperCase()}_PRIVATE_KEY=${keyOf(wallets[svc]!)}`);
  }
  // The treasury holds the most NEAR and its key lives longest, so the top-up service signs with a
  // post-quantum ML-DSA-65 (FIPS 204) key; its ed25519 key stays in the keychain for recovery.
  const pqFile = join(KEYS_DIR, "treasury-ml-dsa-65.json");
  if (!existsSync(pqFile)) {
    const pq = MlDsa65KeyPair.fromRandom();
    const o = (await client(wallets.treasury!).transaction(wallets.treasury!).addKey(pq.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
    if (failure(o)) throw new Error(`treasury ML-DSA-65 key: ${failure(o)}`);
    writeFileSync(pqFile, JSON.stringify({ account_id: wallets.treasury, public_key: pq.publicKey.toString(), private_key: pq.secretKey, tx: hashOf(o) }), { mode: 0o600 });
    console.log(`treasury signs with ML-DSA-65 (${hashOf(o)})`);
  }
  const pqKey = JSON.parse(readFileSync(pqFile, "utf8")) as { tx?: string };
  dep.keys = { ...dep.keys, postQuantum: { ...dep.keys?.postQuantum, account: wallets.treasury!, scheme: "ML-DSA-65", tx: pqKey.tx } };
  save();
  env.push(`TREASURY_ACCOUNT_ID=${wallets.treasury}`, `TREASURY_PRIVATE_KEY=${(JSON.parse(readFileSync(pqFile, "utf8")) as { private_key: string }).private_key}`);
  // The top-up service refills each wallet from the treasury to its opening balance.
  // Each target is the account's own opening balance: what is left after its gas key's prepaid NEAR.
  const prepaid = (n: string) => GAS_KEYS.find(([k]) => k === n)?.[2] ?? 0;
  env.push(`TOPUP_WALLETS=${WALLETS.filter(([n]) => n !== "treasury" && wallets[n]).map(([n, bal]) => `${n}:${wallets[n]}:${bal - prepaid(n)}`).join(",")}`);
  const envFile = MAINNET ? ".env.services.mainnet" : ".env.services";
  writeFileSync(join(ROOT_DIR, envFile), `${env.join("\n")}\n`, { mode: 0o600 });
  console.log(`wrote ${envFile} (gitignored)`);

  if (!MAINNET) await testnetOnly(ids, wallets);
  else {
    // #mainnet: the vault holds LiNEAR, wNEAR and USDC, so it registers with each.
    for (const t of [X.linear!, X.wnear!, X.usdc!]) {
      const reg = await viewCall<unknown>(t, "storage_balance_of", { account_id: ids.vault }).catch(() => null);
      if (!reg) await call(ROOT, t, "storage_deposit", { account_id: ids.vault, registration_only: true }, near(0.0125), 30);
    }
    dep.dexPool = planned!.dexPool;
    save();
  }
  await shared(ids, wallets);
  console.log(`\nDone. deployments/${NETWORK}.json is up to date.`);
}

/** Test tokens, the oracle, the lending contract and the exchange pool: testnet only. */
async function testnetOnly(ids: Record<string, string>, wallets: Record<string, string>) {
  step("test tokens");
  await deploy("token", ids.usdc!, { method: "new", args: { owner_id: ROOT, name: "USD Coin (Parry test)", symbol: "USDC", decimals: 6, icon: null, faucet_amount: "1000000000", faucet_period_secs: 3600 } });
  // `deploy` records the last token deploy under "token"; a rerun that finds the same code records nothing.
  if (dep.contracts.token) dep.contracts.usdc = dep.contracts.token;
  await deploy("token", ids.boost!, { method: "new", args: { owner_id: ROOT, name: "Booster (Parry test)", symbol: "BOOST", decimals: 18, icon: null, faucet_amount: "1", faucet_period_secs: 86400 } });
  if (dep.contracts.token) dep.contracts.boost = { ...dep.contracts.token, account: ids.boost! };
  // Both run the token code: a rerun that deploys nothing still records the booster's hash and build.
  const usdc = dep.contracts.usdc;
  if (usdc && dep.contracts.boost) dep.contracts.boost = { ...dep.contracts.boost, codeHash: usdc.codeHash, commit: usdc.commit, source: usdc.source };
  delete dep.contracts.token;
  save();

  step("oracle");
  await deploy("oracle", ids.oracle!, { method: "new", args: { owner_id: ROOT, feeders: [wallets.keeper, ROOT], network: NETWORK, max_shock_bps: 4000 } });
  const live = await sourcePrices();
  await call(ROOT, ids.oracle!, "update_prices", { updates: live.map((p) => ({ price_id: p.id, price: p.price.price, conf: p.price.conf, expo: p.price.expo, publish_time: Math.floor(Date.now() / 1000) })) }).catch((e) => console.log(`prices: ${e.message}`));
  const nearPrice = Number(live[0]!.price.price) * 10 ** live[0]!.price.expo;
  console.log(`NEAR ${nearPrice}`);

  step("lending (the exact mainnet wasm)");
  const lendingCode = new Uint8Array(readFileSync(join(ROOT_DIR, "contracts", "target", "fixtures", "lending.wasm")));
  const lendingHash = codeHash(lendingCode);
  if (lendingHash !== "6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa") throw new Error("the lending fixture is not mainnet's code");
  if ((await account(ids.lending!))?.code_hash !== lendingHash) {
    const o = (await client(ids.lending!).transaction(ids.lending!).deployContract(ids.lending!, lendingCode).functionCall(ids.lending!, "new", { config: {
      oracle_account_id: ids.oracle, pyth_oracle_account_id: ids.oracle, ref_exchange_id: "ref-finance-101.testnet", owner_id: ROOT, booster_token_id: ids.boost, booster_decimals: 18,
      max_num_assets: 20, maximum_recency_duration_sec: 90, maximum_staleness_duration_sec: 90, lp_tokens_info_valid_duration_sec: 600, pyth_price_valid_duration_sec: 120,
      minimum_staking_duration_sec: 2592000, maximum_staking_duration_sec: 7776000, x_booster_multiplier_at_maximum_staking_duration: 30000, force_closing_enabled: true,
      enable_price_oracle: false, enable_pyth_oracle: true, contract_mode: "Running", boost_suppress_factor: 1000, dcl_id: "ref-finance-101.testnet", pause_operator_id: null,
    } }, { gas: "100 Tgas" as never }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
    if (failure(o)) throw new Error(`lending: ${failure(o)}`);
    dep.contracts.lending = { account: ids.lending!, codeHash: lendingHash, tx: hashOf(o), source: "Rhea lending v0.16.2, the code deployed at contract.main.burrow.near" };
    save();
    const asset = (ratio: number, extra: number, rate: string) => ({ reserve_ratio: 2500, beneficiaries: {}, target_utilization: 8000, target_utilization_rate: rate, max_utilization_rate: "1000000000039724853136740579",
      holding_position_fee_rate: "1000000000000000000000000000", volatility_ratio: ratio, extra_decimals: extra, can_deposit: true, can_withdraw: true, can_use_as_collateral: true, can_borrow: true,
      net_tvl_multiplier: 0, max_change_rate: null, supplied_limit: "1000000000000000000000000000000000", borrowed_limit: "1000000000000000000000000000000000", min_borrowed_amount: "1000000000" });
    await call(ROOT, ids.lending!, "add_asset", { token_id: "wrap.testnet", asset_config: asset(7500, 0, "1000000000003593629036885046") }, 1n);
    await call(ROOT, ids.lending!, "add_asset", { token_id: ids.usdc, asset_config: asset(9500, 12, "1000000000001847694955734069") }, 1n);
    const pyth = (d: number, id: string) => ({ decimals: d, fraction_digits: 4, price_identifier: id, extra_call: null, default_price: null });
    await call(ROOT, ids.lending!, "add_token_pyth_info", { token_id: "wrap.testnet", token_pyth_info: pyth(24, "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750") }, 1n);
    await call(ROOT, ids.lending!, "add_token_pyth_info", { token_id: ids.usdc, token_pyth_info: pyth(6, "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a") }, 1n);
  } else console.log(`same    ${ids.lending}`);

  step("liquidity");
  for (const t of [ids.usdc!, "wrap.testnet"]) for (const who of [ROOT, ids.lending!, "ref-finance-101.testnet", ids.vault!, wallets.keeper!, wallets.api!, wallets.agent!]) {
    const reg = await viewCall<unknown>(t, "storage_balance_of", { account_id: who }).catch(() => null);
    if (!reg) await call(ROOT, t, "storage_deposit", { account_id: who, registration_only: true }, near(0.01), 30);
  }
  const usdcBal = BigInt(await viewCall<string>(ids.usdc!, "ft_balance_of", { account_id: ROOT }));
  if (usdcBal < 1_000_000_000n) await call(ROOT, ids.usdc!, "mint", { account_id: ROOT, amount: "2000000000000" }, 1n, 30);
  const lendReg = await viewCall<unknown>(ids.lending!, "storage_balance_of", { account_id: ROOT }).catch(() => null);
  if (!lendReg) await call(ROOT, ids.lending!, "storage_deposit", { account_id: ROOT }, near(0.25), 30);
  const supplied = await viewCall<{ supplied: unknown[] } | null>(ids.lending!, "get_account", { account_id: ROOT });
  if (!supplied || supplied.supplied.length === 0) await call(ROOT, ids.usdc!, "ft_transfer_call", { receiver_id: ids.lending, amount: "500000000000", msg: "" }, 1n, 150);

  // The wNEAR/USDC pool rescue swaps use, priced at the oracle's NEAR price.
  if (dep.dexPool === undefined) {
    const dex = "ref-finance-101.testnet";
    const reg = await viewCall<unknown>(dex, "storage_balance_of", { account_id: ROOT }).catch(() => null);
    if (!reg) await call(ROOT, dex, "storage_deposit", { account_id: ROOT, registration_only: false }, near(0.5), 30);
    const o = await call(ROOT, dex, "add_simple_pool", { tokens: ["wrap.testnet", ids.usdc], fee: 25 }, near(0.1), 50);
    const pool = JSON.parse(Buffer.from((o.status as { SuccessValue: string }).SuccessValue, "base64").toString()) as number;
    await call(ROOT, dex, "register_tokens", { token_ids: ["wrap.testnet", ids.usdc] }, 1n, 30);
    const poolNear = Number(process.env.POOL_NEAR ?? 5);
    await call(ROOT, "wrap.testnet", "near_deposit", {}, near(poolNear), 30);
    await call(ROOT, "wrap.testnet", "ft_transfer_call", { receiver_id: dex, amount: near(poolNear).toString(), msg: "" }, 1n, 100);
    const usdcIn = BigInt(Math.round(poolNear * nearPrice * 1e6));
    await call(ROOT, ids.usdc!, "ft_transfer_call", { receiver_id: dex, amount: usdcIn.toString(), msg: "" }, 1n, 100);
    await call(ROOT, dex, "add_liquidity", { pool_id: pool, amounts: [near(poolNear).toString(), usdcIn.toString()] }, near(0.01), 100);
    dep.dexPool = pool;
    save();
    console.log(`pool ${pool}: ${poolNear} wNEAR / ${Number(usdcIn) / 1e6} USDC`);
  }
  X.lending = ids.lending!;
  X.oracle = ids.oracle!;
  X.usdc = ids.usdc!;
}

/** The risk board, the vault, the published account code and the factory, on either network. */
async function shared(ids: Record<string, string>, wallets: Record<string, string>) {
  step("risk board");
  const enclaveKey = arg("enclave-key") ?? dep.enclave?.publicKey;
  const enclaveHash = arg("enclave-wasm-sha256") ?? dep.enclave?.wasmSha256;
  if (!enclaveKey || !enclaveHash) throw new Error("pass --enclave-key and --enclave-wasm-sha256 from the enclave's keys run on OutLayer (scripts/enclave.ts keys)");
  dep.enclave = { ...(dep.enclave ?? {}), publicKey: enclaveKey, wasmSha256: enclaveHash };
  save();
  // The board must be migrated before an enclave build that writes the new report fields runs: it refuses unknown fields.
  await deploy("risk", ids.risk!, { method: "new", args: { owner_id: ROOT, enclave_key: enclaveKey, wasm_sha256: enclaveHash, vault: ids.vault } }, { migrate: true });
  // Another enclave build has other keys (OutLayer derives them from the build): rotate the board to them.
  const trusted = await viewCall<{ public_key: string; wasm_sha256: string } | null>(ids.risk!, "get_enclave").catch(() => null);
  if (trusted && (trusted.public_key !== enclaveKey || trusted.wasm_sha256 !== enclaveHash)) {
    const o = await call(ROOT, ids.risk!, "set_enclave", { public_key: enclaveKey, wasm_sha256: enclaveHash, note: `build ${enclaveHash.slice(0, 16)}` }, 1n, 30);
    dep.enclave = { ...dep.enclave, setEnclaveTx: hashOf(o) };
    save();
    console.log(`enclave key rotated to ${enclaveKey} (${hashOf(o)})`);
  }
  // The enclave's signed sealing-key report (scripts/enclave.ts keys): owners seal policies to it.
  const sealing = await viewCall<{ public_key: string } | null>(ids.risk!, "sealing_key").catch(() => null);
  if (dep.enclave.sealingReport && sealing?.public_key !== dep.enclave.sealingPublicKey) {
    const o = await call(ROOT, ids.risk!, "submit", { report_json: dep.enclave.sealingReport, signature: dep.enclave.sealingSignature }, 0n, 50);
    dep.enclave = { ...dep.enclave, sealingTx: hashOf(o) };
    save();
    console.log(`sealing key ${dep.enclave.sealingPublicKey} (${hashOf(o)})`);
  }

  step("vault");
  const v = planned?.params ?? { hyperliquidNearIndex: 54, hedgeRatioBps: 9000, maxLeverageX100: 300, bandBps: 200, depositCapNear: "500", minDepositNear: "0.5" };
  await deploy("vault", ids.vault!, { method: "new", args: {
    owner_id: ROOT, network: NETWORK, risk: ids.risk, keeper: wallets.keeper, linear: X.linear, wnear: X.wnear, usdc: X.usdc, oracle: X.oracle, signer: X.signer,
    hedge: { asset: "NEAR", asset_index: v.hyperliquidNearIndex, sz_decimals: 1, hedge_ratio_bps: v.hedgeRatioBps, max_leverage_x100: v.maxLeverageX100, band_bps: v.bandBps },
    deposit_cap: near(Number(v.depositCapNear)).toString(), min_deposit: near(Number(v.minDepositNear)).toString(),
  } }, { migrate: true });
  const linReg = await viewCall<unknown>(X.linear!, "storage_balance_of", { account_id: ids.vault }).catch(() => null);
  if (!linReg) await call(ROOT, X.linear!, "storage_deposit", { account_id: ids.vault, registration_only: true }, near(0.01), 30);

  step("protected-account code (global, by hash) and the factory");
  const acctCode = wanted("account") ? wasm("account") : null;
  const acctHash = acctCode ? codeHash(acctCode) : dep.contracts.account!.codeHash!;
  // Publishing burns ten times the storage price (about 36 NEAR for this code): never twice for
  // the same hash, so the recorded deployment is the check.
  if (acctCode && dep.contracts.account?.codeHash !== acctHash) {
    const o = (await client(ROOT).transaction(ROOT).publishContract(acctCode, { identifiedBy: "hash" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
    if (failure(o)) throw new Error(`publish: ${failure(o)}`);
    // The factory keeps the code new accounts are born with once any exist (their addresses commit
    // to it): record it, so the check knows a newer hash is reached by `upgrade`, not by birth.
    const born = dep.contracts.account?.factoryCode ?? dep.contracts.account?.codeHash;
    dep.contracts.account = { account: "global", codeHash: acctHash, tx: hashOf(o), commit: builtFrom, source: "contracts/account", ...(born && born !== acctHash ? { factoryCode: born } : {}) };
    save();
    console.log(`published account code ${acctHash} (${hashOf(o)})`);
  }
  // The lending contract's own asset settings: wNEAR with no extra decimals, USDC with 12.
  const protocol = {
    lending: X.lending, oracle: X.oracle, dex: X.dex, risk: ids.risk, signer: X.signer, factory: ids.accounts,
    tokens: [
      { token_id: X.wnear, symbol: "wNEAR", decimals: 24, extra_decimals: 0, price_id: NEAR_USD_ID, rate_call: null, mark: "NEAR" },
      { token_id: X.usdc, symbol: "USDC", decimals: 6, extra_decimals: 12, price_id: USDC_USD_ID, rate_call: null, mark: null },
    ],
  };
  await deploy("accounts", ids.accounts!, { method: "new", args: { owner: ROOT, network: NETWORK, protocol, account_code: acctHash } });
  dep.contracts.factory = dep.contracts.accounts!;
  save();
}

await main();
