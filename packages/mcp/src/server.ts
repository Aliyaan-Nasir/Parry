/**
 * The Parry MCP server: read tools over the Parry API and the chain, and a few testnet write
 * tools for an agent's own NEAR account, each with a per-call cap and a count per UTC day.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  buildMandate,
  nearToYocto,
  ownerActions,
  ownerCallAction,
  verifyDecision,
  verifyReserves,
  yoctoToNear,
  type NearSigner,
  type Parry,
  type Power,
} from "@parry/sdk";
import { z } from "zod";
import { createUsageLedger, resolveCaps, type McpCaps, type UsageLedger } from "./caps.js";

export const SERVER_NAME = "parry";
export const SERVER_VERSION = "0.1.0";

export interface ParryMcpOptions {
  parry: Parry;
  /** The agent's own NEAR account, for the write tools (testnet only). Without it, no write tools. */
  agent?: NearSigner;
  caps?: Partial<McpCaps>;
  /** Shared call counts; one per process when several servers serve the same agent. */
  ledger?: UsageLedger;
  /** The clock (tests). */
  now?: () => Date;
}

const INSTRUCTIONS =
  "Parry protects leveraged positions on NEAR (Rhea lending), Hyperliquid and EVM chains from liquidation, and runs a delta-neutral NEAR vault. " +
  "A guardian in a TEE acts only inside each owner's on-chain mandate, after a signed review by a NEAR AI verifiable model. " +
  "Read tools change nothing. Write tools exist only when an agent account is configured, work only on testnet, act only for that agent's own account, and are capped per call and per UTC day.";

const ok = (summary: string, data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});

