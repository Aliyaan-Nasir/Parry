/**
 * Puts the guardian enclave on OutLayer and prints what the deploy needs.
 *
 *   bun scripts/enclave.ts publish   build (enclave/build.sh), upload the wasm to FastFS, store the
 *                                    NEAR AI key as a secret readable only by the enclave account
 *   bun scripts/enclave.ts keys      run the `keys` mode through OutLayer: the enclave's ed25519 key
 *                                    and X25519 sealing key, and a signed sealing-key report
 *
 * Needs `outlayer login testnet` with the enclave account's key, ENCLAVE_ACCOUNT_ID and one
 * ENCLAVE_KEY_* in the environment (from .env.services), and NEARAI_API_KEY for `publish`.
 * Results go to deployments/testnet.json under `enclave`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const depFile = join(ROOT, "deployments", "testnet.json");
const dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : { contracts: {} };
const save = () => writeFileSync(depFile, `${JSON.stringify(dep, null, 2)}\n`);

function sh(cmd: string[], opts: { cwd?: string; input?: string } = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? ROOT, stdin: opts.input ? new TextEncoder().encode(opts.input) : undefined, env: process.env });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out}`);
  return out;
}

async function publish() {
  const built = sh(["./build.sh"], { cwd: join(ROOT, "enclave") });
  const hash = built.match(/^([0-9a-f]{64})\s+target/m)?.[1];
  if (!hash) throw new Error(`no sha256 in the build output:\n${built}`);
  const wasm = join(ROOT, "enclave", "target", "wasm32-wasip2", "release", "parry-enclave.wasm");
  const uploaded = sh(["outlayer", "upload", wasm]);
  const url = uploaded.match(/https:\/\/\S+\.wasm/)?.[0];
  if (!url) throw new Error(`no FastFS URL in:\n${uploaded}`);
  const key = process.env.NEARAI_API_KEY;
  if (!key) throw new Error("NEARAI_API_KEY is not set");
  const caller = process.env.ENCLAVE_ACCOUNT_ID ?? "enclave.parry.testnet";
  sh(["outlayer", "secrets", "set", JSON.stringify({ NEARAI_API_KEY: key }), "--profile", "parry", "--wasm-hash", hash, "--access", `whitelist:${caller}`]);
  dep.enclave = { ...(dep.enclave ?? {}), wasmSha256: hash, wasmUrl: url, secretsProfile: "parry", secretsOwner: process.env.OUTLAYER_ACCOUNT ?? caller };
  save();
  console.log(`enclave ${hash}\n  ${url}`);
}

async function keys() {
  const { runEnclave } = await import("../services/src/lib/enclave");
  process.env.SERVICE ??= "guardian";
  process.env.ENCLAVE_WASM_URL ??= dep.enclave?.wasmUrl;
  process.env.ENCLAVE_WASM_SHA256 ??= dep.enclave?.wasmSha256;
  process.env.ENCLAVE_SECRETS_PROFILE ??= dep.enclave?.secretsProfile;
  const run = await runEnclave<{ public_key: string; sealing_public_key: string; report_json: string; signature: string }>("keys");
  dep.enclave = { ...dep.enclave, publicKey: run.output.public_key, sealingPublicKey: run.output.sealing_public_key, keysRun: run.tx, sealingReport: run.output.report_json, sealingSignature: run.output.signature };
  save();
  console.log(`enclave key ${run.output.public_key}\nsealing key ${run.output.sealing_public_key}\nOutLayer run ${run.tx}`);
}

const cmd = process.argv[2];
if (cmd === "publish") await publish();
else if (cmd === "keys") await keys();
else {
  console.error("usage: bun scripts/enclave.ts publish|keys");
  process.exit(2);
}
