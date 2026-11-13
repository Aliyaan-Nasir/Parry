// A protected account's own Hyperliquid address: its balances, and sending what the account signed
// (an order or a Spot-to-Perps transfer) on to Hyperliquid, which acts only once it receives it.

import { hyperliquidBalances, hyperliquidBody, hyperliquidError, submitHyperliquid, type HyperliquidAnswer, type OwnerAction } from "@parryguard/sdk";
import { useQuery } from "@tanstack/react-query";
import { hyperliquidApi, network } from "./env";
import { keys, PACE } from "./queries";

/** Perps account value and movable Spot USDC of `address`, refreshed with the account. */
export function useHyperliquidBalances(account: string | null, address: string | null) {
  return useQuery({
    queryKey: [...keys.balance(account ?? ""), "hyperliquid", address ?? ""],
    queryFn: () => hyperliquidBalances(address!, network, { url: hyperliquidApi }),
    enabled: !!account && !!address,
    refetchInterval: PACE.vault,
  });
}

/**
 * Sends the signature a Hyperliquid owner action returned to Hyperliquid, with the action it
 * signed. Throws when Hyperliquid refuses the request or rejects the order.
 */
export async function sendToHyperliquid(action: OwnerAction, signature: unknown): Promise<HyperliquidAnswer> {
  const answer = await submitHyperliquid(hyperliquidBody(action, signature, network), network, { url: hyperliquidApi });
  const rejected = hyperliquidError(answer);
  if (rejected) throw new Error(`Hyperliquid rejected the order: ${rejected}`);
  return answer;
}
