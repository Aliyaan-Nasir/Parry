/**
 * Fills the README's generated blocks from what is actually deployed and recorded, so the links
 * there are never typed by hand:
 *
 *   <!-- contracts:start --> ... <!-- contracts:end -->   deployments/testnet.json: every contract
 *                                                          with its NearBlocks link, code hash, deploy
 *                                                          transaction and verification
 *   <!-- proofs:start --> ... <!-- proofs:end -->         deployments/testnet-proofs.json: one testnet
 *                                                          transaction per NEAR primitive
 *   <!-- links:start --> ... <!-- links:end -->           the hosted app, API and MCP endpoint
 *                                                          (deployments/testnet.json `site` and `api`)
 *
 *   bun scripts/readme.ts          rewrite README.md
 *   bun scripts/readme.ts --check  exit 1 when README.md is out of date
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const README = join(ROOT, "README.md");
const NEARBLOCKS = "https://testnet.nearblocks.io";
const dep = JSON.parse(readFileSync(join(ROOT, "deployments", "testnet.json"), "utf8")) as {
  root: string;
  contracts: Record<string, { account: string; codeHash?: string; tx?: string; commit?: string; source?: string; verified?: string }>;
  enclave?: { publicKey?: string; wasmSha256?: string; keysRun?: string };
  site?: string;
  api?: string;
  services?: Record<string, string>;
};
const proofsFile = join(ROOT, "deployments", "testnet-proofs.json");
const proofs = (existsSync(proofsFile) ? JSON.parse(readFileSync(proofsFile, "utf8")) : { scenarios: {} }) as {
  scenarios: Record<string, { title: string; ok: boolean; steps: { step?: string; tx?: string | null; action?: string | null; near?: string; base?: string }[] }>;
};

const tx = (hash?: string | null) => (hash ? `[${hash.slice(0, 8)}...](${NEARBLOCKS}/txns/${hash})` : "");
const acct = (id: string) => `[\`${id}\`](${NEARBLOCKS}/address/${id})`;
const link = (url?: string | null, label = "transaction") => (url ? `[${label}](${url})` : "");

function contracts(): string {
  const order: [string, string][] = [
    ["factory", "Factory for protected accounts (NEP-655 universal accounts)"],
    ["account", "Protected-account code, published by hash (global contract)"],
    ["risk", "Risk board: enclave-signed scores, marks, decisions and the sealing key"],
    ["vault", "Delta-neutral vault, `EARN` shares"],
    ["oracle", "Pyth-interface price oracle with the testnet market shock"],
    ["lending", "Rhea lending, mainnet's exact wasm"],
    ["usdc", "Test USDC with a faucet"],
  ];
  const rows = order
    .filter(([k]) => dep.contracts[k])
    .map(([k, what]) => {
      const c = dep.contracts[k]!;
      const where = c.account === "global" ? "global code" : acct(c.account);
      const verified = c.verified ? `[matched](${c.verified.startsWith("http") ? c.verified : `${NEARBLOCKS}/txns/${c.verified}`})` : k === "lending" ? "mainnet's code hash" : "";
      return `| ${what} | ${where} | \`${c.codeHash ?? ""}\` | ${tx(c.tx)} | ${verified} |`;
    });
  return ["| Contract | Account | Code hash | Deployed in | Reproducible build |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/** The first recorded transaction of a scenario whose step matches `pattern`. */
function step(n: number, pattern: RegExp): string {
  const s = proofs.scenarios[String(n)];
  const hit = s?.steps.find((x) => pattern.test(x.step ?? "") && (x.tx || x.action || x.near));
  const url = hit?.tx ?? hit?.action ?? hit?.near ?? null;
  return url ? link(url) : "";
}

function proofsTable(): string {
  const rows: [string, string, string, string][] = [
    ["NEP-655 universal accounts and global contracts", "every protected account is derived from one published code hash and created by the relayer", "[`accounts/src/lib.rs`](contracts/accounts/src/lib.rs)", step(2, /relayer creates/)],
    ["Chain Signatures", "the vault signs its Hyperliquid hedge, and an account signs its Aave repay, for their own derived addresses", "[`hyperliquid.rs`](contracts/common/src/hyperliquid.rs), [`evm.rs`](contracts/common/src/evm.rs)", [step(10, /order's signing/), step(9, /evm_repay/)].filter(Boolean).join(", ")],
    ["MPC foreign-transaction verification", "the MPC network confirms the Aave repay landed on Base Sepolia", "[`services/src/lib/evm.ts`](services/src/lib/evm.ts)", step(9, /verify_foreign_transaction/)],
    ["OutLayer TEE", "the guardian runs with keys bound to its build", "[`enclave/`](enclave)", dep.enclave?.keysRun ? link(`${NEARBLOCKS}/txns/${dep.enclave.keysRun}`, "keys run") : ""],
    ["NEAR AI Cloud verifiable models", "every rescue is reviewed, and the review's TEE signature is checked before acting", "[`enclave/src/ai.rs`](enclave/src/ai.rs)", step(6, /repay:/)],
    ["Rhea lending and exchange", "repays and the atomic deleverage, on lending's exact mainnet code", "[`guardian.rs`](contracts/account/src/guardian.rs)", step(6, /delev:/)],
    ["x402 on NEAR", "paid risk checks settled with a signed delegate `ft_transfer`", "[`apps/api/src/x402.ts`](apps/api/src/x402.ts)", step(12, /pays per call/)],
  ];
  return [
    "| Primitive | What Parry does with it | Code | On testnet |",
    "| --- | --- | --- | --- |",
    ...rows.map(([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${d || "recorded by `bun scripts/scenarios.ts`"} |`),
  ].join("\n");
}

function links(): string {
  if (!dep.site || !dep.api) return "Run it with `docker compose up` or `pnpm dev` (below); the hosted app's address is added here when it is live.";
  return `**Live on testnet:** [app](${dep.site}/app) · [API](${dep.api}/v1/status) · MCP at \`${dep.api}/mcp\` · [llms.txt](${dep.site}/llms.txt)`;
}

function fill(text: string, name: string, body: string): string {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`README.md has no ${name} block`);
  return text.replace(re, `$1\n${body}\n$2`);
}

const before = readFileSync(README, "utf8");
const after = fill(fill(fill(before, "contracts", contracts()), "proofs", proofsTable()), "links", links());
if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error("README.md is out of date: run bun scripts/readme.ts");
    process.exit(1);
  }
  console.log("README.md is current");
} else if (after !== before) {
  writeFileSync(README, after);
  console.log("README.md updated");
} else console.log("README.md is current");
