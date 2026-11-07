/** Test doubles for the Parry API and for NEAR RPC (near-kit calls the global fetch). */

import { fromBase64, fromUtf8, utf8 } from "../src/encoding.js";

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (req: Seen) => Response | Promise<Response> | undefined;

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

/** A fetch that answers from `routes` (first match wins) and records every request. */
export function mockFetch(...routes: Route[]) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text
    }
    const req = { url, method: init?.method ?? "GET", headers, body };
    seen.push(req);
    for (const r of routes) {
      const res = await r(req);
      if (res) return res;
    }
    return new Response(`no route for ${req.method} ${url}`, { status: 599 });
  };
  return { fetch, seen };
}

export const RPC_URL = "https://rpc.test.invalid";

type RpcBody = { id: number; method: string; params: Record<string, unknown> | unknown[] };

/** A NEAR RPC answering contract views from `views` (by `contract.method`), access keys and status. */
export function rpcRoute(opts: {
  views?: Record<string, (args: Record<string, unknown>) => unknown>;
  accessKeyNonce?: number;
  blockHeight?: number;
}): Route {
  return (req) => {
    if (!req.url.startsWith(RPC_URL)) return undefined;
    const { id, method, params } = req.body as RpcBody;
    const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });
    const height = opts.blockHeight ?? 1_000;
    if (method === "status") {
      return ok({
        version: { version: "2.9.0", build: "test" },
        chain_id: "testnet",
        genesis_hash: "11111111111111111111111111111111",
        protocol_version: 80,
        latest_protocol_version: 80,
        rpc_addr: "0.0.0.0:3030",
        node_public_key: "ed25519:11111111111111111111111111111111",
        node_key: null,
        validator_account_id: null,
        validator_public_key: null,
        validators: [],
        sync_info: {
          latest_block_hash: "11111111111111111111111111111111",
          latest_block_height: height,
          latest_state_root: "11111111111111111111111111111111",
          latest_block_time: "2026-11-10T00:00:00Z",
          syncing: false,
        },
      });
    }
    const p = params as Record<string, unknown>;
    if (method === "query" && p["request_type"] === "view_access_key") {
      return ok({ nonce: opts.accessKeyNonce ?? 41, permission: "FullAccess", block_height: height, block_hash: "11111111111111111111111111111111" });
    }
    if (method === "query" && p["request_type"] === "call_function") {
      const key = `${String(p["account_id"])}.${String(p["method_name"])}`;
      const handler = opts.views?.[key];
      if (!handler) return json({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN" }, code: -32000, message: `no view ${key}` } });
      const args = JSON.parse(fromUtf8(fromBase64(String(p["args_base64"])))) as Record<string, unknown>;
      return ok({ result: [...utf8(JSON.stringify(handler(args)))], logs: [], block_height: height, block_hash: "11111111111111111111111111111111" });
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected ${method}` } });
  };
}

/** Installs `fetch` as the global fetch; returns the function that restores the original. */
export function installGlobalFetch(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fetch as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
