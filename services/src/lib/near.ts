/**
 * NEAR access for the services: views over plain JSON-RPC with failover across providers, and a
 * Sender that signs with near-kit, either one transaction at a time on a regular key or in
 * parallel on a gas key's nonce lanes (each lane is an independent nonce, so N transactions can
 * be in flight at once without colliding).
 */

import { decodeSignedDelegateAction, Near, parseKey } from "near-kit";
import type { FinalExecutionOutcome, PrivateKey, TransactionBuilder } from "near-kit";
import { network, RPC_URLS } from "./config";

type RpcError = { cause?: { name?: string; info?: unknown }; message?: string; data?: unknown };

export class RpcCallError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

let next = 0;

/** A JSON-RPC call that moves to the next provider on network errors and rate limits. */
export async function rpc<T>(method: string, params: unknown, urls: string[] = RPC_URLS): Promise<T> {
  let last: unknown = null;
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const url = urls[(next + attempt) % urls.length]!;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "parry", method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: RpcError };
      if (body.error) {
        // A contract or argument error is the answer, not a provider fault: do not retry it.
        throw new RpcCallError(body.error.cause?.name ?? body.error.message ?? "rpc error", body.error);
      }
      next = (next + attempt) % urls.length;
      return body.result as T;
    } catch (e) {
      if (e instanceof RpcCallError) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error(`rpc ${method}: ${String((last as Error)?.message ?? last)}`);
}

/** A contract view, parsed as JSON. */
export async function view<T>(account: string, method: string, args: Record<string, unknown> = {}, finality: "final" | "optimistic" = "optimistic"): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality,
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  // A view that panics, or a method the contract lacks, comes back as `error` beside the block.
  if (!r.result) throw new Error(`${account}.${method}: ${r.error ?? "no result"}`);
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

export async function balanceOf(account: string): Promise<bigint | null> {
  try {
    const r = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: account });
    return BigInt(r.amount);
  } catch {
    return null;
  }
}

export const toNear = (yocto: bigint): number => Number(yocto / 10n ** 18n) / 1e6;
export const yocto = (near: number): bigint => BigInt(Math.round(near * 1e6)) * 10n ** 18n;

export interface Call {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown> | Uint8Array;
  /** Gas in Tgas. */
  tgas: number;
  /** yoctoNEAR. */
  deposit?: bigint;
}

export class TxError extends Error {
  constructor(message: string, readonly hash?: string, readonly outcome?: FinalExecutionOutcome) {
    super(message);
  }
}

/** The first failure message in an outcome, or null when every receipt succeeded. */
export function failureOf(o: FinalExecutionOutcome): string | null {
  const statuses = [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)];
  for (const s of statuses) {
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify((s as { Failure: unknown }).Failure).slice(0, 400);
  }
  return null;
}

/** The transaction's final return value, decoded as JSON. */
export function returnValue<T>(o: FinalExecutionOutcome): T | undefined {
  const s = o.status as { SuccessValue?: string } | undefined;
  if (!s || typeof s !== "object" || !s.SuccessValue) return undefined;
  try {
    return JSON.parse(Buffer.from(s.SuccessValue, "base64").toString()) as T;
  } catch {
    return undefined;
  }
}

/** The transaction hash of an outcome. */
export const txHash = (o: FinalExecutionOutcome): string => o.transaction?.hash ?? o.transaction_outcome?.id ?? "";

/** Every log line of every receipt. */
export const logsOf = (o: FinalExecutionOutcome): string[] => (o.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);

/** NEP-297 events in an outcome. */
export function eventsOf(o: FinalExecutionOutcome): { standard: string; event: string; data: unknown }[] {
  return logsOf(o)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export interface SenderOptions {
  accountId: string;
  privateKey: string;
  /** Use a gas key with this many nonce lanes (the key must be a gas key on the account). */
  lanes?: number;
}

const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS ?? 60_000);

