/**
 * A local NEAR node with the whole Parry protect stack, for running the services, the API and
 * the app end to end without testnet funds, and for rehearsing flows before they touch testnet.
 *
 *   bun scripts/sandbox.ts        start the node (port 3030), deploy, write deployments/sandbox.json
 *                                 and .env.sandbox, then keep the node running until Ctrl-C
 *
 * It deploys the same code testnet runs: the lending wasm byte for byte from mainnet, the
 * exchange and wNEAR from testnet (contracts/scripts/fetch-fixtures.sh), and Parry's contracts
 * from contracts/scripts/build.sh. A stand-in answers Chain Signatures requests (the real MPC
 * network exists only on testnet and mainnet). Services run with ENCLAVE_MODE=local.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKey, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";

const ROOT_DIR = join(import.meta.dir, "..");
const HOME = join(ROOT_DIR, "contracts", "target", "sandbox-node");
const RPC = "http://127.0.0.1:3030";
const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;
const NEAR_USD = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const USDC_USD = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

function binary(): string {
  const p = Bun.spawnSync(["find", join(ROOT_DIR, "contracts", "target"), "-path", "*near-sandbox-*/near-sandbox", "-type", "f"]);
  const found = p.stdout.toString().trim().split("\n").filter(Boolean)[0];
  if (!found) throw new Error("no near-sandbox binary: run `pnpm test:sandbox` once so near-workspaces downloads it");
  return found;
}

const wasm = (name: string) => new Uint8Array(readFileSync(join(ROOT_DIR, "contracts", "target", "near", name, `${name}.wasm`)));
const fixture = (name: string) => new Uint8Array(readFileSync(join(ROOT_DIR, "contracts", "target", "fixtures", `${name}.wasm`)));
const b58 = (buf: Uint8Array) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(buf).toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
};

const keys = new Map<string, string>();
const client = (id: string) => new Near({ network: { networkId: "localnet", rpcUrl: RPC }, privateKey: keys.get(id) as never, defaultSignerId: id });

