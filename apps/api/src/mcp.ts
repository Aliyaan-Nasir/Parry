/** The hosted MCP endpoint: read tools only (no agent wallet on the server). */

import { createParry } from "@parryguard/sdk";
import { createMcpHttpHandler } from "@parryguard/mcp";
import { network } from "@parryguard/services/lib/config";

let app: { fetch: (req: Request) => Response | Promise<Response> } | null = null;

/** The API's own app answers the MCP tools' API calls, without a network round trip. */
export function bindApp(a: { fetch: (req: Request) => Response | Promise<Response> }) {
  app = a;
}

const parry = createParry({
  network,
  apiUrl: "http://parry.internal",
  fetch: (url: string | URL | Request, init?: RequestInit) => {
    if (!app) throw new Error("the MCP endpoint is not bound to the API");
    return Promise.resolve(app.fetch(new Request(url, init)));
  },
});

export const handler = createMcpHttpHandler({ parry });
