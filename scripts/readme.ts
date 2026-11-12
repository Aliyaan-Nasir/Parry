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
 * JUDGES.md's <!-- scenarios:start --> block lists each scenario of the test matrix with its
 * result on testnet and its first transactions. It also points every [`symbol`](path#Lnn) link in README.md, JUDGES.md, AGENTS.md and
 * SECURITY.md at the line that defines the symbol.
 *
 *   bun scripts/readme.ts          rewrite what is out of date
 *   bun scripts/readme.ts --check  exit 1 when anything is out of date
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
  keys?: { gasKeys?: Record<string, { account: string; lanes: number; tx?: string }>; postQuantum?: { account: string; scheme: string; tx?: string; signedTx?: string } };
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
    ["boost", "Test booster token (the token code; Rhea lending's config names one)"],
  ];
  const rows = order
    .filter(([k]) => dep.contracts[k])
    .map(([k, what]) => {
      const c = dep.contracts[k]!;
      const where = c.account === "global" ? "global code" : acct(c.account);
      const verified = c.verified ? `matched by \`near contract verify\` (${c.verified})` : k === "lending" ? "mainnet's code hash" : "";
      return `| ${what} | ${where} | \`${c.codeHash ?? ""}\` | ${tx(c.tx)} | ${verified} |`;
    });
  return ["| Contract | Account | Code hash | Deployed in | Reproducible build |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/** The first recorded transaction of a scenario whose step matches `pattern`. */
function step(n: number, pattern: RegExp, label?: string): string {
  const s = proofs.scenarios[String(n)];
  const hit = s?.steps.find((x) => pattern.test(x.step ?? "") && (x.tx || x.action || x.near));
  const url = hit?.tx ?? hit?.action ?? hit?.near ?? null;
  return url ? link(url, label) : "";
}

function proofRows(): [string, string, string, string][] {
  return [
    ["NEP-655 universal accounts and global contracts", "every protected account is derived from one published code hash and created by the relayer", "[`accounts/src/lib.rs`](contracts/accounts/src/lib.rs)", step(2, /relayer creates/)],
    ["Chain Signatures", "a protected account signs its Hyperliquid orders and its Aave repay, and the vault its hedge, each for its own derived address", "[`hyperliquid.rs`](contracts/common/src/hyperliquid.rs), [`evm.rs`](contracts/common/src/evm.rs)", [step(8, /signs a Hyperliquid order/, "account's Hyperliquid order"), step(10, /order's signing/, "vault hedge"), step(9, /^evm_repay:/, "Aave repay")].filter(Boolean).join(", ")],
    ["MPC foreign-transaction verification", "the MPC network confirms the Aave repay landed on Base Sepolia", "[`services/src/lib/evm.ts`](services/src/lib/evm.ts)", step(9, /verify_foreign_transaction/) || "waits for Base Sepolia ETH (scenario 9)"],
    ["OutLayer TEE", "the guardian runs with keys bound to its build", "[`enclave/`](enclave)", dep.enclave?.keysRun ? link(`${NEARBLOCKS}/txns/${dep.enclave.keysRun}`, "keys run") : ""],
    ["NEAR AI Cloud verifiable models", "every rescue is reviewed, and the review's TEE signature is checked before acting", "[`enclave/src/ai.rs`](enclave/src/ai.rs)", step(6, /repay:/, "AI-reviewed rescue") || "waits for the NEAR AI Cloud key (scenario 6)"],
    ["Rhea lending and exchange", "positions, repays and the atomic deleverage, on lending's exact mainnet code", "[`guardian.rs`](contracts/account/src/guardian.rs)", [step(3, /supply/, "supply"), step(3, /borrow/, "borrow"), step(6, /repay:/, "guardian repay"), step(6, /delev:/, "deleverage")].filter(Boolean).join(", ")],
    ["x402 on NEAR", "paid risk checks settled with a signed delegate `ft_transfer`", "[`apps/api/src/x402.ts`](apps/api/src/x402.ts)", step(12, /pays per call/)],
    ["Gas keys (NEP-611)", "each service signs on a prepaid gas key with parallel nonce lanes, and refills it itself", "[`near.ts`](services/src/lib/near.ts)", Object.entries(dep.keys?.gasKeys ?? {}).map(([svc, k]) => (k.tx ? link(`${NEARBLOCKS}/txns/${k.tx}`, `${svc}, ${k.lanes} lanes`) : "")).filter(Boolean).join(", ")],
    ["Post-quantum keys (ML-DSA-65)", "the treasury, which holds the most NEAR, signs with an ML-DSA-65 key", "[`deploy.ts`](scripts/deploy.ts), [`topup.ts`](services/src/topup.ts)", [dep.keys?.postQuantum?.tx ? link(`${NEARBLOCKS}/txns/${dep.keys.postQuantum.tx}`, "key added") : "", dep.keys?.postQuantum?.signedTx ? link(`${NEARBLOCKS}/txns/${dep.keys.postQuantum.signedTx}`, "a top-up it signed") : ""].filter(Boolean).join(", ")],
  ];
}

function proofsTable(): string {
  const rows = proofRows();
  return [
    "| Primitive | What Parry does with it | Code | On testnet |",
    "| --- | --- | --- | --- |",
    ...rows.map(([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${d || "waits for its scenario in `bun scripts/scenarios.ts`"} |`),
  ].join("\n");
}

function links(): string {
  if (!dep.site || !dep.api) return "Run it with `docker compose up` or `pnpm dev` (below); the hosted app's address is added here when it is live.";
  return `**Live on testnet:** [app](${dep.site}/app) · [API](${dep.api}/v1/status) · MCP at \`${dep.api}/mcp\` · [llms.txt](${dep.site}/llms.txt)`;
}

function fill(text: string, name: string, body: string): string {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`no ${name} block to fill`);
  return text.replace(re, `$1\n${body}\n$2`);
}

/** The line a symbol is defined on: a Rust item or a TypeScript declaration, else a method. */
function definitionLine(file: string, symbol: string): number | null {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^\\s*(pub(\\([^)]*\\))?\\s+)?(async\\s+)?(fn|struct|enum|const|trait|type|mod)\\s+${s}\\b`),
    new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function|class|const|let|interface|type|enum)\\s+${s}\\b`),
    new RegExp(`^\\s*(async\\s+)?${s}\\s*[(<]`),
  ];
  for (const re of patterns) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i + 1;
  }
  return null;
}

/**
 * Points every [`symbol`](path#Lnn) link in a Markdown file at the line that defines the symbol
 * (the part after the last `::` for a path such as `seal::open`), so anchors follow the code.
 */
function anchors(text: string, name: string): string {
  return text.replace(/\[`([^`]+)`\]\(([^)#\s]+)#L(\d+)\)/g, (whole, label: string, file: string, line: string) => {
    if (!existsSync(join(ROOT, file))) throw new Error(`${name}: ${file} does not exist`);
    const at = definitionLine(file, label.split("::").pop()!);
    if (at === null) throw new Error(`${name}: ${label} is not defined in ${file}`);
    return at === Number(line) ? whole : `[\`${label}\`](${file}#L${at})`;
  });
}

/** Each scenario of the test matrix, and what it says while it has no passing record. */
const SCENARIOS: [number, string, string][] = [
  [1, "Sign in with a NEAR wallet and with a passkey", ""],
  [2, "A protected account without gas", ""],
  [3, "A leveraged Rhea position", ""],
  [4, "A mandate with a sealed policy", ""],
  [5, "The market shock moves the price", ""],
  [6, "Alert, AI review, rescue and recovery", "waits for the NEAR AI Cloud key"],
  [7, "Limits: replays, forged envelopes, withdrawals and expiry are refused", ""],
  [8, "A Hyperliquid order signed by the protected account through Chain Signatures", ""],
  [9, "An Aave loan on Base Sepolia rescued through Chain Signatures and verified by the MPC network", "waits for Base Sepolia ETH at the account's derived address"],
  [10, "Vault deposit, hedge, withdrawal through the queue, proof of reserves", ""],
  [11, "The vault pauses deposits from its risk score", ""],
  [12, "A paid risk check over x402 on NEAR", ""],
  [13, "Core flows through the SDK and the MCP server", ""],
  [14, "Closing a Rhea position in rounds by selling collateral", ""],
  [15, "Closing a Rhea position from the wallet", ""],
  [16, "Unwinding a protected account", ""],
  [17, "A health certificate: issued by the enclave, anchored on the risk board, verified", ""],
  [18, "An insurance inflow into the vault's fund", ""],
];

function scenariosTable(): string {
  const rows = SCENARIOS.map(([n, title, needs]) => {
    const s = proofs.scenarios[String(n)];
    const txs = (s?.steps ?? []).map((x) => x.tx ?? x.action ?? null).filter((x): x is string => typeof x === "string" && x.startsWith("http")).slice(0, 3);
    const result = s?.ok ? "passes" : needs || (s ? "fails" : "not run yet");
    return `| ${n} | ${s?.title ?? title} | ${result} | ${txs.map((u, i) => link(u, `tx ${i + 1}`)).join(", ")} |`;
  });
  return ["| # | Scenario | On testnet | Transactions |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/**
 * The same proofs as data for the site's "Only on NEAR" grid (apps/web/lib/proofs.generated.json):
 * each primitive with its testnet transaction links, parsed out of the Markdown links above.
 */
function proofsJson(): string {
  const parse = (md: string) => [...md.matchAll(/\[([^\]]+)\]\((https:[^)]+)\)/g)].map((m) => ({ label: m[1]!, url: m[2]! }));
  const items = proofRows().map(([name, what, , links]) => ({ name, what: what.replace(/`/g, ""), links: parse(links) }));
  return `${JSON.stringify({ network: "testnet", items }, null, 2)}\n`;
}

const check = process.argv.includes("--check");
const outputs: [string, string, string][] = [];
const readmeBefore = readFileSync(README, "utf8");
outputs.push([README, readmeBefore, anchors(fill(fill(fill(readmeBefore, "contracts", contracts()), "proofs", proofsTable()), "links", links()), "README.md")]);
const proofsPath = join(ROOT, "apps", "web", "lib", "proofs.generated.json");
outputs.push([proofsPath, existsSync(proofsPath) ? readFileSync(proofsPath, "utf8") : "", proofsJson()]);
for (const doc of ["JUDGES.md", "AGENTS.md", "SECURITY.md"]) {
  const f = join(ROOT, doc);
  const text = readFileSync(f, "utf8");
  outputs.push([f, text, anchors(doc === "JUDGES.md" ? fill(text, "scenarios", scenariosTable()) : text, doc)]);
}
const stale = outputs.filter(([, before, after]) => before !== after).map(([f]) => f.replace(`${ROOT}/`, ""));
if (check) {
  if (stale.length) {
    console.error(`out of date: ${stale.join(", ")}; run bun scripts/readme.ts`);
    process.exit(1);
  }
  console.log("README.md and the line anchors are current");
} else {
  for (const [f, before, after] of outputs) if (before !== after) writeFileSync(f, after);
  console.log(stale.length ? `updated ${stale.join(", ")}` : "README.md and the line anchors are current");
}
