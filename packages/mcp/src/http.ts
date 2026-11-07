/**
 * The MCP server over Streamable HTTP, stateless: each POST gets a fresh server and transport
 * and a JSON answer. It takes a Fetch API `Request` and returns a `Response`, so it mounts on
 * Hono (`app.all("/mcp", (c) => handler(c.req.raw))`), Bun.serve, Deno or any Fetch runtime.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createUsageLedger } from "./caps.js";
import { createParryMcpServer, type ParryMcpOptions } from "./server.js";

export type McpHttpHandler = (request: Request) => Promise<Response>;

const notAllowed = () =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless; POST JSON-RPC messages to it." }, id: null }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
  );

/**
 * A handler for `/mcp`. Hosted on a public API, leave `agent` unset: the endpoint then serves the
 * read tools only. The usage ledger is shared across requests, so write caps hold per process.
 */
export function createMcpHttpHandler(opts: ParryMcpOptions): McpHttpHandler {
  const shared = { ...opts, ledger: opts.ledger ?? createUsageLedger() };
  return async (request) => {
    if (request.method !== "POST") return notAllowed();
    const server = createParryMcpServer(shared);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
