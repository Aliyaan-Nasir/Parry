---
name: parry
description: Use Parry on NEAR from an agent or from code - check the liquidation risk of a lending position, protect it with a guardian mandate, read and verify the guardian's decisions, use the delta-neutral NEAR vault and its proof of reserves, and extend the Parry codebase (contracts, enclave, services, SDK, MCP). Use when the user mentions Parry, liquidation protection on NEAR, Rhea lending risk, a guardian mandate, the EARN vault, or the @parry/sdk or @parry/mcp packages.
---

# Parry

Parry keeps leveraged positions from being liquidated, and runs a delta-neutral NEAR vault.
A guardian program in an OutLayer TEE watches each protected position, plans a rescue, has a NEAR AI Cloud verifiable model review it, and signs it with a key bound to its build.
The person's account contract accepts only protective actions within their on-chain mandate, and records the review's hash with each one.

## Pick the right tool

- To answer questions about risk, the vault or the guardian, use the MCP server (`@parry/mcp`) if it is connected, otherwise the SDK (`@parry/sdk`), otherwise the HTTP API (`docs/api.md`).
- To change Parry itself, read `AGENTS.md` at the repository root first: it maps every NEAR primitive to its file and lists the commands and traps.
- Everything runs on NEAR testnet; mainnet code paths exist but Parry's own contracts are not deployed there.

## Connect the MCP server

Claude Code:

```bash
claude mcp add parry -e PARRY_NETWORK=testnet -e PARRY_API_URL=http://localhost:4000 -- npx -y @parry/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.parry]
command = "npx"
args = ["-y", "@parry/mcp"]
env = { PARRY_NETWORK = "testnet", PARRY_API_URL = "http://localhost:4000" }
```

Any client that speaks streamable HTTP can use the hosted server at `/mcp` on the Parry API instead.
Write tools appear only when `PARRY_AGENT_ACCOUNT_ID` and `PARRY_AGENT_PRIVATE_KEY` (a testnet account's own full-access key) are set; they act only for that account and are capped per call and per UTC day.

## Read tools (change nothing)

| Tool | Use it to |
| --- | --- |
| `risk_check(account)` | score any NEAR account's Rhea lending position, protected or not |
| `get_position_risk(account)` | read a protected account's owner, mandate and every position's health, liquidation price, 24 h liquidation probability, time to liquidation and tier |
| `get_market()` | read the NEAR price, the Tremor volatility index and cascade pressure |
| `get_vault()` | read the vault's NAV, share price, hedge, risk score and caps |
| `get_reserves()` | fetch every reserve leaf with its Merkle proof, verified against the root on chain |
| `get_guardian_log(account?, limit?)` | list guardian decisions with trigger, action, AI review and outcome |
| `verify_guardian_decision(id)` | check a decision's review hash, the model's TEE signature, the enclave's signature and the envelope |
| `simulate_rescue(account)` | see what the guardian would do now, unsigned |
| `get_rescue_route(amount_near)` | compare the Rhea pool with a dry-run NEAR Intents 1Click quote for a rescue swap |
| `get_status()` | read every service's health, the oracle's freshness, the gas-key lanes and the treasury |

## Write tools (testnet, the agent's own account only)

`create_protected_account()`, `set_mandate(...)`, `vault_deposit(amount_near)`, `vault_withdraw(shares)`, and `paid_risk_check(account)`, which pays per call over x402 on NEAR.
Every refusal says why; nothing is sent when a call is refused.

## How to explain a risk result

- Health is collateral value times its volatility ratio over debt value; liquidation starts below 1.
- The score (0 to 100) combines the square root of the 24 hour liquidation probability (70 %), volatility (15 %) and cascade pressure (15 %), with floors: health under 1.10 scores at least 50, under 1.03 at least 75.
- Tiers: safe under 25, caution from 25, danger from 50, critical from 75.
- The full model, with every formula, is `docs/risk-model.md`.

## Use the SDK

```ts
import { buildMandate, createParry, NETWORKS, ownerActions, ownerCallAction } from "@parry/sdk";

const parry = createParry({ network: "testnet", apiUrl: process.env.PARRY_API_URL });
const risk = await parry.riskCheck("alice.testnet");
const account = await parry.protectedAccountId({ nearAccount: "alice.testnet" });
const { key, sealingKey } = await parry.enclave();
const mandate = buildMandate({
  account,
  guardianKey: key.public_key,
  powers: ["repay", "add_collateral"],
  limits: [{ token: NETWORKS.testnet.contracts.usdc, reserve: "200000000", daily: "100000000" }], // 200 and 100 USDC
  maxActionsPerDay: 5,
  minHealthAfterBps: 10500,
  maxSlippageBps: 200,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
  policy: { triggerScore: 60, triggerHealth: 1.15, targetHealth: 1.45, strategy: "repay-first" },
  sealingPublicKey: sealingKey?.public_key,
});
const call = ownerCallAction(account, [ownerActions.setMandate(mandate)]);
// A wallet signs `call` as it is; the SDK holds no keys unless you pass one to sendCall.
```

The SDK README (`packages/sdk/README.md`) lists every member.

## Guardian limits to state honestly

- The guardian can repay, add collateral, deleverage through the exchange round trip, reduce or hedge a Hyperliquid position inside a size cap and price band, and approve or repay an Aave loan for the person's own address.
- It cannot transfer funds to anyone, and it acts only inside the mandate's powers, per-token reserve and daily caps, daily action count and expiry.
- Every action carries the hash of the AI review that approved it; a review that does not verify means no action.
- The owner can revoke the mandate, pause the guardian or act directly at any time.

## Extend Parry

Adding a guardian action touches, in order:

1. `contracts/common/src/mandate.rs`: a `GuardianAction` variant and the `Power` it needs.
2. `contracts/account/src/guardian.rs`: the checks against the mandate in `guardian_execute`, then the promise it runs; refusals in callbacks are `guardian_refused` events.
3. `contracts/account/src/tests.rs` and `contracts/tests/tests/protect.rs`: a unit test for every refusal and a sandbox test on the real lending code.
4. `enclave/src/modes.rs`: the planner step that proposes it, and a test with the scripted world in `enclave/src/io.rs`.
5. `services/src/guardian.ts`: anything off chain the action needs after the account signs (broadcasting, submitting an order).
6. `packages/sdk` types and `docs/api.md` if the decision shape changes.

Then run `pnpm test`, `pnpm test:contracts`, `cd enclave && cargo test`, `pnpm typecheck`, `pnpm lint` and `pnpm security`.
Deploy only reproducible builds (`contracts/scripts/build.sh --reproducible`), never local ones.
