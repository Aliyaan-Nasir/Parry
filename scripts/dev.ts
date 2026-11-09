/**
 * Runs the API, every service and the app in one terminal.
 *
 *   pnpm dev              against the public testnet deployment (read-only without keys;
 *                         .env.services adds the wallets)
 *   pnpm dev --sandbox    against a local node started by `bun scripts/sandbox.ts`
 *   --no-web              the API and services only
 *
 * Needs Postgres at DATABASE_URL (`docker compose up -d postgres` gives one on port 55432 when
 * POSTGRES_PORT=55432, or use your own).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const sandbox = process.argv.includes("--sandbox");

function loadEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

const env: Record<string, string> = {
  DATABASE_URL: "postgres://parry:parry@localhost:55432/parry",
  RELAYER_URL: "http://localhost:4500",
  ...loadEnv(join(ROOT, ".env")),
  ...loadEnv(join(ROOT, sandbox ? ".env.sandbox" : ".env.services")),
  ...(process.env as Record<string, string>),
};
if (sandbox && !existsSync(join(ROOT, ".env.sandbox"))) {
  console.error("start the sandbox first: bun scripts/sandbox.ts");
  process.exit(1);
}

const procs = [
  { name: "api", cmd: ["bun", "apps/api/src/index.ts"], port: 4000 },
  ...["monitor", "risk", "guardian", "keeper", "relayer", "indexer", "alerts", "topup", "market"].map((s, i) => ({ name: s, cmd: ["bun", "services/src/main.ts", s], port: 4100 + i * 100 })),
  { name: "web", cmd: ["pnpm", "-F", "@parry/web", "dev"], port: 3000 },
].filter((p) => !(process.argv.includes("--no-web") && p.name === "web"));

const colors = [33, 32, 36, 35, 34, 31, 37, 93, 92, 96];
for (const [i, p] of procs.entries()) {
  const child = Bun.spawn(p.cmd, {
    cwd: ROOT,
    env: { ...env, PORT: String(p.port), SERVICE: p.name, NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000", NEXT_PUBLIC_PARRY_NETWORK: env.PARRY_NETWORK ?? "testnet" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const tag = `\x1b[${colors[i % colors.length]}m${p.name.padEnd(8)}\x1b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    (async () => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) console.log(`${tag} ${l}`);
      }
    })();
  }
}
console.log(`api http://localhost:4000, app http://localhost:3000 (${sandbox ? "sandbox" : env.PARRY_NETWORK ?? "testnet"})`);
