/**
 * Drives the local sandbox stack like a person would: a NEAR account gets a gasless protected
 * account through the relayer, opens a leveraged Rhea position, sets a mandate naming the
 * enclave's key, then the market shock crashes NEAR and the services must react (scores,
 * alerts, the guardian queue, the guardian's run). Run after `bun scripts/sandbox.ts` and
 * `pnpm dev --sandbox --no-web`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKey, Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";

const ROOT = join(import.meta.dir, "..");
const env = Object.fromEntries(readFileSync(join(ROOT, ".env.sandbox"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const dep = JSON.parse(readFileSync(join(ROOT, "deployments", "sandbox.json"), "utf8"));
const c = (n: string) => dep.contracts[n].account as string;
const API = "http://localhost:4000";
const RPC = "http://127.0.0.1:3030";
const NEAR = 10n ** 24n;
const root = env.SANDBOX_ROOT!;
const near = (id: string, key: string) => new Near({ network: { networkId: "localnet", rpcUrl: RPC }, privateKey: key as never, defaultSignerId: id });

async function call(n: Near, from: string, to: string, method: string, args: object, deposit = 0n, tgas = 300) {
  const o = (await n.transaction(from).functionCall(to, method, args, { gas: `${tgas} Tgas` as never, attachedDeposit: `${deposit} yocto` as never }).send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  const fail = [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)].find((s) => s && typeof s === "object" && "Failure" in s);
  if (fail) throw new Error(`${to}.${method}: ${JSON.stringify(fail).slice(0, 300)}`);
  return o;
}
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json" } });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body as T;
};

const rootNear = near(root, env.SANDBOX_ROOT_KEY!);
const k = generateKey();
const alice = `alice${Date.now() % 100000}.${root}`;
await rootNear.transaction(root).createAccount(alice).transfer(alice, `${300n * NEAR} yocto` as never).addKey(k.publicKey.toString(), { type: "fullAccess" }).send();
const a = near(alice, k.secretKey);
console.log(`owner ${alice}`);

const created = await api<{ accountId: string; txHash: string }>("/v1/relay/create-account", { method: "POST", body: JSON.stringify({ nearAccount: alice }) });
const acct = created.accountId;
console.log(`protected account ${acct} (${created.txHash})`);

await a.transaction(alice).transfer(acct, `${120n * NEAR} yocto` as never).send();
const owner = (actions: unknown[]) => call(a, alice, acct, "owner_call", { actions }, 1n, 300);
await owner([
  { call: { receiver_id: c("wnear"), method_name: "near_deposit", args: "e30=", deposit: (110n * NEAR).toString(), gas: "20000000000000" } },
  { supply: { token: c("wnear"), amount: (100n * NEAR).toString() } },
]);
const price = await api<{ price: { price: string; expo: number } }>("/v1/shock").then((s) => Number(s.price.price) * 10 ** s.price.expo);
// Borrow to a health of about 1.30 at today's price.
const borrow = Math.floor((100 * price * 0.75 * 0.95) / 1.3);
await owner([{ borrow: { token: c("usdc"), amount: String(borrow * 1_000_000) } }]);
await call(rootNear, root, c("usdc"), "ft_transfer", { receiver_id: acct, amount: String(40 * 1_000_000) }, 1n, 30);
await owner([{ set_mandate: { mandate: {
  guardian_key: dep.enclave.publicKey,
  powers: ["repay", "add_collateral", "deleverage"],
  limits: [{ token: c("usdc"), reserve: "100000000", daily: "60000000" }, { token: c("wnear"), reserve: (20n * NEAR).toString(), daily: (40n * NEAR).toString() }],
  max_actions_per_day: 10, min_health_after_bps: 10500, max_slippage_bps: 300, hl: null, evm: null, sealed: null,
  expires_at: Math.floor(Date.now() / 1000) + 7 * 86400,
} } }]);
console.log(`position: 100 NEAR collateral at $${price.toFixed(3)}, ${borrow} USDC debt, 40 USDC reserve, mandate set`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(25_000);
const before = await api<{ positions: { health: number; score: number; tier: string }[] }>(`/v1/accounts/${acct}`);
console.log("before the shock:", before.positions.map((p) => `health ${p.health?.toFixed(3)} score ${p.score} ${p.tier}`));

const shocked = await api<{ txHash: string; shock: unknown }>("/v1/shock", { method: "POST", body: JSON.stringify({ bps: -2000 }) });
console.log("market shock -20%:", shocked.txHash);
await wait(30_000);
const after = await api<{ positions: { health: number; score: number; tier: string; ttlHours: number | null }[] }>(`/v1/accounts/${acct}`);
console.log("after the shock:", after.positions.map((p) => `health ${p.health?.toFixed(3)} score ${p.score} ${p.tier} ttl ${p.ttlHours?.toFixed(1)}h`));
const alerts = await api<{ title: string }[]>(`/v1/alerts?account=${acct}`);
console.log("alerts:", alerts.map((x) => x.title));
await wait(30_000);
const log = await api<{ items: { action: string; outcome: string; plan: string; review: { verdict: string } }[] }>(`/v1/guardian/decisions?account=${acct}`);
console.log("guardian decisions:", log.items.map((d) => `${d.action} ${d.outcome} (${d.review.verdict}): ${d.plan}`));
console.log(`account ${acct}`);