const refuse = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Runs a tool body and turns any failure into a clear tool error. */
async function guard(f: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await f();
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

const accountArg = z.string().min(2).max(64).describe("A NEAR account id, for example alice.testnet or a protected account 0u... id.");

export function createParryMcpServer(opts: ParryMcpOptions): McpServer {
  const { parry, agent } = opts;
  const caps = resolveCaps(opts.caps);
  const ledger = opts.ledger ?? createUsageLedger();
  const now = opts.now ?? (() => new Date());
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

  // ------------------------------------------------------------------------------------------
  // Read tools
  // ------------------------------------------------------------------------------------------

  server.registerTool(
    "get_position_risk",
    {
      title: "Protected account risk",
      description:
        "Reads a Parry protected account from the Parry API: its owner, its guardian mandate with today's counters, and every position (Rhea lending, Hyperliquid, Aave) " +
        "with health, liquidation price, distance to liquidation, probability of liquidation within 24 hours, median time to liquidation, 99% value at risk, and the 0 to 100 risk score and tier. Changes nothing.",
      inputSchema: { account: accountArg },
      annotations: read,
    },
    ({ account }) =>
      guard(async () => {
        const a = await parry.account(account);
        const worst = [...a.positions].sort((x, y) => y.score - x.score)[0];
        const summary = worst
          ? `${a.positions.length} position(s); highest risk ${worst.label}: score ${worst.score} (${worst.tier}), health ${worst.health ?? "no debt"}.`
          : "No positions.";
        return ok(summary, a as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "risk_check",
    {
      title: "Risk check for any NEAR account",
      description:
        "Scores the Rhea lending position of any NEAR account (protected by Parry or not) with Parry's risk model: health, liquidation price, 24 hour liquidation probability, time to liquidation and score, " +
        "plus the market it was scored against. Reads the Parry API (free tier, rate limited). Changes nothing.",
      inputSchema: { account: accountArg },
      annotations: read,
    },
    ({ account }) =>
      guard(async () => {
        const r = await parry.riskCheck(account);
        const summary = r.position ? `Score ${r.position.score} (${r.position.tier}), health ${r.position.health ?? "no debt"}.` : `${account} has no lending position.`;
        return ok(summary, r as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "get_market",
    {
      title: "NEAR market risk",
      description: "Reads the NEAR price, the Tremor volatility index (hourly and annualized, with its level) and the cascade pressure across monitored positions, from the Parry API. Changes nothing.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      guard(async () => {
        const m = await parry.market();
        return ok(`NEAR $${m.near.priceUsd}; Tremor ${m.tremor.level}; cascade pressure ${m.cascade.pressure}.`, m as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "get_vault",
    {
      title: "Delta-neutral vault",
      description:
        "Reads the delta-neutral NEAR vault from the Parry API: whether deposits are paused, its 0 to 100 risk score, share price, NAV, the LiNEAR stake, the Hyperliquid short hedge, yield, " +
        "the reserves summary, caps and queue length. Changes nothing.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      guard(async () => {
        const v = await parry.vault();
        return ok(`Risk score ${v.riskScore}; share price $${v.sharePriceUsd}; NAV $${v.navUsd}; ${v.paused ? "deposits paused" : "deposits open"}.`, v as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "get_reserves",
    {
      title: "Proof of reserves",
      description:
        "Reads the vault's proof of reserves from the Parry API (every reserve leaf with its Merkle proof) and verifies it locally: each proof against the published root, the root recomputed from all leaves, " +
        "and the root against the one stored on the vault contract when the chain is reachable. Changes nothing.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      guard(async () => {
        const reserves = await parry.reserves();
        let onChainRoot: string | null = null;
        try {
          onChainRoot = (await parry.vaultState()).reserves?.root ?? null;
        } catch {
          onChainRoot = null;
        }
        const verification = verifyReserves(reserves, { onChainRoot });
        const summary = `${verification.ok ? "Verified" : "NOT verified"}: ${reserves.leaves.length} leaves, ratio ${reserves.ratioBps / 100}%, ` +
          `chain root ${verification.onChainMatches === null ? "not read" : verification.onChainMatches ? "matches" : "differs"}.`;
        return ok(summary, { reserves, verification, onChainRoot });
      }),
  );

  server.registerTool(
    "get_guardian_log",
    {
      title: "Guardian decisions",
      description:
        "Reads the guardian's decisions from the Parry API, newest first: the trigger, the planned action, the AI review (model, verdict, reasoning, signature) and the outcome and transactions. " +
        "Optionally for one account. Changes nothing.",
      inputSchema: {
        account: accountArg.optional().describe("Only decisions about this protected account."),
        limit: z.number().int().min(1).max(50).optional().describe("How many decisions (1 to 50, default 10)."),
      },
      annotations: read,
    },
    ({ account, limit }) =>
      guard(async () => {
        const page = await parry.decisions({ ...(account ? { account } : {}), limit: limit ?? 10 });
        return ok(`${page.items.length} decision(s).`, page as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "verify_guardian_decision",
    {
      title: "Verify a guardian decision",
      description:
        "Verifies one guardian decision independently of the API's own claims: recomputes the review hash, checks the model's signature covers this exact request and response and recovers to its signing address (EIP-191), " +
        "checks the action envelope is signed by the enclave key read from the risk board contract and carries this review hash, and that the decision id is the envelope's hash. " +
        "Reads the decision from the Parry API and the key from the chain. Changes nothing.",
      inputSchema: { id: z.string().min(1).max(128).describe("The decision id (its envelope hash).") },
      annotations: read,
    },
    ({ id }) =>
      guard(async () => {
        const decision = await parry.decision(id);
        let enclavePublicKey: string | null = null;
        let keySource = "risk board contract";
        try {
          enclavePublicKey = (await parry.enclave()).key.public_key;
        } catch (e) {
          keySource = `unavailable: ${(e as Error).message}`;
        }
        const verification = verifyDecision(decision, { enclavePublicKey });
        const failed = verification.checks.filter((c) => c.status === "fail").map((c) => c.name);
        const summary = verification.ok ? "Verified." : `NOT verified${failed.length ? `: ${failed.join(", ")} failed` : ""}.`;
        return ok(summary, { id, verification, enclavePublicKey, keySource, decision: { account: decision.account, action: decision.action, outcome: decision.outcome, verdict: decision.review.verdict } });
      }),
  );

  server.registerTool(
    "simulate_rescue",
    {
      title: "Simulate a rescue",
      description:
        "Asks the Parry API what the guardian would do for a protected account right now (whether it would trigger, why, each step with health before and after, and the swap route comparison). " +
        "Changes nothing: nothing is signed or sent. Unlimited.",
      inputSchema: { account: accountArg },
      annotations: read,
    },
    ({ account }) =>
      guard(async () => {
        const s = await parry.simulate(account);
        return ok(s.triggered ? `Would act: ${s.steps.map((x) => x.kind).join(", ")}.` : `Would not act: ${s.reason}`, s as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "get_rescue_route",
    {
      title: "Rescue swap route comparison",
      description:
        "Compares the two ways a rescue could sell NEAR collateral for USDC right now: the Rhea exchange pool the account swaps on, and a NEAR Intents 1Click quote with dry: true " +
        "(solvers compete on price; with a partner key the route stays confidential). On testnet the Intents side is a mainnet dry-run quote for the same amount, shown for comparison. Changes nothing.",
      inputSchema: { amount_near: z.number().positive().max(1_000_000).describe("NEAR to sell.") },
      annotations: read,
    },
    ({ amount_near }) =>
      guard(async () => {
        const r = await parry.rescueQuote(amount_near);
        const intents = "outUsd" in r.intents ? `${r.intents.outUsd} USDC` : `unavailable (${r.intents.unavailable})`;
        return ok(`Rhea pool ${r.rhea ? `${r.rhea.outUsd} USDC` : "unavailable"}, NEAR Intents ${intents}; chosen: ${r.chosen}${r.reason ? ` (${r.reason})` : ""}.`, r as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "get_status",
    {
      title: "Service and fleet status",
      description:
        "Reads the health of every Parry service, the oracle feed's freshness, the indexer's lag, the gas-key lanes each service wallet transacts on in parallel, and the treasury balance, from the Parry API. Changes nothing.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      guard(async () => {
        const s = await parry.status();
        const down = s.services.filter((x) => !x.ok).map((x) => x.name);
        return ok(down.length ? `Down: ${down.join(", ")}.` : `All ${s.services.length} services up.`, s as unknown as Record<string, unknown>);
      }),
  );

  // ------------------------------------------------------------------------------------------
  // Write tools: testnet only, the configured agent's own account, capped.
  // ------------------------------------------------------------------------------------------

  if (!agent) return server;
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

  /** A refusal when this server is not on testnet, checked before anything is read or sent. */
  const notTestnet = (tool: string): CallToolResult | null =>
    parry.network === "testnet" ? null : refuse(`${tool} refused: write tools work on testnet only and this server is on ${parry.network}. Nothing was sent.`);
  /** Counts the call, or refuses it when today's cap is reached. Called right before sending. */
  const admit = (tool: string, perDay: number): CallToolResult | null =>
    ledger.take(tool, perDay, now())
      ? null
      : refuse(`${tool} refused: the cap is ${perDay} call(s) per UTC day and it is reached. Nothing was sent; it resets at 00:00 UTC.`);
  const remaining = (tool: string, perDay: number) => Math.max(0, perDay - ledger.used(tool, now()));
  const agentProtectedAccount = () => parry.protectedAccountId({ nearAccount: agent.accountId });

  server.registerTool(
    "create_protected_account",
    {
      title: "Create the agent's protected account",
      description:
        `Creates the Parry protected account owned by this server's agent NEAR account (${agent.accountId}) through the Parry API relayer, which pays the creation deposit. ` +
        `Changes: a new account on testnet, owned only by the agent account. Testnet only; at most ${caps.createPerDay} call(s) per UTC day.`,
      inputSchema: {},
      annotations: { ...write, idempotentHint: true },
    },
    () =>
      guard(async () => {
        const refused = notTestnet("create_protected_account") ?? admit("create_protected_account", caps.createPerDay);
        if (refused) return refused;
        const r = await parry.createProtectedAccount({ nearAccount: agent.accountId });
        return ok(`Protected account ${r.accountId} (transaction ${r.txHash}).`, { ...r, owner: agent.accountId, remainingToday: remaining("create_protected_account", caps.createPerDay) });
      }),
  );

  const policy = z
    .object({
      trigger_score: z.number().int().min(0).max(100).describe("Act at or above this risk score."),
      trigger_health: z.number().positive().describe("Act at or below this health factor, whatever the score."),
      target_health: z.number().positive().describe("Health factor a rescue aims for."),
      strategy: z.enum(["repay-first", "keep-exposure", "deleverage-only"]),
    })
    .describe("Private trigger thresholds and strategy, encrypted to the enclave's sealing key so only the guardian can read them.");

  server.registerTool(
    "set_mandate",
    {
      title: "Set the guardian mandate",
      description:
        `Sets the guardian's mandate on the agent's protected account (owner_call from ${agent.accountId}, 1 yoctoNEAR): which protective lending powers it has (repay, add collateral, deleverage), ` +
        "per-token reserve and daily caps, actions per day, the health a deleverage must leave, the swap slippage cap and the expiry, with an optional sealed policy. " +
        "The guardian key and sealing key are read from the risk board. The guardian can never move funds out of the account. " +
        `Changes: replaces any current mandate on that account and resets its counters. Testnet only; at most ${caps.setMandatePerDay} call(s) per UTC day.`,
      inputSchema: {
        powers: z.array(z.enum(["repay", "add_collateral", "deleverage"])).min(1).describe("Protective powers to grant."),
        limits: z
          .array(
            z.object({
              token: z.string().describe("Token contract id, for example usdc.parry.testnet."),
              reserve: z.string().regex(/^\d+$/).describe("Total the guardian may spend over the mandate's life, in token units."),
              daily: z.string().regex(/^\d+$/).describe("Most the guardian may move per UTC day, in token units."),
            }),
          )
          .max(8)
          .describe("Per-token limits (at most 8)."),
        max_actions_per_day: z.number().int().min(1).max(48).optional().describe("1 to 48 (default 4)."),
        min_health_after_bps: z.number().int().min(10_500).optional().describe("Health a deleverage must leave, in bps (at least 10500, default 11000)."),
        max_slippage_bps: z.number().int().min(0).max(300).optional().describe("Rescue swap slippage cap in bps (at most 300, default 100)."),
        expires_in_days: z.number().int().min(1).max(180).optional().describe("Days until the mandate expires (1 to 180, default 30)."),
        policy: policy.optional(),
      },
      annotations: write,
    },
    (args) =>
      guard(async () => {
        const offNetwork = notTestnet("set_mandate");
        if (offNetwork) return offNetwork;
        const account = await agentProtectedAccount();
        const enclave = await parry.enclave();
        if (args.policy && !enclave.sealingKey) throw new Error("set_mandate refused: the risk board has no sealing key yet, so a policy cannot be sealed. Nothing was sent.");
        const nowSecs = Math.floor(now().getTime() / 1000);
        const mandate = buildMandate({
          account,
          guardianKey: enclave.key.public_key,
          powers: args.powers as Power[],
          limits: args.limits,
          maxActionsPerDay: args.max_actions_per_day ?? 4,
          minHealthAfterBps: args.min_health_after_bps ?? 11_000,
          maxSlippageBps: args.max_slippage_bps ?? 100,
          expiresAt: nowSecs + (args.expires_in_days ?? 30) * 86_400,
          now: nowSecs,
          ...(args.policy
            ? {
                policy: {
                  triggerScore: args.policy.trigger_score,
                  triggerHealth: args.policy.trigger_health,
                  targetHealth: args.policy.target_health,
                  strategy: args.policy.strategy,
                },
                sealingPublicKey: enclave.sealingKey!.public_key,
              }
            : {}),
        });
        const call = ownerCallAction(account, [ownerActions.setMandate(mandate)]);
        const refused = admit("set_mandate", caps.setMandatePerDay);
        if (refused) return refused;
        const sent = await parry.sendCall(call, agent);
        return ok(`Mandate set on ${account} (transaction ${sent.txHash}).`, {
          account,
          txHash: sent.txHash,
          mandate,
          remainingToday: remaining("set_mandate", caps.setMandatePerDay),
        });
      }),
  );

  server.registerTool(
    "vault_deposit",
    {
      title: "Deposit NEAR into the vault",
      description:
        `Deposits NEAR from the agent account (${agent.accountId}) into the delta-neutral vault (deposit, 150 Tgas) and mints vault shares to it. ` +
        `Changes: moves the NEAR from the agent account into the vault. Testnet only; at most ${caps.depositMaxNear} NEAR per call and ${caps.depositPerDay} call(s) per UTC day.`,
      inputSchema: {
        amount_near: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,24})?$/)]).describe(`NEAR to deposit, at most ${caps.depositMaxNear}.`),
      },
      annotations: write,
    },
    ({ amount_near }) =>
      guard(async () => {
        const offNetwork = notTestnet("vault_deposit");
        if (offNetwork) return offNetwork;
        const yocto = nearToYocto(amount_near);
        if (yocto <= 0n) return refuse("vault_deposit refused: the amount must be positive. Nothing was sent.");
        if (yocto > nearToYocto(String(caps.depositMaxNear))) {
          return refuse(`vault_deposit refused: at most ${caps.depositMaxNear} NEAR per call, asked ${yoctoToNear(yocto)}. Nothing was sent.`);
        }
        const call = parry.vaultDepositAction(yocto);
        const refused = admit("vault_deposit", caps.depositPerDay);
        if (refused) return refused;
        const sent = await parry.sendCall(call, agent);
        return ok(`Deposited ${yoctoToNear(yocto)} NEAR into ${call.receiverId} (transaction ${sent.txHash}).`, {
          vault: call.receiverId,
          amountYocto: yocto.toString(),
          txHash: sent.txHash,
          sharesMinted: sent.value,
          remainingToday: remaining("vault_deposit", caps.depositPerDay),
        });
      }),
  );

  server.registerTool(
    "vault_withdraw",
    {
      title: "Queue a vault withdrawal",
      description:
        `Queues a withdrawal of the agent account's vault shares (request_withdraw, 1 yoctoNEAR): the shares move into the vault's escrow and are paid out in LiNEAR (and USDC for hedge gains) once a newer vault report lands. ` +
        `Changes: escrows the shares. Testnet only; at most ${caps.withdrawPerDay} call(s) per UTC day.`,
      inputSchema: { shares: z.string().regex(/^[1-9]\d*$/).describe("Share units to withdraw (a share has 24 decimals).") },
      annotations: write,
    },
    ({ shares }) =>
      guard(async () => {
        const offNetwork = notTestnet("vault_withdraw");
        if (offNetwork) return offNetwork;
        const call = parry.requestWithdrawAction(shares);
        const refused = admit("vault_withdraw", caps.withdrawPerDay);
        if (refused) return refused;
        const sent = await parry.sendCall(call, agent);
        return ok(`Withdrawal of ${shares} share units queued (transaction ${sent.txHash}).`, {
          vault: call.receiverId,
          shares,
          txHash: sent.txHash,
          withdrawalId: sent.value,
          remainingToday: remaining("vault_withdraw", caps.withdrawPerDay),
        });
      }),
  );

  server.registerTool(
    "paid_risk_check",
    {
      title: "Paid risk check over x402",
      description:
        `Scores any NEAR account's lending position through the Parry API's paid endpoint, paying per call over x402 on NEAR: the agent account (${agent.accountId}) signs a delegate ft_transfer of test USDC, ` +
        "the API settles it on chain before answering, and the result carries the payment receipt. Use it when the free tier is rate limited. " +
        `Changes: moves the price (at most ${caps.paidMaxUnits / 1e6} test USDC) from the agent account. Testnet only; at most ${caps.paidPerDay} call(s) per UTC day.`,
      inputSchema: { account: accountArg },
      annotations: write,
    },
    ({ account }) =>
      guard(async () => {
        const refused = notTestnet("paid_risk_check") ?? admit("paid_risk_check", caps.paidPerDay);
        if (refused) return refused;
        const r = await parry.paidRiskCheck(account, { payer: agent, maxAmount: String(caps.paidMaxUnits) });
        const p = r.result.position;
        return ok(p ? `Score ${p.score} (${p.tier}), health ${p.health ?? "no debt"}; paid ${r.requirement?.amount ?? 0} units.` : `${account} has no lending position.`, {
          ...(r.result as unknown as Record<string, unknown>),
          payment: r.payment,
          remainingToday: remaining("paid_risk_check", caps.paidPerDay),
        });
      }),
  );

  return server;
}
