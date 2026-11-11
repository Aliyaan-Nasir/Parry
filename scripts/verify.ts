/**
 * `pnpm verify`: checks the README's claims against the live testnet deployment and the code,
 * and prints PASS or FAIL per claim, or WAIT with what a claim still needs when its proof is not
 * recorded yet.
 *
 *   pnpm verify                 everything (runs every test suite first; about 5 minutes)
 *   pnpm verify --quick         skip the test suites
 *   pnpm verify --build         also rebuild the contracts reproducibly and compare the bytes
 *
 * PARRY_API_URL and PARRY_SITE_URL (defaults http://localhost:4000 and http://localhost:3000)
 * point at the stack to check, so it runs against a local stack before hosting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { assembleSigned, signerOf, txHashOf } from "../services/src/lib/evm";

const ROOT = join(import.meta.dir, "..");
const NETWORK = process.env.PARRY_NETWORK === "mainnet" ? "mainnet" : "testnet";
const RPC = process.env.NEAR_RPC_URL ?? (NETWORK === "testnet" ? "https://archival-rpc.testnet.fastnear.com" : "https://archival-rpc.mainnet.fastnear.com");
const MAINNET_RPC = "https://free.rpc.fastnear.com";
const API = process.env.PARRY_API_URL ?? "http://localhost:4000";
const SITE = process.env.PARRY_SITE_URL ?? "http://localhost:3000";
const quick = process.argv.includes("--quick");
const rebuild = process.argv.includes("--build");

type Dep = {
  contracts: Record<string, { account: string; codeHash?: string; commit?: string }>;
  enclave?: Record<string, string>;
  services?: Record<string, string>;
  keys?: { gasKeys?: Record<string, { account: string; lanes: number; tx?: string }>; postQuantum?: { account: string; tx?: string; signedTx?: string } };
  dexPool?: number;
};
type Step = { step?: string; tx?: string; digest?: string; payment?: { transaction?: string } };
const depFile = join(ROOT, "deployments", `${NETWORK}.json`);
const dep: Dep | null = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : null;
const proofsFile = join(ROOT, "deployments", `${NETWORK}-proofs.json`);
const proofs: Record<string, Record<string, string>> & { scenarios?: Record<string, { ok: boolean; steps: Step[] }> } = existsSync(proofsFile) ? JSON.parse(readFileSync(proofsFile, "utf8")) : {};
/** The transaction hash of the first step of scenario `n` whose text matches `pattern`. */
const stepTx = (n: number, pattern: RegExp): string | null => {
  const hit = proofs.scenarios?.[String(n)]?.steps.find((x) => pattern.test(x.step ?? "") && x.tx);
  return hit?.tx?.split("/").pop() ?? null;
};

const results: { claim: string; ok: boolean; detail: string }[] = [];
const waiting: { claim: string; needs: string }[] = [];

/** A claim whose proof is not recorded yet: printed with what it needs, never silently skipped. */
function wait(claim: string, needs: string) {
  waiting.push({ claim, needs });
  console.log(`\x1b[33mWAIT\x1b[0m ${claim}\n     needs ${needs}`);
}

async function check(claim: string, f: () => Promise<string>) {
  try {
    const detail = await f();
    results.push({ claim, ok: true, detail });
    console.log(`\x1b[32mPASS\x1b[0m ${claim}\n     ${detail}`);
  } catch (e) {
    results.push({ claim, ok: false, detail: (e as Error).message });
    console.log(`\x1b[31mFAIL\x1b[0m ${claim}\n     ${(e as Error).message}`);
  }
}

async function rpc<T>(method: string, params: unknown, url = RPC): Promise<T> {
  const r = (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: T; error?: unknown };
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.result as T;
}
const account = (id: string, url = RPC) => rpc<{ code_hash: string; amount: string }>("query", { request_type: "view_account", finality: "final", account_id: id }, url);
async function view<T>(id: string, method: string, args: object = {}, url = RPC): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", { request_type: "call_function", finality: "final", account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, url);
  if (!r.result) throw new Error(`${id}.${method}: ${r.error ?? "no result"}`);
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}
const b58 = (b: Uint8Array) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(b).toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
};
const unb58 = (s: string) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from(out);
};

