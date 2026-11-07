/**
 * Deploys Parry to testnet from reproducible builds, step by step and idempotently (a step that
 * is already done is skipped, so a rerun picks up where a failure stopped).
 *
 *   bun scripts/deploy.ts [--wasm-dir contracts/target/near-reproducible/<commit>] [--enclave-key ed25519:...] [--enclave-wasm-sha256 <hex>]
 *
 * Keys: the root `parry.testnet` and every account this script creates keep their keys in the
 * NEAR CLI's legacy keychain (~/.near-credentials/testnet/<account>.json), never in the repo;
 * service wallet keys are also written to the gitignored `.env.services`.
 * Output: deployments/testnet.json (account, code hash, transaction and commit per contract).
 * #mainnet: mainnet deploys use MAINNET.md's steps and wait for the owner's go-ahead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKey, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";

const ROOT_DIR = join(import.meta.dir, "..");
const NETWORK = "testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const ROOT = process.env.PARRY_ROOT ?? "parry.testnet";
const BOOTSTRAP = process.env.PARRY_BOOTSTRAP ?? "d0dab28d069e68db06179a10ed526611b888b62179bf1cf510217de2127c8a11";
const CRED_DIR = join(homedir(), ".near-credentials", NETWORK);
const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT_DIR }).stdout.toString().trim();
const wasmDir = arg("wasm-dir") ?? join(ROOT_DIR, "contracts", "target", "near-reproducible", commit);
const depFile = join(ROOT_DIR, "deployments", `${NETWORK}.json`);
type Dep = { network: string; status: string; root: string; commit: string; contracts: Record<string, { account: string; codeHash?: string; tx?: string; commit?: string; source?: string }>; dexPool?: number; enclave?: Record<string, string>; services?: Record<string, string>; updatedAt?: string };
const dep: Dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : { network: NETWORK, status: "deployed", root: ROOT, commit, contracts: {} };

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
  for (const f of [join(CRED_DIR, `${account}.json`), join(ROOT_DIR, "internal", "keys", `${account}.json`)]) {
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
  const r = await rpc<{ result: number[] }>("query", { request_type: "call_function", finality: "optimistic", account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
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

/** Deploys `name`'s wasm to `id` and calls `init` once (skipped when the same code is there). */
async function deploy(name: string, id: string, init: { method: string; args: object } | null) {
  const code = wasm(name);
  const hash = codeHash(code);
  const a = await account(id);
  if (a?.code_hash === hash) {
    console.log(`same    ${id} ${hash}`);
    return;
  }
  let tx = client(id).transaction(id).deployContract(id, code);
  if (init && (!a || a.code_hash === "11111111111111111111111111111111")) tx = tx.functionCall(id, init.method, init.args, { gas: "100 Tgas" as never });
  const o = (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  const f = failure(o);
  if (f) throw new Error(`deploy ${id}: ${f}`);
  dep.contracts[name] = { account: id, codeHash: hash, tx: hashOf(o), commit, source: "contracts/" + name };
  save();
  console.log(`deployed ${id} ${hash} (${hashOf(o)})`);
}

async function main() {
  step("root account");
  if (!(await account(ROOT))) {
    const boot = keyOf(BOOTSTRAP);
    if (!boot) throw new Error(`no key for the bootstrap account ${BOOTSTRAP}`);
    const bal = await account(BOOTSTRAP);
    if (!bal) throw new Error(`fund ${BOOTSTRAP} with testnet NEAR first`);
    const k = generateKey();
    const keep = near(0.05);
    const amount = BigInt(bal.amount) - keep;
    await call(BOOTSTRAP, NETWORK, "create_account", { new_account_id: ROOT, new_public_key: k.publicKey.toString() }, amount, 100);
    storeKey(ROOT, k.publicKey.toString(), k.secretKey);
    console.log(`created ${ROOT} with ${Number(amount / 10n ** 21n) / 1000} NEAR`);
  } else console.log(`exists  ${ROOT}`);

  step("contract and wallet accounts");
  const ids: Record<string, string> = {};
  for (const [n, bal] of [["usdc", 4], ["boost", 3], ["oracle", 4], ["risk", 6], ["lending", 13], ["vault", 6], ["accounts", 5]] as const) ids[n] = await subaccount(n, bal);
  const wallets: Record<string, string> = {};
  for (const [n, bal] of [["treasury", 2], ["monitor", 3], ["guardian", 5], ["keeper", 6], ["relayer", 6], ["api", 1], ["agent", 3], ["enclave", 4]] as const) wallets[n] = await subaccount(n, bal);
  dep.services = wallets;
  save();

  step("service keys and gas-key lanes");
  // OutLayer binds the enclave's keys to the build and the calling account, so every service
  // calls it from `enclave`, each with its own key. Monitor, keeper and relayer also get a gas
  // key with nonce lanes on their own account, for parallel transactions.
  const env: string[] = [`PARRY_NETWORK=${NETWORK}`, `ENCLAVE_ACCOUNT_ID=${wallets.enclave}`, `TREASURY_ACCOUNT_ID=${wallets.treasury}`, `X402_PAY_TO=${wallets.api}`];
  for (const svc of ["monitor", "keeper", "guardian"]) {
    const file = join(ROOT_DIR, "internal", "keys", `enclave-${svc}.json`);
    if (!existsSync(file)) {
      const k = generateKey();
      const o = (await client(wallets.enclave!).transaction(wallets.enclave!).addKey(k.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
      if (failure(o)) throw new Error(`enclave key: ${failure(o)}`);
      writeFileSync(file, JSON.stringify({ account_id: wallets.enclave, public_key: k.publicKey.toString(), private_key: k.secretKey }), { mode: 0o600 });
    }
    env.push(`ENCLAVE_KEY_${svc.toUpperCase()}=${(JSON.parse(readFileSync(file, "utf8")) as { private_key: string }).private_key}`);
  }
  for (const [svc, lanes] of [["monitor", 4], ["keeper", 8], ["relayer", 8]] as const) {
    const id = wallets[svc]!;
    const file = join(ROOT_DIR, "internal", "keys", `${svc}-gas-key.json`);
    if (!existsSync(file)) {
      const k = generateKey();
      const o = (await client(id).transaction(id).addKey(k.publicKey.toString(), { type: "gasKeyFullAccess", numNonces: lanes }).transferToGasKey(k.publicKey.toString(), `${near(1.5)} yocto` as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
      if (failure(o)) throw new Error(`gas key for ${svc}: ${failure(o)}`);
      writeFileSync(file, JSON.stringify({ account_id: id, public_key: k.publicKey.toString(), private_key: k.secretKey, lanes }), { mode: 0o600 });
    }
    const g = JSON.parse(readFileSync(file, "utf8")) as { public_key: string; private_key: string; lanes: number };
    const P = svc.toUpperCase();
    env.push(`${P}_ACCOUNT_ID=${id}`, `${P}_PRIVATE_KEY=${g.private_key}`, `${P}_PUBLIC_KEY=${g.public_key}`, `${P}_LANES=${g.lanes}`);
  }
  for (const svc of ["guardian", "treasury", "agent"]) {
    env.push(`${svc.toUpperCase()}_ACCOUNT_ID=${wallets[svc]}`, `${svc.toUpperCase()}_PRIVATE_KEY=${keyOf(wallets[svc]!)}`);
  }
  writeFileSync(join(ROOT_DIR, ".env.services"), `${env.join("\n")}\n`, { mode: 0o600 });
  console.log("wrote .env.services (gitignored)");

  step("test tokens");
  await deploy("token", ids.usdc!, { method: "new", args: { owner_id: ROOT, name: "USD Coin (Parry test)", symbol: "USDC", decimals: 6, icon: null, faucet_amount: "1000000000", faucet_period_secs: 3600 } });
  dep.contracts.usdc = dep.contracts.token!;
  await deploy("token", ids.boost!, { method: "new", args: { owner_id: ROOT, name: "Booster (Parry test)", symbol: "BOOST", decimals: 18, icon: null, faucet_amount: "1", faucet_period_secs: 86400 } });
  dep.contracts.boost = { ...dep.contracts.token!, account: ids.boost! };
  delete dep.contracts.token;
  save();

  step("oracle");
  await deploy("oracle", ids.oracle!, { method: "new", args: { owner_id: ROOT, feeders: [wallets.keeper, ROOT], network: NETWORK, max_shock_bps: 4000 } });
  const hermes = (await (await fetch("https://hermes.pyth.network/v2/updates/price/latest?ids[]=c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750&ids[]=eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a&parsed=true")).json()) as { parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
  await call(ROOT, ids.oracle!, "update_prices", { updates: hermes.parsed.map((p) => ({ price_id: p.id, price: p.price.price, conf: p.price.conf, expo: p.price.expo, publish_time: p.price.publish_time })) }).catch((e) => console.log(`prices: ${e.message}`));
  const nearPrice = Number(hermes.parsed[0]!.price.price) * 10 ** hermes.parsed[0]!.price.expo;
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
    const poolNear = Number(process.env.POOL_NEAR ?? 15);
    await call(ROOT, "wrap.testnet", "near_deposit", {}, near(poolNear), 30);
    await call(ROOT, "wrap.testnet", "ft_transfer_call", { receiver_id: dex, amount: near(poolNear).toString(), msg: "" }, 1n, 100);
    const usdcIn = BigInt(Math.round(poolNear * nearPrice * 1e6));
    await call(ROOT, ids.usdc!, "ft_transfer_call", { receiver_id: dex, amount: usdcIn.toString(), msg: "" }, 1n, 100);
    await call(ROOT, dex, "add_liquidity", { pool_id: pool, amounts: [near(poolNear).toString(), usdcIn.toString()] }, near(0.01), 100);
    dep.dexPool = pool;
    save();
    console.log(`pool ${pool}: ${poolNear} wNEAR / ${Number(usdcIn) / 1e6} USDC`);
  }

  step("risk board");
  const enclaveKey = arg("enclave-key") ?? dep.enclave?.publicKey;
  const enclaveHash = arg("enclave-wasm-sha256") ?? dep.enclave?.wasmSha256;
  if (!enclaveKey || !enclaveHash) throw new Error("pass --enclave-key and --enclave-wasm-sha256 from the enclave's keys run on OutLayer (scripts/enclave.ts keys)");
  dep.enclave = { ...(dep.enclave ?? {}), publicKey: enclaveKey, wasmSha256: enclaveHash };
  save();
  await deploy("risk", ids.risk!, { method: "new", args: { owner_id: ROOT, enclave_key: enclaveKey, wasm_sha256: enclaveHash, vault: ids.vault } });

  step("vault");
  await deploy("vault", ids.vault!, { method: "new", args: {
    owner_id: ROOT, network: NETWORK, risk: ids.risk, keeper: wallets.keeper, linear: "linear-protocol.testnet", wnear: "wrap.testnet", usdc: ids.usdc, oracle: ids.oracle, signer: "v1.signer-prod.testnet",
    hedge: { asset: "NEAR", asset_index: 54, sz_decimals: 1, hedge_ratio_bps: 9000, max_leverage_x100: 300, band_bps: 200 },
    deposit_cap: near(500).toString(), min_deposit: near(0.5).toString(),
  } });
  const linReg = await viewCall<unknown>("linear-protocol.testnet", "storage_balance_of", { account_id: ids.vault }).catch(() => null);
  if (!linReg) await call(ROOT, "linear-protocol.testnet", "storage_deposit", { account_id: ids.vault, registration_only: true }, near(0.01), 30);

  step("protected-account code (global, by hash) and the factory");
  const acctCode = wasm("account");
  const acctHash = codeHash(acctCode);
  // Publishing burns ten times the storage price (about 36 NEAR for this code): never twice for
  // the same hash, so the recorded deployment is the check.
  if (dep.contracts.account?.codeHash !== acctHash) {
    const o = (await client(ROOT).transaction(ROOT).publishContract(acctCode, { identifiedBy: "hash" }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
    if (failure(o)) throw new Error(`publish: ${failure(o)}`);
    dep.contracts.account = { account: "global", codeHash: acctHash, tx: hashOf(o), commit, source: "contracts/account" };
    save();
    console.log(`published account code ${acctHash} (${hashOf(o)})`);
  }
  const protocol = {
    lending: ids.lending, oracle: ids.oracle, dex: "ref-finance-101.testnet", risk: ids.risk, signer: "v1.signer-prod.testnet", factory: ids.accounts,
    tokens: [
      { token_id: "wrap.testnet", symbol: "wNEAR", decimals: 24, extra_decimals: 0, price_id: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", rate_call: null, mark: "NEAR" },
      { token_id: ids.usdc, symbol: "USDC", decimals: 6, extra_decimals: 12, price_id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", rate_call: null, mark: null },
    ],
  };
  await deploy("accounts", ids.accounts!, { method: "new", args: { owner: ROOT, network: NETWORK, protocol, account_code: acctHash } });
  dep.contracts.factory = dep.contracts.accounts!;
  save();

  console.log(`\nDone. deployments/${NETWORK}.json is up to date.`);
}

await main();