function failure(o: FinalExecutionOutcome): string | null {
  for (const s of [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify((s as { Failure: unknown }).Failure).slice(0, 400);
  }
  return null;
}

async function call(from: string, to: string, method: string, args: object, deposit = 0n, tgas = 100) {
  const o = (await client(from).transaction(from).functionCall(to, method, args, { gas: `${tgas} Tgas` as never, attachedDeposit: `${deposit} yocto` as never }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  const f = failure(o);
  if (f) throw new Error(`${to}.${method}: ${f}`);
  return o;
}

async function sub(parent: string, name: string, balance: number, code?: Uint8Array, init?: { method: string; args: object }): Promise<string> {
  const id = `${name}.${parent}`;
  const k = generateKey();
  let tx = client(parent).transaction(parent).createAccount(id).transfer(id, `${near(balance)} yocto` as never).addKey(k.publicKey.toString(), { type: "fullAccess" });
  if (code) tx = tx.deployContract(id, code);
  if (init) tx = tx.functionCall(id, init.method, init.args, { gas: "100 Tgas" as never });
  const o = (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  if (failure(o)) throw new Error(`create ${id}: ${failure(o)}`);
  keys.set(id, k.secretKey);
  return id;
}

const NEAR_USD_ID = NEAR_USD;
const USDC_USD_ID = USDC_USD;
async function sourcePrices(): Promise<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[]> {
  // The prices mainnet Rhea lending uses, read with a free mainnet view call.
  const out = [];
  for (const id of [NEAR_USD_ID, USDC_USD_ID]) {
    const r = (await (await fetch("https://free.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: "aggregate-oracle.near", method_name: "get_price_unsafe", args_base64: Buffer.from(JSON.stringify({ price_identifier: id })).toString("base64") } }) })).json()) as { result: { result: number[] } };
    out.push({ id, price: JSON.parse(Buffer.from(r.result.result).toString()) });
  }
  return out;
}

async function waitForNode() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error("the sandbox node did not start");
}

async function main() {
  const bin = binary();
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  Bun.spawnSync([bin, "--home", HOME, "init"], { stdout: "ignore", stderr: "ignore" });
  const node = Bun.spawn([bin, "--home", HOME, "run"], { stdout: "ignore", stderr: "ignore" });
  process.on("SIGINT", () => {
    node.kill();
    process.exit(0);
  });
  await waitForNode();
  const validator = JSON.parse(readFileSync(join(HOME, "validator_key.json"), "utf8")) as { account_id: string; secret_key: string };
  const root = validator.account_id;
  keys.set(root, validator.secret_key);
  console.log(`sandbox up at ${RPC}, root ${root}`);

  const token = wasm("parry_token");
  const wrap = await sub(root, "wrap", 100, fixture("wrap"), { method: "new", args: {} });
  const usdc = await sub(root, "usdc", 10, token, { method: "new", args: { owner_id: root, name: "USD Coin (Parry test)", symbol: "USDC", decimals: 6, icon: null, faucet_amount: "1000000000", faucet_period_secs: 3600 } });
  const boost = await sub(root, "boost", 10, token, { method: "new", args: { owner_id: root, name: "Booster (Parry test)", symbol: "BOOST", decimals: 18, icon: null, faucet_amount: "1", faucet_period_secs: 86400 } });
  const keeper = await sub(root, "keeper", 50);
  const oracle = await sub(root, "oracle", 10, wasm("parry_oracle"), { method: "new", args: { owner_id: root, feeders: [root, keeper], network: "testnet", max_shock_bps: 4000 } });
  const signer = await sub(root, "signer", 10, wasm("parry_test_mock_signer"));
  const dex = await sub(root, "dex", 50, fixture("dex"), { method: "new", args: { owner_id: root, boost_farm_id: root, burrowland_id: root, exchange_fee: 4, referral_fee: 1 } });
  const enclaveSeed = Buffer.from(createHash("sha256").update("parry-sandbox-enclave").digest()).toString("hex");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const enclaveKey = `ed25519:${b58(ed25519.getPublicKey(Buffer.from(enclaveSeed, "hex")))}`;
  const vaultId = `vault.${root}`;
  const risk = await sub(root, "risk", 20, wasm("parry_risk"), { method: "new", args: { owner_id: root, enclave_key: enclaveKey, wasm_sha256: "00".repeat(32), vault: vaultId } });
  const lending = await sub(root, "lending", 60, fixture("lending"), { method: "new", args: { config: {
    oracle_account_id: oracle, pyth_oracle_account_id: oracle, ref_exchange_id: dex, owner_id: root, booster_token_id: boost, booster_decimals: 18, max_num_assets: 20,
    maximum_recency_duration_sec: 90, maximum_staleness_duration_sec: 90, lp_tokens_info_valid_duration_sec: 600, pyth_price_valid_duration_sec: 120,
    minimum_staking_duration_sec: 2592000, maximum_staking_duration_sec: 7776000, x_booster_multiplier_at_maximum_staking_duration: 30000, force_closing_enabled: true,
    enable_price_oracle: false, enable_pyth_oracle: true, contract_mode: "Running", boost_suppress_factor: 1000, dcl_id: dex, pause_operator_id: null,
  } } });

  // Live prices from the oracle mainnet lending uses, then the lending assets as on testnet.
  const h = await sourcePrices();
  await call(root, oracle, "update_prices", { updates: h.map((p) => ({ price_id: p.id, price: p.price.price, conf: p.price.conf, expo: p.price.expo, publish_time: Math.floor(Date.now() / 1000) })) });
  const nearPrice = Number(h[0]!.price.price) * 10 ** h[0]!.price.expo;
  const asset = (ratio: number, extra: number) => ({ reserve_ratio: 2500, beneficiaries: {}, target_utilization: 8000, target_utilization_rate: "1000000000003593629036885046", max_utilization_rate: "1000000000039724853136740579",
    holding_position_fee_rate: "1000000000000000000000000000", volatility_ratio: ratio, extra_decimals: extra, can_deposit: true, can_withdraw: true, can_use_as_collateral: true, can_borrow: true,
    net_tvl_multiplier: 0, max_change_rate: null, supplied_limit: "1000000000000000000000000000000000", borrowed_limit: "1000000000000000000000000000000000", min_borrowed_amount: "1000000000" });
  await call(root, lending, "add_asset", { token_id: wrap, asset_config: asset(7500, 0) }, 1n);
  await call(root, lending, "add_asset", { token_id: usdc, asset_config: asset(9500, 12) }, 1n);
  const pyth = (d: number, id: string) => ({ decimals: d, fraction_digits: 4, price_identifier: id, extra_call: null, default_price: null });
  await call(root, lending, "add_token_pyth_info", { token_id: wrap, token_pyth_info: pyth(24, NEAR_USD) }, 1n);
  await call(root, lending, "add_token_pyth_info", { token_id: usdc, token_pyth_info: pyth(6, USDC_USD) }, 1n);
  for (const t of [usdc, wrap]) for (const who of [root, lending, dex, keeper]) await call(root, t, "storage_deposit", { account_id: who, registration_only: true }, near(0.01), 30);
  await call(root, usdc, "mint", { account_id: root, amount: "10000000000000" }, 1n, 30);
  await call(root, wrap, "near_deposit", {}, near(1000), 30);
  await call(root, lending, "storage_deposit", { account_id: root }, near(0.25), 30);
  await call(root, usdc, "ft_transfer_call", { receiver_id: lending, amount: "500000000000", msg: "" }, 1n, 150);
  await call(root, dex, "extend_whitelisted_tokens", { tokens: [wrap, usdc] }, 1n, 30);
  await call(root, dex, "storage_deposit", { account_id: root, registration_only: false }, near(1), 30);
  const po = await call(root, dex, "add_simple_pool", { tokens: [wrap, usdc], fee: 25 }, near(0.1), 50);
  const pool = JSON.parse(Buffer.from((po.status as { SuccessValue: string }).SuccessValue, "base64").toString()) as number;
  await call(root, dex, "register_tokens", { token_ids: [wrap, usdc] }, 1n, 30);
  await call(root, wrap, "ft_transfer_call", { receiver_id: dex, amount: near(500).toString(), msg: "" }, 1n, 100);
  const usdcIn = BigInt(Math.round(500 * nearPrice * 1e6));
  await call(root, usdc, "ft_transfer_call", { receiver_id: dex, amount: usdcIn.toString(), msg: "" }, 1n, 100);
  await call(root, dex, "add_liquidity", { pool_id: pool, amounts: [near(500).toString(), usdcIn.toString()] }, near(0.01), 100);

  // Global account code and the factory.
  const code = await sub(root, "code", 80, wasm("parry_test_publisher"));
  const acct = wasm("parry_account");
  await call(code, code, "publish", { code: Buffer.from(acct).toString("base64") }, 0n, 300);
  const acctHash = b58(createHash("sha256").update(acct).digest());
  const factory = `accounts.${root}`;
  const protocol = { lending, oracle, dex, risk, signer, factory, tokens: [
    { token_id: wrap, symbol: "wNEAR", decimals: 24, extra_decimals: 0, price_id: NEAR_USD, rate_call: null, mark: "NEAR" },
    { token_id: usdc, symbol: "USDC", decimals: 6, extra_decimals: 12, price_id: USDC_USD, rate_call: null, mark: null },
  ] };
  await sub(root, "accounts", 20, wasm("parry_accounts"), { method: "new", args: { owner: root, network: "testnet", protocol, account_code: acctHash } });
  const relayer = await sub(root, "relayer", 200);
  const guardian = await sub(root, "guardian", 50);
  const monitor = await sub(root, "monitor", 20);
  const api = await sub(root, "api", 5);
  for (const who of [api, relayer, keeper]) await call(root, usdc, "storage_deposit", { account_id: who, registration_only: true }, near(0.01), 30);
  // The keeper liquidates watched test positions from its own lending supply.
  await call(root, usdc, "ft_transfer", { receiver_id: keeper, amount: "100000000000" }, 1n, 30);
  await call(keeper, lending, "storage_deposit", { account_id: keeper }, near(0.25), 30);
  await call(keeper, usdc, "ft_transfer_call", { receiver_id: lending, amount: "50000000000", msg: "" }, 1n, 150);

  const contracts = { factory, risk, oracle, lending, usdc, wnear: wrap, dex, signer, boost, linear: "", vault: "" };
  mkdirSync(join(ROOT_DIR, "deployments"), { recursive: true });
  writeFileSync(join(ROOT_DIR, "deployments", "sandbox.json"), `${JSON.stringify({ network: "testnet", status: "sandbox", rpc: RPC, contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, { account: v }])), dexPool: pool, enclave: { publicKey: enclaveKey, wasmSha256: "00".repeat(32) } }, null, 2)}\n`);
  // The enclave reads its endpoints at compile time: build a local variant for this node.
  const enclaveBuild = Bun.spawnSync(["cargo", "build", "--release", "--features", "local", "--bin", "parry-enclave-local", "--target-dir", "target/sandbox"], {
    cwd: join(ROOT_DIR, "enclave"),
    env: { ...process.env, PARRY_RPC_URL: RPC, PARRY_RISK: risk, PARRY_VAULT: vaultId, PARRY_LENDING: lending, PARRY_ORACLE: oracle, PARRY_SIGNER: signer, PARRY_USDC: usdc, PARRY_WNEAR: wrap, PARRY_DEX_POOL: String(pool) },
  });
  if (enclaveBuild.exitCode !== 0) throw new Error(`enclave build failed: ${enclaveBuild.stderr.toString().slice(-800)}`);
  const env = [
    "PARRY_NETWORK=testnet",
    `PARRY_DEPLOYMENTS=${join(ROOT_DIR, "deployments", "sandbox.json")}`,
    `NEAR_RPC_URLS=${RPC}`,
    "ENCLAVE_MODE=local",
    `ENCLAVE_LOCAL_BIN=${join(ROOT_DIR, "enclave", "target", "sandbox", "release", "parry-enclave-local")}`,
    `PARRY_LOCAL_ENCLAVE_SEED=${enclaveSeed}`,
    ...Object.entries({ MONITOR: monitor, KEEPER: keeper, GUARDIAN: guardian, RELAYER: relayer, TREASURY: root }).flatMap(([p, id]) => [`${p}_ACCOUNT_ID=${id}`, `${p}_PRIVATE_KEY=${keys.get(id)}`]),
    `X402_PAY_TO=${api}`,
    `SANDBOX_ROOT=${root}`,
    `SANDBOX_ROOT_KEY=${validator.secret_key}`,
  ];
  writeFileSync(join(ROOT_DIR, ".env.sandbox"), `${env.join("\n")}\n`, { mode: 0o600 });
  console.log(`deployed: pool ${pool}, factory ${factory}, enclave ${enclaveKey}\nwrote deployments/sandbox.json and .env.sandbox; Ctrl-C stops the node`);
  await node.exited;
}

if (!existsSync(join(ROOT_DIR, "contracts", "target", "near", "parry_account", "parry_account.wasm"))) {
  console.error("run contracts/scripts/build.sh and contracts/scripts/fetch-fixtures.sh first");
  process.exit(1);
}
await main();
