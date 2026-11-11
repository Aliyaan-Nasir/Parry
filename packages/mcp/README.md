# @parry/mcp

An MCP server for Parry: liquidation risk, the delta-neutral NEAR vault, proof of reserves and the guardian's verifiable log.
Read tools change nothing.
Write tools exist only when an agent account is configured, work only on testnet, act only for that agent's own account, and are capped per call and per UTC day.

## Install and run

```bash
PARRY_NETWORK=testnet PARRY_API_URL=http://localhost:4000 npx @parry/mcp
```

As an MCP client entry:

```json
{
  "mcpServers": {
    "parry": {
      "command": "npx",
      "args": ["-y", "@parry/mcp"],
      "env": { "PARRY_NETWORK": "testnet", "PARRY_API_URL": "http://localhost:4000" }
    }
  }
}
```

From a clone of the repository, build it and point the client at the built entry instead:

```bash
pnpm install && pnpm -F @parry/mcp build
PARRY_NETWORK=testnet PARRY_API_URL=http://localhost:4000 node packages/mcp/dist/bin.js
```

## Configuration

- `PARRY_NETWORK`: `testnet` (default) or `mainnet`.
- `PARRY_API_URL`: the Parry API the read tools use (`http://localhost:4000` when the API runs locally).
- `PARRY_RPC_URL`: a NEAR RPC endpoint (optional).
- `PARRY_AGENT_ACCOUNT_ID` and `PARRY_AGENT_PRIVATE_KEY`: the agent's own testnet account and its `ed25519:` full-access key, which turn on the write tools.

On mainnet the write tools are listed but refuse every call, and the key is never used.

## Read tools

- `get_position_risk(account)`: a protected account's owner, mandate and every position with health, liquidation price, 24 hour liquidation probability, time to liquidation, value at risk, score and tier.
- `risk_check(account)`: the risk of any NEAR account's lending position, protected or not.
- `get_market()`: NEAR price, the Tremor volatility index and cascade pressure.
- `get_vault()`: the vault's state, risk score, share price, NAV, hedge, yield and caps.
- `get_reserves()`: every reserve leaf with its proof, verified locally and against the root on the vault contract.
- `get_guardian_log(account?, limit?)`: guardian decisions with their trigger, action, AI review and outcome.
- `verify_guardian_decision(id)`: checks a decision's review hash, model signature, enclave signature and envelope against the key on the risk board.
- `simulate_rescue(account)`: what the guardian would do now, unsigned and unlimited.
- `get_rescue_route(amount_near)`: the Rhea pool against a dry-run NEAR Intents 1Click quote for a rescue swap.
- `get_status()`: every service's health, the oracle's freshness, the indexer's lag, the gas-key lanes and the treasury.
- `get_rates()`: every Rhea lending asset's rates, Hyperliquid's NEAR funding and the vault's staking against funding yield, each with its source.
- `get_crash_replay()`: the risk model, guardian and vault replayed through NEAR's largest historical crashes.
- `get_liquidation_heatmap(network?)`: every Rhea lending borrower's liquidation price, bucketed, and the chained cascades.
- `get_prices(tokens?)`: USD prices and 24 hour changes of NEAR, the liquid staking tokens, USDC and every Rhea asset.
- `verify_record(id)`: the API's re-check of a decision id, a certificate hash or a NEAR transaction hash.
- `verify_certificate(hash, reader?)`: checks a health certificate's hash, enclave signature (with the key in force at issue time), expiry, reader and anchor locally.
- `get_incidents(account)`: an account's alerts grouped into incidents.
- `get_route_savings(account?)`: what each rescue's route choice saved against the worst quote.

## Write tools (testnet, agent account only)

- `create_protected_account()`: creates the agent's protected account through the relayer, at most 3 calls per UTC day.
- `set_mandate(powers, limits, ...)`: sets the guardian mandate on the agent's protected account, with an optional sealed policy, at most 10 calls per UTC day.
- `vault_deposit(amount_near)`: deposits NEAR from the agent account into the vault, at most 1 NEAR per call and 5 calls per UTC day.
- `vault_withdraw(shares)`: queues a withdrawal of the agent's vault shares, at most 5 calls per UTC day.
- `paid_risk_check(account)`: a risk check paid per call over x402 on NEAR from the agent account (at most 0.05 test USDC a call), at most 20 calls per UTC day.
- `list_watched()`: the agent's watched accounts with live risk (a read, listed only with an agent because it signs in with the agent key).
- `watch_account(account, score, health, label?)` and `unwatch_account(account)`: the agent's watch list, at most 20 calls per UTC day together.
- `issue_certificate(reader, threshold, ttl_secs, venue?, anchor?)`: an enclave-signed health certificate for the agent's protected account, at most 7 days long and 5 calls per UTC day.

Every refusal says why, and nothing is sent when a call is refused.

## In code

```ts
import { createParry } from "@parry/sdk";
import { createParryMcpServer } from "@parry/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const parry = createParry({ network: "testnet", apiUrl: process.env.PARRY_API_URL });
const server = createParryMcpServer({ parry, caps: { depositPerDay: 2 } });
await server.connect(new StdioServerTransport());
```

- `createParryMcpServer({ parry, agent?, caps?, ledger? })`: the server, with write tools when `agent` is given.
- `createMcpHttpHandler({ parry })`: a stateless Streamable HTTP handler from a Fetch `Request` to a `Response`.
- `createUsageLedger()`: the per-day call counter, shared across servers in one process.
- `DEFAULT_CAPS`: the default per-call and per-day caps.
- `configFromEnv(env)`: the options the `parry-mcp` command builds from its environment.

## Over HTTP

```ts
import { Hono } from "hono";
import { createParry } from "@parry/sdk";
import { createMcpHttpHandler } from "@parry/mcp";

const mcp = createMcpHttpHandler({ parry: createParry({ network: "testnet", apiUrl: process.env.PARRY_API_URL }) });
const app = new Hono();
app.all("/mcp", (c) => mcp(c.req.raw));
```

Without an `agent` the HTTP endpoint serves the read tools only.

## Networks

`PARRY_NETWORK` (or the `parry` client's `network`) switches between testnet and mainnet.
Contract ids come from `@parry/sdk`, and Parry's own mainnet contracts are not deployed yet.

## License

MIT
