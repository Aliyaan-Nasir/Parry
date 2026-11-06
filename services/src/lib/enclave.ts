/**
 * Runs the guardian enclave program. On testnet and mainnet: an OutLayer `request_execution`
 * pinned to the build's sha256, signed by the guardian service's wallet, so the enclave's keys
 * (bound to that build) sign the output and OutLayer attests the run. For the local sandbox:
 * the same program built natively (`parry-enclave-local`), with a development key that no
 * deployed mandate names.
 */

import { contract, enclaveInfo } from "./config";
import { returnValue, type Sender, view } from "./near";

export type EnclaveMode = "keys" | "risk_update" | "guardian" | "vault_report";

export interface EnclaveRun<T> {
  output: T;
  /** The OutLayer request transaction (null for local runs). */
  tx: string | null;
}

export async function runEnclave<T>(sender: Sender | null, mode: EnclaveMode, accounts: string[] = []): Promise<EnclaveRun<T>> {
  const input = JSON.stringify({ mode, accounts });
  if ((process.env.ENCLAVE_MODE ?? "outlayer") === "local") return runLocal<T>(input);
  if (!sender) throw new Error("the guardian wallet is not configured");
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
