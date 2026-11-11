/**
 * Runs the guardian enclave program. On testnet and mainnet: an OutLayer `request_execution`
 * pinned to the build's sha256, signed by the guardian service's wallet, so the enclave's keys
 * (bound to that build) sign the output and OutLayer attests the run. For the local sandbox:
 * the same program built natively (`parry-enclave-local`), with a development key that no
 * deployed mandate names.
 */

import { contract, enclaveInfo } from "./config";
import { returnValue, Sender, view } from "./near";

export type EnclaveMode = "keys" | "risk_update" | "guardian" | "vault_report" | "certificate";

/**
 * The modes the deployed enclave build serves: `ENCLAVE_MODES` (comma separated), else the
 * deployment record's `enclave.modes`, else the four every build has.
 */
export function enclaveModes(): EnclaveMode[] {
  const fromEnv = process.env.ENCLAVE_MODES?.split(",").map((m) => m.trim()).filter(Boolean);
  const recorded = (enclaveInfo() as { modes?: string[] } | null)?.modes;
  return (fromEnv ?? recorded ?? ["keys", "risk_update", "guardian", "vault_report"]) as EnclaveMode[];
}

export interface EnclaveRun<T> {
  output: T;
  /** The OutLayer request transaction (null for local runs). */
  tx: string | null;
}

/**
 * OutLayer derives the enclave's keys from the build and the account that calls for the run, so
 * every service calls from the same account (`ENCLAVE_ACCOUNT_ID`), each with its own full-access
 * key (`ENCLAVE_KEY_<SERVICE>`) so their nonces never collide.
 */
let enclaveSender: Sender | null = null;
function caller(): Sender {
  if (enclaveSender) return enclaveSender;
  const accountId = process.env.ENCLAVE_ACCOUNT_ID;
  const privateKey = process.env[`ENCLAVE_KEY_${(process.env.SERVICE ?? "").toUpperCase()}`] ?? process.env.ENCLAVE_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error("ENCLAVE_ACCOUNT_ID and this service's ENCLAVE_KEY_<SERVICE> must be set");
  enclaveSender = new Sender({ accountId, privateKey });
  return enclaveSender;
}

/** Runs a mode; `fields` replace the account list for modes with their own input (certificate). */
export async function runEnclave<T>(mode: EnclaveMode, accounts: string[] = [], fields?: Record<string, unknown>): Promise<EnclaveRun<T>> {
  const input = JSON.stringify(fields ? { mode, ...fields } : { mode, accounts });
  if ((process.env.ENCLAVE_MODE ?? "outlayer") === "local") return runLocal<T>(input);
  const sender = caller();
  const info = enclaveInfo();
  const url = process.env.ENCLAVE_WASM_URL ?? info?.wasmUrl;
  const hash = process.env.ENCLAVE_WASM_SHA256 ?? info?.wasmSha256;
  if (!url || !hash) throw new Error("ENCLAVE_WASM_URL and ENCLAVE_WASM_SHA256 must name the enclave build");
  const outlayer = contract("outlayer");
  const limits = { max_instructions: 50_000_000_000, max_memory_mb: 256, max_execution_seconds: Number(process.env.ENCLAVE_MAX_SECONDS ?? 90) };
  const deposit = await view<string>(outlayer, "estimate_execution_cost", { resource_limits: limits });
  const secretsProfile = process.env.ENCLAVE_SECRETS_PROFILE;
  const o = await sender.call({
    receiverId: outlayer,
    methodName: "request_execution",
    args: {
      source: { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } },
      resource_limits: limits,
      input_data: input,
      secrets_ref: secretsProfile ? { profile: secretsProfile, account_id: sender.accountId } : null,
      response_format: "Json",
      payer_account_id: null,
      params: null,
    },
    deposit: BigInt(deposit),
    tgas: 300,
  });
  const value = returnValue<T & { error?: string }>(o);
  const tx = o.transaction?.hash ?? null;
  if (!value) {
    const failure = (o.receipts_outcome ?? []).flatMap((r) => r.outcome.logs).find((l) => /fail|error/i.test(l));
    throw new Error(`the enclave returned nothing (${tx}): ${failure ?? "no output"}`);
  }
  if (value.error) throw new Error(`enclave: ${value.error}`);
  return { output: value, tx };
}

async function runLocal<T>(input: string): Promise<EnclaveRun<T>> {
  const bin = process.env.ENCLAVE_LOCAL_BIN ?? "enclave/target/release/parry-enclave-local";
  const proc = Bun.spawn([bin], { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", env: process.env });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`local enclave exited ${code}: ${(await new Response(proc.stderr).text()).slice(0, 300)}`);
  const value = JSON.parse(out) as T & { error?: string };
  if (value.error) throw new Error(`enclave: ${value.error}`);
  return { output: value, tx: null };
}