export class Sender {
  readonly accountId: string;
  readonly publicKey: string;
  readonly lanes: number;
  private readonly clients: Near[];
  private readonly busy: boolean[];
  private readonly inflight = { count: 0 };
  private readonly waiters: Array<(lane: number) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: SenderOptions) {
    this.accountId = o.accountId;
    this.publicKey = parseKey(o.privateKey).publicKey.toString();
    this.lanes = o.lanes ?? 0;
    this.busy = Array.from({ length: this.lanes }, () => false);
    this.clients = RPC_URLS.map(
      (rpcUrl) =>
        new Near({
          network: { networkId: network, rpcUrl },
          privateKey: o.privateKey as PrivateKey,
          defaultSignerId: o.accountId,
          retryConfig: { maxRetries: 0 },
        }),
    );
  }

  get inFlight(): number {
    return this.inflight.count;
  }

  private async lane(): Promise<number> {
    const free = this.busy.indexOf(false);
    if (free >= 0) {
      this.busy[free] = true;
      return free;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(lane: number) {
    const w = this.waiters.shift();
    if (w) w(lane);
    else this.busy[lane] = false;
  }

  /** Builds, signs and sends one transaction; throws TxError when any receipt failed. */
  async send(build: (tx: TransactionBuilder) => TransactionBuilder): Promise<FinalExecutionOutcome> {
    const run = async (lane: number | null): Promise<FinalExecutionOutcome> => {
      this.inflight.count++;
      try {
        let last: unknown = null;
        // Every provider is tried in turn; when all of them rate-limit, wait and go round again.
        for (const [round, client] of [0, 1, 2].flatMap((r) => this.clients.map((c) => [r, c] as const))) {
          if (round > 0 && client === this.clients[0]) await new Promise((r) => setTimeout(r, 1500 * 2 ** round));
          let tx = build(client.transaction(this.accountId));
          if (lane !== null) tx = tx.useGasKey(lane);
          let hash: string | undefined;
          try {
            await tx.sign();
            hash = tx.getHash() ?? undefined;
            // A provider that never answers would hold this task forever: give up on it after a
            // minute, look the hash up, and move on to the next provider.
            const o = (await Promise.race([
              tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("send timed out after 60 s")), SEND_TIMEOUT_MS)),
            ])) as FinalExecutionOutcome;
            const failed = failureOf(o);
            if (failed) throw new TxError(failed, o.transaction?.hash ?? hash, o);
            return o;
          } catch (e) {
            if (e instanceof TxError) throw e;
            // A transaction the RPC rejected (not enough balance, a bad nonce, an invalid action)
            // never landed: say so at once rather than looking for it.
            if ((e as { code?: string }).code === "INVALID_TRANSACTION" || /InvalidTx|NotEnoughBalance|LackBalance|InvalidNonce|InvalidAccessKey/i.test(String((e as Error)?.message ?? e))) {
              throw new TxError(String((e as Error)?.message ?? e), hash);
            }
            last = e;
            // Signed bytes may have landed even when the response did not: look the hash up.
            if (hash) {
              const landed = await this.lookup(hash);
              if (landed) {
                const failed = failureOf(landed);
                if (failed) throw new TxError(failed, hash, landed);
                return landed;
              }
            }
            // Only a provider's fault (rate limit, network, server error) is worth another provider.
            if (!/429|too many|timed? ?out|timeout|fetch failed|ECONN|socket|network|HTTP 5\d\d/i.test(String((e as Error)?.message ?? e))) {
              throw new TxError(String((e as Error)?.message ?? e), hash);
            }
          }
        }
        throw new TxError(`could not send: ${String((last as Error)?.message ?? last)}`);
      } finally {
        this.inflight.count--;
      }
    };
    if (this.lanes > 0) {
      const lane = await this.lane();
      try {
        return await run(lane);
      } finally {
        this.release(lane);
      }
    }
    const p = this.queue.then(() => run(null));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async lookup(hash: string): Promise<FinalExecutionOutcome | null> {
    for (let i = 0; i < 3; i++) {
      try {
        return await rpc<FinalExecutionOutcome>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: this.accountId, wait_until: "EXECUTED_OPTIMISTIC" });
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return null;
  }

  call(c: Call): Promise<FinalExecutionOutcome> {
    return this.send((tx) =>
      tx.functionCall(c.receiverId, c.methodName, c.args as object, {
        gas: `${c.tgas} Tgas` as never,
        attachedDeposit: `${c.deposit ?? 0n} yocto` as never,
      }),
    );
  }

  transfer(receiverId: string, amount: bigint): Promise<FinalExecutionOutcome> {
    return this.send((tx) => tx.transfer(receiverId, `${amount} yocto` as never));
  }

  /** The gas key's prepaid balance in yoctoNEAR, or null when this sender has no gas key. */
  async gasKeyBalance(): Promise<bigint | null> {
    if (!this.lanes) return null;
    const k = await rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: this.accountId, public_key: this.publicKey });
    const b = balanceIn(k.permission);
    return b === null ? null : BigInt(b);
  }

  /**
   * Moves NEAR from the account into its own gas key once the key falls under `minNear`, back up
   * to `targetNear` (a full-access gas key may fund itself). The top-up service keeps the account
   * itself funded from the treasury.
   */
  async refillGasKey(minNear: number, targetNear: number): Promise<string> {
    const b = await this.gasKeyBalance();
    if (b === null) return "no gas key";
    if (toNear(b) >= minNear) return `gas key ${toNear(b).toFixed(2)} NEAR`;
    const add = yocto(targetNear) - b;
    await this.send((tx) => tx.transferToGasKey(this.publicKey, `${add} yocto` as never));
    return `gas key refilled with ${toNear(add).toFixed(2)} NEAR`;
  }

  /** Relays a NEP-366 signed delegate action (base64 borsh) as this account. */
  relayDelegate(payloadBase64: string): Promise<FinalExecutionOutcome> {
    const signed = decodeSignedDelegateAction(payloadBase64);
    return this.send((tx) => {
      (tx as unknown as { receiverId?: string }).receiverId = signed.signedDelegate.delegateAction.senderId;
      return tx.signedDelegateAction(signed);
    });
  }

  get client(): Near {
    return this.clients[0]!;
  }
}