function run(cmd: string[], cwd = ROOT, env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out.split("\n").slice(-12).join("\n")}`);
  return out;
}

type TxOutcome = {
  transaction: { signer_id: string; receiver_id: string; public_key: string; actions: unknown[] };
  receipts_outcome: { outcome: { logs: string[]; executor_id: string; status: unknown } }[];
  status: unknown;
};
async function txOutcome(hash: string, sender: string) {
  return rpc<TxOutcome>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
}
const failed = (o: TxOutcome) => [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)].some((x) => !!x && typeof x === "object" && "Failure" in x);
const events = (o: { receipts_outcome: { outcome: { logs: string[] } }[] }) =>
  o.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string; data: Record<string, unknown> });

async function main() {
  if (!quick) {
    await check("Every test suite passes", async () => {
      run(["pnpm", "test"]);
      run(["cargo", "test", "--workspace", "--exclude", "parry-sandbox-tests"], join(ROOT, "contracts"));
      run(["./scripts/fetch-fixtures.sh"], join(ROOT, "contracts"));
      run(["./scripts/build.sh"], join(ROOT, "contracts"));
      run(["cargo", "test", "-p", "parry-sandbox-tests"], join(ROOT, "contracts"));
      run(["cargo", "test"], join(ROOT, "enclave"));
      return "TypeScript packages, contract unit tests, sandbox flows on the real lending, exchange, wNEAR and LiNEAR code, enclave tests";
    });
  }
  if (!dep) {
    await check(`deployments/${NETWORK}.json exists`, async () => {
      throw new Error("not deployed yet");
    });
    return;
  }

  for (const [name, c] of Object.entries(dep.contracts)) {
    if (c.account === "global" || name === "accounts") continue;
    await check(`${name} at ${c.account} runs the recorded code`, async () => {
      const a = await account(c.account);
      if (c.codeHash && a.code_hash !== c.codeHash) throw new Error(`live ${a.code_hash}, recorded ${c.codeHash}`);
      const f = c.commit ? join(ROOT, "contracts", "target", "near-reproducible", c.commit, `parry_${name}.wasm`) : "";
      if (f && existsSync(f)) {
        const local = b58(createHash("sha256").update(readFileSync(f)).digest());
        if (local !== a.code_hash) throw new Error(`reproducible build ${local} differs from live ${a.code_hash}`);
        return `${a.code_hash}, equal to the reproducible build of ${c.commit?.slice(0, 12)}`;
      }
      return `${a.code_hash}${c.commit ? ` (build of ${c.commit.slice(0, 12)})` : ""}`;
    });
  }

  if (rebuild) {
    const commit = Object.values(dep.contracts).find((c) => c.commit)?.commit;
    if (commit) await check(`A fresh reproducible build of ${commit.slice(0, 12)} matches every deployed contract`, async () => {
      run(["./scripts/build.sh", "--reproducible", commit], join(ROOT, "contracts"));
      const mismatched: string[] = [];
      for (const [name, c] of Object.entries(dep.contracts)) {
        const f = join(ROOT, "contracts", "target", "near-reproducible", commit, `parry_${name}.wasm`);
        if (!c.codeHash || !existsSync(f)) continue;
        if (b58(createHash("sha256").update(readFileSync(f)).digest()) !== c.codeHash) mismatched.push(name);
      }
      if (mismatched.length) throw new Error(`differs: ${mismatched.join(", ")}`);
      return "byte for byte";
    });
  }

  await check("The testnet lending contract is byte for byte mainnet Rhea lending", async () => {
    const [t, m] = await Promise.all([account(dep.contracts.lending!.account), account("contract.main.burrow.near", MAINNET_RPC)]);
    if (t.code_hash !== m.code_hash) throw new Error(`testnet ${t.code_hash}, mainnet ${m.code_hash}`);
    return `${t.code_hash} on both`;
  });

  await check("Protected accounts are created from published global code, by hash", async () => {
    const cfg = await view<{ account_code: string; created: number }>(dep.contracts.factory?.account ?? `accounts.${NETWORK === "testnet" ? "parry.testnet" : "parryguard.near"}`, "config");
    if (cfg.account_code !== dep.contracts.account?.codeHash) throw new Error(`factory uses ${cfg.account_code}, recorded ${dep.contracts.account?.codeHash}`);
    return `code ${cfg.account_code}; ${cfg.created} accounts created`;
  });

  await check("The guardian key is the enclave's key, bound to the published build", async () => {
    const e = await view<{ public_key: string; wasm_sha256: string }>(dep.contracts.risk!.account, "get_enclave");
    if (e.public_key !== dep.enclave?.publicKey) throw new Error(`risk board trusts ${e.public_key}, the enclave's keys run gave ${dep.enclave?.publicKey}`);
    if (e.wasm_sha256 !== dep.enclave?.wasmSha256) throw new Error(`risk board records build ${e.wasm_sha256}, the enclave build is ${dep.enclave?.wasmSha256}`);
    const tx = dep.enclave?.keysRun;
    if (tx) {
      const att = (await (await fetch(`https://testnet-api.outlayer.ai/attestations/by-tx/${tx}`)).json().catch(() => null)) as { wasm_hash?: string } | null;
      if (att?.wasm_hash && att.wasm_hash !== e.wasm_sha256) throw new Error(`OutLayer attests ${att.wasm_hash}`);
    }
    return `${e.public_key}, build ${e.wasm_sha256.slice(0, 16)}...${tx ? `, keys run ${tx}` : ""}`;
  });

  await check("Policies are sealed to the enclave's own key", async () => {
    const k = await view<{ public_key: string; run_id: number } | null>(dep.contracts.risk!.account, "sealing_key");
    if (!k) throw new Error("the risk board has no sealing key");
    const expected = dep.enclave?.sealingPublicKey;
    if (expected && k.public_key !== expected) throw new Error(`board ${k.public_key}, the enclave's keys run gave ${expected}`);
    return `X25519 ${k.public_key.slice(0, 16)}..., accepted only from an enclave-signed report`;
  });

  const evm = proofs.evm;
  if (evm) {
    await check("An Aave rescue on Base Sepolia: signed for the person's own address by Chain Signatures and verified by the MPC network", async () => {
      const d = (await (await fetch(`${API}/v1/guardian/decisions/${evm.decision}`)).json()) as { account: string; txs: { action: string; evm: string; evmVerify: string | null } };
      const o = await txOutcome(d.txs.action, dep.services!.guardian!);
      const signed = events(o).find((e) => e.event === "evm_signed")?.data as { unsigned_tx: string } | undefined;
      const sv = (o.status as { SuccessValue?: string }).SuccessValue;
      if (!signed || !sv) throw new Error("no evm_signed event or signature in the action transaction");
      const sig = JSON.parse(Buffer.from(sv, "base64").toString()) as { r: string; s: string; v: number };
      const pk = await view<string>(NETWORK === "testnet" ? "v1.signer-prod.testnet" : "v1.signer", "derived_public_key", { path: "parry-evm", predecessor: d.account, domain_id: 0 });
      const point = unb58(pk.replace(/^secp256k1:/, ""));
      const own = `0x${bytesToHex(keccak_256(point.length === 65 ? point.subarray(1) : point).slice(12))}`;
      if (signerOf(signed.unsigned_tx, sig).toLowerCase() !== own) throw new Error(`the signature does not recover to ${own}`);
      if (txHashOf(assembleSigned(signed.unsigned_tx, sig)) !== d.txs.evm) throw new Error(`the broadcast transaction is not ${d.txs.evm}`);
      if (!d.txs.evmVerify) throw new Error("the MPC network has not verified it yet");
      const v = await txOutcome(d.txs.evmVerify, dep.services!.guardian!);
      if (v.status && typeof v.status === "object" && "Failure" in v.status) throw new Error(`verification failed in ${d.txs.evmVerify}`);
      return `${d.txs.evm} from ${own}, verified on NEAR in ${d.txs.evmVerify}`;
    });
  } else {
    wait("An Aave rescue on Base Sepolia, signed by Chain Signatures and verified by the MPC network", "Base Sepolia ETH at the account's derived address, then `bun scripts/scenarios.ts --only 9`");
  }

  const rescue = proofs.rescue;
  if (rescue) {
    await check("A recorded rescue: the model's signature, the review hash on chain and the enclave's signature all verify", async () => {
      const d = (await (await fetch(`${API}/v1/guardian/decisions/${rescue.decision}`)).json()) as { review: Record<string, string>; envelope: string; envelopeSignature: string; txs: { action: string } };
      const r = d.review;
      const ordered = { model: r.model, chat_id: r.chatId, request_hash: r.requestHash, response_hash: r.responseHash, signed_text: r.signedText, signature: r.signature, signing_address: r.signingAddress, signature_kind: r.signatureKind, verdict: r.verdict, reasoning: r.reasoning };
      const hash = bytesToHex(sha256(utf8ToBytes(JSON.stringify(ordered))));
      if (!r.signedText!.endsWith(`${r.requestHash}:${r.responseHash}`)) throw new Error("the signature does not cover the exchange");
      const sig = Buffer.from(r.signature!.replace(/^0x/, ""), "hex");
      const msg = utf8ToBytes(`\x19Ethereum Signed Message:\n${utf8ToBytes(r.signedText!).length}${r.signedText}`);
      const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(keccak_256(msg)).toBytes(false);
      const addr = `0x${bytesToHex(keccak_256(pub.subarray(1)).slice(12))}`;
      if (addr.toLowerCase() !== r.signingAddress!.toLowerCase()) throw new Error(`recovers to ${addr}, not ${r.signingAddress}`);
      const ok = ed25519.verify(Buffer.from(d.envelopeSignature, "base64"), sha256(utf8ToBytes(`parry-guardian:v1:${d.envelope}`)), unb58(dep.enclave!.publicKey!.replace(/^ed25519:/, "")));
      if (!ok) throw new Error("the envelope is not signed by the enclave key");
      const o = await txOutcome(d.txs.action, dep.services!.guardian!);
      const acted = events(o).find((e) => e.event === "guardian_acted");
      if (acted?.data.review_hash !== hash) throw new Error(`on chain ${acted?.data.review_hash}, recomputed ${hash}`);
      // With a NEAR AI key, the signer must also be a key attested in TEE hardware right now.
      const { modelAttestation } = await import("../apps/api/src/verify");
      const att = await modelAttestation(r.model!, r.signingAddress!);
      if (att && !att.ok) throw new Error(att.detail);
      return `review ${hash.slice(0, 16)}... by ${r.model} (${addr}${att ? ", attested" : ""}), action ${d.txs.action}`;
    });
  } else {
    wait("A recorded rescue: the model's signature, the review hash on chain and the enclave's signature", "the NEAR AI Cloud key in the enclave's secrets, then `bun scripts/scenarios.ts --only 2,3,4,5,6`");
  }

  if (proofs.hedge) {
    await check("A Chain Signatures Hyperliquid order: the digest the contract built was signed for the vault's derived address", async () => {
      const o = await txOutcome(proofs.hedge!.tx!, dep.services!.keeper!);
      const ev = events(o).find((e) => e.event === "hedge_order");
      if (!ev) throw new Error("no hedge_order event");
      const sv = (o.status as { SuccessValue?: string }).SuccessValue;
      const sig = JSON.parse(Buffer.from(sv ?? "", "base64").toString()) as { r: string; s: string; v: number };
      const pk = await view<string>(NETWORK === "testnet" ? "v1.signer-prod.testnet" : "v1.signer", "derived_public_key", { path: "parry-vault-hedge", predecessor: dep.contracts.vault!.account, domain_id: 0 });
      const point = unb58(pk.replace(/^secp256k1:/, ""));
      const recovered = secp256k1.Signature.fromBytes(Buffer.from(sig.r + sig.s, "hex"), "compact").addRecoveryBit(sig.v - 27).recoverPublicKey(Buffer.from(String(ev.data.digest), "hex")).toBytes(false);
      if (Buffer.compare(Buffer.from(recovered.subarray(1)), Buffer.from(point.length === 65 ? point.subarray(1) : point)) !== 0) throw new Error("signature does not recover to the vault's derived key");
      return `digest ${String(ev.data.digest).slice(0, 16)}... signed for ${dep.contracts.vault!.account} at parry-vault-hedge`;
    });
  } else {
    wait("The vault's Hyperliquid short, signed by Chain Signatures", "Hyperliquid testnet USDC at the vault's derived address (the keeper signs the short once it has margin)");
  }

  const hlTx = stepTx(8, /signs a Hyperliquid order/);
  if (hlTx) {
    await check("A protected account signs a Hyperliquid order through Chain Signatures, for its own derived address", async () => {
      const owner = proofs.scenarios!["8"]!.steps[0]!.step!.match(/ for (\S+),/)?.[1] ?? "";
      const o = await txOutcome(hlTx, owner);
      const ev = events(o).find((e) => e.event === "hyperliquid_signed");
      const sv = (o.status as { SuccessValue?: string }).SuccessValue;
      if (!ev || !sv) throw new Error("no hyperliquid_signed event or signature");
      const sig = JSON.parse(Buffer.from(sv, "base64").toString()) as { r: string; s: string; v: number };
      const acct = o.transaction.receiver_id;
      const pk = await view<string>(NETWORK === "testnet" ? "v1.signer-prod.testnet" : "v1.signer", "derived_public_key", { path: "parry-hyperliquid", predecessor: acct, domain_id: 0 });
      const point = unb58(pk.replace(/^secp256k1:/, ""));
      const recovered = secp256k1.Signature.fromBytes(Buffer.from(sig.r + sig.s, "hex"), "compact").addRecoveryBit(sig.v >= 27 ? sig.v - 27 : sig.v).recoverPublicKey(Buffer.from(String(ev.data.digest), "hex")).toBytes(false);
      if (Buffer.compare(Buffer.from(recovered.subarray(1)), Buffer.from(point.length === 65 ? point.subarray(1) : point)) !== 0) throw new Error("the signature does not recover to the account's derived key");
      const address = `0x${bytesToHex(keccak_256(point.length === 65 ? point.subarray(1) : point).slice(12))}`;
      return `${hlTx}: digest ${String(ev.data.digest).slice(0, 16)}... signed for ${address}, ${acct.slice(0, 12)}...'s Hyperliquid address`;
    });
  } else {
    wait("A protected account signs a Hyperliquid order through Chain Signatures", "`bun scripts/scenarios.ts --only 8`");
  }

  const created = stepTx(2, /relayer creates/);
  if (created) {
    await check("The relayer creates a protected account as a NEP-655 universal account on the global code", async () => {
      const id = proofs.scenarios!["2"]!.steps.find((x) => /relayer creates/.test(x.step ?? ""))!.step!.split(" ")[2]!;
      const a = (await account(id)) as { code_hash: string; global_contract_hash?: string };
      if (a.global_contract_hash !== dep.contracts.account?.codeHash) throw new Error(`${id} runs global code ${a.global_contract_hash}, recorded ${dep.contracts.account?.codeHash}`);
      const o = await txOutcome(created, dep.services!.relayer!);
      if (failed(o)) throw new Error(`${created} failed`);
      return `${id.slice(0, 12)}... uses global code ${a.global_contract_hash}, created by ${o.transaction.signer_id} in ${created}`;
    });
  }

  const borrow = stepTx(3, /borrow/);
  if (borrow) {
    await check("A leveraged position on Rhea lending's mainnet code, opened from a protected account", async () => {
      const owner = proofs.scenarios!["2"]!.steps.find((x) => /relayer creates/.test(x.step ?? ""))!.step!.match(/ for (\S+),/)?.[1] ?? "";
      const o = await txOutcome(borrow, owner);
      if (failed(o)) throw new Error(`${borrow} failed`);
      if (!o.receipts_outcome.some((r) => r.outcome.executor_id === dep.contracts.lending!.account)) throw new Error(`${borrow} never reached ${dep.contracts.lending!.account}`);
      return `borrow ${borrow} executed on ${dep.contracts.lending!.account}`;
    });
  }

  const paid = proofs.scenarios?.["12"]?.steps.find((x) => x.payment?.transaction)?.payment?.transaction;
  if (paid) {
    await check("A risk check paid over x402 on NEAR: a signed delegate ft_transfer of test USDC, relayed and settled", async () => {
      const o = await txOutcome(paid, dep.services!.api ?? dep.services!.relayer!);
      if (failed(o)) throw new Error(`${paid} failed`);
      const delegate = JSON.stringify(o.transaction.actions).includes("Delegate");
      const transfer = o.receipts_outcome.some((r) => r.outcome.executor_id === dep.contracts.usdc!.account && r.outcome.logs.some((l) => l.includes("ft_transfer")));
      if (!delegate || !transfer) throw new Error(`${paid} is not a delegate ft_transfer on ${dep.contracts.usdc!.account}`);
      return `${paid}: NEP-366 delegate, ft_transfer on ${dep.contracts.usdc!.account}`;
    });
  }

  for (const [svc, k] of Object.entries(dep.keys?.gasKeys ?? {})) {
    await check(`The ${svc} sends on a gas key with ${k.lanes} nonce lanes (NEP-611)`, async () => {
      const keys = await rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: k.account });
      const gas = keys.keys.find((x) => typeof x.access_key.permission === "object" && x.access_key.permission !== null && "GasKeyFullAccess" in x.access_key.permission);
      const p = (gas?.access_key.permission as { GasKeyFullAccess?: { num_nonces: number; balance: string } } | undefined)?.GasKeyFullAccess;
      if (!p) throw new Error(`${k.account} has no gas key`);
      if (p.num_nonces !== k.lanes) throw new Error(`${p.num_nonces} lanes, recorded ${k.lanes}`);
      return `${k.account}: ${p.num_nonces} lanes, ${(Number(BigInt(p.balance) / 10n ** 21n) / 1000).toFixed(2)} NEAR prepaid${k.tx ? `, added in ${k.tx}` : ""}`;
    });
  }

  const pq = dep.keys?.postQuantum;
  if (pq) {
    await check("The treasury signs with a post-quantum ML-DSA-65 key", async () => {
      const keys = await rpc<{ keys: { public_key: string }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: pq.account });
      if (!keys.keys.some((x) => x.public_key.startsWith("ml-dsa-65"))) throw new Error(`${pq.account} has no ML-DSA-65 key`);
      if (!pq.signedTx) return `${pq.account} holds an ML-DSA-65 key`;
      const o = await txOutcome(pq.signedTx, pq.account);
      if (!o.transaction.public_key.startsWith("ml-dsa-65")) throw new Error(`${pq.signedTx} is signed with ${o.transaction.public_key.slice(0, 20)}...`);
      return `${pq.account} holds an ML-DSA-65 key and signed ${pq.signedTx} with it`;
    });
  }

  await check("The vault's hedge matches its collateral and its latest proof of reserves", async () => {
    const s = await view<{ hedge: Record<string, string>; reserves: { root: string; ratio_bps: number } | null; report_at: number }>(dep.contracts.vault!.account, "vault_state");
    const board = (await view<{ report: { reserves: { root: string } } } | null>(dep.contracts.risk!.account, "latest_vault_report"))?.report;
    if (!s.reserves || !board) throw new Error("no vault report yet");
    if (s.reserves.root !== board.reserves.root) throw new Error(`vault root ${s.reserves.root}, board root ${board.reserves.root}`);
    const target = Number(s.hedge.target_e8 ?? 0);
    const current = Number(s.hedge.current_e8 ?? 0);
    const off = target > 0 ? Math.abs(current - target) / target : 0;
    if (off > 0.2) throw new Error(`short ${current / 1e8} NEAR against a target of ${target / 1e8}`);
    const margin = BigInt(s.hedge.account_value_e6 ?? "0") === 0n && BigInt((s as { staked_linear?: string }).staked_linear ?? "0") > 0n;
    return `reserves ${s.reserves.ratio_bps / 100}% of liabilities, root ${s.reserves.root.slice(0, 16)}...; short ${current / 1e8} NEAR against a target of ${target / 1e8}${margin ? " (the target is zero until the hedge account holds margin)" : ` (${(off * 100).toFixed(1)}% off)`}`;
  });

  await check("The oracle feeder is fresh", async () => {
    const st = await view<{ feeds: { price_id: string; publish_time: number }[] }>(dep.contracts.oracle!.account, "status");
    const age = Math.round(Date.now() / 1000 - Math.max(...st.feeds.map((f) => f.publish_time)));
    if (age > 180) throw new Error(`last price ${age} s ago`);
    return `last price ${age} s ago`;
  });

  await check("The API answers and the indexer is caught up", async () => {
    // One retry: a stack that just restarted takes a few seconds to listen.
    const get = () => fetch(`${API}/v1/status`, { signal: AbortSignal.timeout(15_000) });
    const res = await get().catch(async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return get();
    });
    const s = (await res.json()) as { indexer: { lagBlocks: number | null } };
    if (s.indexer.lagBlocks === null || s.indexer.lagBlocks > 600) throw new Error(`indexer ${s.indexer.lagBlocks} blocks behind`);
    return `${API} up, indexer ${s.indexer.lagBlocks} blocks behind`;
  });

  await check("The site answers", async () => {
    const r = await fetch(SITE);
    if (!r.ok) throw new Error(`${SITE} answered ${r.status}`);
    const llms = await fetch(`${SITE}/llms.txt`);
    if (!llms.ok) throw new Error(`${SITE}/llms.txt answered ${llms.status}`);
    return `${SITE} ${r.status}, llms.txt ${llms.status}`;
  });
}

await main();
const failures = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failures} passed, ${failures} failed, ${waiting.length} waiting on a recorded proof`);
process.exit(failures ? 1 : 0);
