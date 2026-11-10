/**
 * Confidential rescue reserve through the NEAR Intents Agent API (mainnet only, a beta that needs
 * a partner key). The guardian can never send funds out of a protected account, so the private
 * route runs the other way round: the owner funds a NEAR Intents agent account as a rescue
 * reserve and signs its policy once, and that policy lets Parry's backend only swap between wNEAR
 * and USDC on confidential routes and withdraw to the protected account itself. When a protected
 * position needs repaying, Parry swaps privately and refills the account's USDC reserve, and the
 * guardian repays from it inside the on-chain mandate as usual. Liquidation hunters watching the
 * chain see a deposit arrive, not the swap that funded it.
 */

import { createAgentApi, createGrantCredential, type AgentApi, type Policy } from "@near-intents-agent-api/sdk";

export const INTENTS_WNEAR = "nep141:wrap.near";
export const INTENTS_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** The client, from NEAR_INTENTS_AGENT_API_KEY; null without a key or off mainnet. */
export function intentsAgentApi(opts: { apiKey?: string; network?: string; fetch?: typeof fetch } = {}): AgentApi | null {
  const apiKey = opts.apiKey ?? process.env.NEAR_INTENTS_AGENT_API_KEY;
  const network = opts.network ?? process.env.PARRY_NETWORK ?? "testnet";
  if (!apiKey || network !== "mainnet") return null;
  return createAgentApi({ apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

/**
 * The reserve's policy: swaps between wNEAR and USDC and withdrawals, both on confidential routes,
 * paid out only to the protected account on NEAR, inside a per-swap cap and a daily USD budget.
 */
export function rescueReservePolicy(protectedAccount: string, limits: { perSwapNearYocto: string; dailyUsd: number }): Policy {
  return {
    frozen: false,
    actions: ["swap", "withdraw"],
    confidential: true,
    owner_approval: false,
    assets: [INTENTS_WNEAR, INTENTS_USDC],
    limits: { per_transaction: { [INTENTS_WNEAR]: limits.perSwapNearYocto } },
    max_actions_per_hour: 6,
    destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: protectedAccount, memo: null }] },
    budget: { daily_usd: String(limits.dailyUsd), weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

/**
 * The owner's `agent_create` intent for the reserve, for their wallet to sign in the app, and the
 * grant credential Parry's backend keeps (encrypted) to act inside that policy.
 */
export async function prepareRescueReserve(
  api: AgentApi,
  owner: { account_id: string; public_key: string },
  protectedAccount: string,
  limits: { perSwapNearYocto: string; dailyUsd: number },
) {
  const intent = await api.generateIntent({
    type: "agent_create",
    name: `Parry rescue reserve for ${protectedAccount}`,
    owner: { type: "near", ...owner },
    policy: rescueReservePolicy(protectedAccount, limits),
  });
  return { intent, grant: createGrantCredential() };
}

/**
 * Sells `amountYocto` wNEAR for USDC on a confidential route (at least `minUsdcOut`), then
 * withdraws the USDC to the protected account. `dry` previews both legs and moves nothing.
 */
export async function confidentialRefill(
  grantApi: AgentApi,
  agentId: string,
  protectedAccount: string,
  amountYocto: string,
  minUsdcOut: string,
  opts: { dry: boolean },
) {
  const swap = { origin_asset: INTENTS_WNEAR, destination_asset: INTENTS_USDC, amount: amountYocto, min_amount_out: minUsdcOut, confidential: true };
  if (opts.dry) {
    const quote = await grantApi.swap(agentId, { ...swap, dry: true });
    const withdrawal = await grantApi.withdraw(agentId, { asset: INTENTS_USDC, amount: minUsdcOut, chain: "near", recipient: protectedAccount, confidential: true, dry: true });
    return { dry: true as const, quote, withdrawal };
  }
  const swapped = await grantApi.swap(agentId, swap);
  const withdrawn = await grantApi.withdraw(agentId, { asset: INTENTS_USDC, amount: minUsdcOut, chain: "near", recipient: protectedAccount, confidential: true });
  return { dry: false as const, swapped, withdrawn };
}
