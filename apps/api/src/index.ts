/** Starts the API on Bun, with the hosted MCP endpoint at /mcp. */

import { intEnv } from "@parry/services/lib/config";
import { db, migrate } from "@parry/services/lib/db";
import { log } from "@parry/services/lib/log";
import { createApp } from "./app";

const sql = db();
await migrate(sql);
const mcp = await import("./mcp");
const app = createApp(sql, { mcp: mcp.handler });
mcp.bindApp(app);
const port = intEnv("PORT", 4000);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 60 });
log.info("api listening", { port });
