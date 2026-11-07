#!/usr/bin/env node
/** `parry-mcp`: the Parry MCP server over stdio, configured by environment variables. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv } from "./env.js";
import { createParryMcpServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const { options, notes } = configFromEnv(process.env);
  const server = createParryMcpServer(options);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; everything else goes to stderr.
  console.error(`parry-mcp ${SERVER_VERSION} on ${options.parry.network}${notes.length ? `: ${notes.join("; ")}` : ""}`);
}

main().catch((e: unknown) => {
  console.error(`parry-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