/** A sender from `<PREFIX>_ACCOUNT_ID`, `<PREFIX>_PRIVATE_KEY` and optional `<PREFIX>_LANES`. */
export function senderFromEnv(prefix: string): Sender | null {
  const accountId = process.env[`${prefix}_ACCOUNT_ID`];
  const privateKey = process.env[`${prefix}_PRIVATE_KEY`];
  if (!accountId || !privateKey) return null;
  return new Sender({ accountId, privateKey, lanes: Number(process.env[`${prefix}_LANES`] ?? 0) });
}

/** The first `balance` anywhere in an access key's permission (a gas key carries its prepaid balance). */
function balanceIn(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if (k === "balance" && (typeof x === "string" || typeof x === "number")) return String(x);
    const inner = balanceIn(x);
    if (inner) return inner;
  }
  return null;
}

/**
 * Keeps a service's gas key funded and records its balance for the status page. Each gas-key
 * service (monitor, keeper, relayer) runs this every 10 minutes.
 */
export async function tendGasKey(sql: import("./db").Sql, name: string, sender: Sender | null): Promise<void> {
  if (!sender?.lanes) return;
  const min = Number(process.env.GAS_KEY_MIN_NEAR ?? 0.5);
  const target = Number(process.env.GAS_KEY_TARGET_NEAR ?? 1.5);
  const detail = await sender.refillGasKey(min, target);
  const b = await sender.gasKeyBalance();
  await sql`INSERT INTO wallets (name, account, balance, target, checked_at) VALUES (${`${name} gas key`}, ${sender.accountId}, ${b === null ? 0 : toNear(b)}, ${target}, now())
    ON CONFLICT (name) DO UPDATE SET balance = excluded.balance, target = excluded.target, checked_at = now()`;
  if (detail.includes("refilled")) console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", service: name, msg: detail }));
}

/** The gas key's nonce lanes, for the status page. */
export async function gasKeyNonces(accountId: string, publicKey: string): Promise<number | null> {
  try {
    const r = await rpc<{ nonces?: unknown[] }>("EXPERIMENTAL_view_gas_key_nonces", { finality: "optimistic", account_id: accountId, public_key: publicKey });
    return Array.isArray(r.nonces) ? r.nonces.length : null;
  } catch {
    return null;
  }
}
