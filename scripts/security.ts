/**
 * Runs Parry's security checks and prints pass or fail for each:
 *
 *   contracts  cargo clippy (all targets, warnings are errors), cargo audit, cargo deny check
 *   enclave    cargo clippy with the `local` feature (warnings are errors)
 *   packages   pnpm audit --prod
 *
 *   pnpm security            every step
 *   pnpm security --verbose  also print each step's full output
 *
 * cargo-audit and cargo-deny are installed with `cargo install --locked` when missing. Accepted
 * advisories live in contracts/deny.toml and contracts/.cargo/audit.toml, each with its reason,
 * and are listed in SECURITY.md. Exits 1 when any step fails.
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONTRACTS = join(ROOT, "contracts");
const ENCLAVE = join(ROOT, "enclave");
const verbose = process.argv.includes("--verbose");

type Step = { name: string; cwd: string; cmd: string[]; needs?: string };

const steps: Step[] = [
  {
    name: "contracts: clippy",
    cwd: CONTRACTS,
    cmd: ["cargo", "clippy", "--workspace", "--all-targets", "--target-dir", "target/clippy", "--", "-D", "warnings"],
  },
  { name: "contracts: cargo audit", cwd: CONTRACTS, cmd: ["cargo", "audit"], needs: "cargo-audit" },
  { name: "contracts: cargo deny", cwd: CONTRACTS, cmd: ["cargo", "deny", "check"], needs: "cargo-deny" },
  {
    name: "enclave: clippy",
    cwd: ENCLAVE,
    cmd: ["cargo", "clippy", "--all-targets", "--features", "local", "--", "-D", "warnings"],
  },
  { name: "packages: pnpm audit", cwd: ROOT, cmd: ["pnpm", "audit", "--prod"] },
];

async function run(cmd: string[], cwd: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output: `${out}${err}` };
}

/** Installs a cargo subcommand when `cargo <name> --version` does not run. */
async function ensure(tool: string): Promise<boolean> {
  const sub = tool.replace(/^cargo-/, "");
  if ((await run(["cargo", sub, "--version"], ROOT)).code === 0) return true;
  console.log(`installing ${tool} (cargo install ${tool} --locked)...`);
  const installed = await run(["cargo", "install", tool, "--locked"], ROOT);
  if (installed.code !== 0) console.log(installed.output.trim().split("\n").slice(-20).join("\n"));
  return installed.code === 0;
}

/** The last lines of a step's output, which hold the summary or the first error. */
function tail(output: string, lines = 25): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

const results: { name: string; ok: boolean; secs: number }[] = [];
for (const step of steps) {
  const started = performance.now();
  let ok = step.needs ? await ensure(step.needs) : true;
  let output = ok ? "" : `${step.needs} is not installed and could not be installed`;
  if (ok) {
    const r = await run(step.cmd, step.cwd);
    ok = r.code === 0;
    output = r.output;
  }
  const secs = Math.round((performance.now() - started) / 100) / 10;
  results.push({ name: step.name, ok, secs });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step.name}  (${secs} s)`);
  if (verbose || !ok) console.log(`${tail(output, verbose ? 10_000 : 25).replace(/^/gm, "      ")}\n`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nsecurity: all ${results.length} steps passed`
    : `\nsecurity: ${failed.length} of ${results.length} steps failed: ${failed.map((r) => r.name).join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
