"use client";

// React Query hooks over @parryguard/sdk: one query key per resource, polled at the pace its data
// changes (positions 10 s, status 15 s, vault 30 s).

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AccountSummary, Alert, DecisionPage, HistoryPoint, Market, MandateView, Position, Rates, Reserves, RouteComparison } from "@parryguard/sdk";
import { api, chain, parry } from "./parry";
import { apiUrl } from "./env";

const SECOND = 1000;

/** Polling paces, in milliseconds. */
export const PACE = {
  positions: 10 * SECOND,
  status: 15 * SECOND,
  vault: 30 * SECOND,
  shock: 5 * SECOND,
} as const;

export const keys = {
  config: ["config"] as const,
  market: ["market"] as const,
  account: (id: string) => ["account", id] as const,
  positions: (id: string) => ["positions", id] as const,
  portfolio: (id: string) => ["portfolio", id] as const,
  history: (positionId: string, hours: number) => ["history", positionId, hours] as const,
  decisions: (account: string | null) => ["decisions", account ?? "all"] as const,
  alerts: (account: string) => ["alerts", account] as const,
  vault: ["vault"] as const,
  vaultHistory: (days: number) => ["vault-history", days] as const,
  reserves: ["reserves"] as const,
  rates: ["rates"] as const,
  status: ["status"] as const,
  fx: ["fx"] as const,
  settings: (id: string) => ["settings", id] as const,
  simulation: (id: string) => ["simulation", id] as const,
  quote: (amountNear: number) => ["quote", amountNear] as const,
  shock: ["shock"] as const,
  owned: (owner: string) => ["owned", owner] as const,
  mandate: (id: string) => ["mandate", id] as const,
  enclave: ["enclave"] as const,
  vaultChain: ["vault-chain"] as const,
  balance: (id: string) => ["balance", id] as const,
  lendingRatios: ["lending-ratios"] as const,
  oracle: ["oracle-status"] as const,
};

const hasApi = apiUrl !== null;

export function useConfig() {
  return useQuery({ queryKey: keys.config, queryFn: () => parry().config(), staleTime: 5 * 60 * SECOND, enabled: hasApi });
}

export function useMarket() {
  return useQuery<Market>({ queryKey: keys.market, queryFn: () => parry().market(), refetchInterval: PACE.status, enabled: hasApi });
}

export function useAccountSummary(account: string | null) {
  return useQuery<AccountSummary>({
    queryKey: keys.account(account ?? ""),
    queryFn: () => parry().account(account!),
    enabled: hasApi && !!account,
    refetchInterval: PACE.positions,
  });
}

export function usePositions(account: string | null, pace: number = PACE.positions) {
  return useQuery<Position[]>({
    queryKey: keys.positions(account ?? ""),
    queryFn: () => parry().positions(account!),
    enabled: hasApi && !!account,
    refetchInterval: pace,
  });
}

export function usePortfolio(account: string | null) {
  return useQuery({ queryKey: keys.portfolio(account ?? ""), queryFn: () => api.portfolio(account!), enabled: hasApi && !!account, refetchInterval: PACE.positions });
}

export function useHistory(positionId: string | null, hours: number) {
  return useQuery<HistoryPoint[]>({
    queryKey: keys.history(positionId ?? "", hours),
    queryFn: () => parry().history(positionId!, hours),
    enabled: hasApi && !!positionId,
    refetchInterval: 60 * SECOND,
    placeholderData: keepPreviousData,
  });
}

export function useDecisions(account: string | null, limit = 10) {
  return useInfiniteQuery<DecisionPage>({
    queryKey: [...keys.decisions(account), limit],
    queryFn: ({ pageParam }) => parry().decisions({ ...(account ? { account } : {}), limit, ...(pageParam ? { cursor: pageParam as string } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: hasApi,
    refetchInterval: PACE.status,
  });
}

export function useAlerts(account: string | null) {
  return useQuery<Alert[]>({ queryKey: keys.alerts(account ?? ""), queryFn: () => parry().alerts(account!), enabled: hasApi && !!account, refetchInterval: PACE.status });
}

export function useVault() {
  return useQuery({ queryKey: keys.vault, queryFn: () => api.vault(), enabled: hasApi, refetchInterval: PACE.vault });
}

export function useVaultHistory(days: number) {
  return useQuery({ queryKey: keys.vaultHistory(days), queryFn: () => api.vaultHistory(days), enabled: hasApi, refetchInterval: 60 * SECOND, placeholderData: keepPreviousData });
}

export function useReserves() {
  return useQuery<Reserves>({ queryKey: keys.reserves, queryFn: () => parry().reserves(), enabled: hasApi, refetchInterval: 60 * SECOND });
}

export function useRates() {
  return useQuery<Rates>({ queryKey: keys.rates, queryFn: () => parry().rates(), enabled: hasApi, staleTime: 120 * SECOND });
}

export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: () => api.status(), enabled: hasApi, refetchInterval: PACE.status });
}

export function useFx(enabled = true) {
  return useQuery({ queryKey: keys.fx, queryFn: () => api.fx(), enabled: hasApi && enabled, staleTime: 60 * 60 * SECOND, retry: 1 });
}

export function useSettings(account: string | null) {
  return useQuery({ queryKey: keys.settings(account ?? ""), queryFn: () => api.settings(account!), enabled: hasApi && !!account });
}

export function useSimulation(account: string | null) {
  return useQuery({ queryKey: keys.simulation(account ?? ""), queryFn: () => api.simulate(account!), enabled: hasApi && !!account, refetchInterval: PACE.vault, retry: 0 });
}

export function useRescueQuote(amountNear: number | null) {
  return useQuery<RouteComparison>({
    queryKey: keys.quote(amountNear ?? 0),
    queryFn: () => parry().rescueQuote(amountNear!),
    enabled: hasApi && amountNear !== null && amountNear > 0,
    staleTime: 30 * SECOND,
    placeholderData: keepPreviousData,
  });
}

export function useShock(enabled = true) {
  return useQuery({ queryKey: keys.shock, queryFn: () => api.shock(), enabled: hasApi && enabled, refetchInterval: PACE.shock });
}

/** Protected accounts owned by a NEAR account or a passkey (compressed P-256 hex). */
export function useOwnedAccounts(owner: string | null) {
  return useQuery<string[]>({ queryKey: keys.owned(owner ?? ""), queryFn: () => api.accountsByOwner(owner!), enabled: hasApi && !!owner, staleTime: 60 * SECOND });
}

// Chain reads.

export function useMandate(account: string | null) {
  return useQuery<MandateView | null>({
    queryKey: keys.mandate(account ?? ""),
    queryFn: async () => (await chain()).mandate(account!),
    enabled: !!account,
    refetchInterval: PACE.status,
  });
}

export function useEnclave() {
  return useQuery({ queryKey: keys.enclave, queryFn: async () => (await chain()).enclave(), staleTime: 5 * 60 * SECOND });
}

export function useVaultChainState(enabled = true) {
  return useQuery({ queryKey: keys.vaultChain, queryFn: async () => (await chain()).vaultState(), enabled, refetchInterval: PACE.vault, retry: 0 });
}

/** The account's spendable NEAR, as a decimal string. */
export function useNearBalance(account: string | null) {
  return useQuery({ queryKey: keys.balance(account ?? ""), queryFn: async () => (await chain()).near.getBalance(account!), enabled: !!account, refetchInterval: PACE.positions });
}

/** Rhea's volatility ratios for wNEAR collateral and USDC debt, read from the lending contract. */
export function useLendingRatios() {
  return useQuery({
    queryKey: keys.lendingRatios,
    queryFn: async () => {
      const c = await chain();
      type Asset = { config: { volatility_ratio: number; extra_decimals: number } } | null;
      const [wnear, usdc] = await Promise.all([
        c.near.view<Asset>(c.contracts.lending, "get_asset", { token_id: c.contracts.wnear }),
        c.near.view<Asset>(c.contracts.lending, "get_asset", { token_id: c.contracts.usdc }),
      ]);
      if (!wnear || !usdc) throw new Error("the lending contract does not list wNEAR and USDC");
      return { collateral: wnear.config.volatility_ratio / 10_000, debt: usdc.config.volatility_ratio / 10_000 };
    },
    staleTime: 10 * 60 * SECOND,
  });
}

/** The test oracle's limits (max shock), testnet only. */
export function useOracleStatus(enabled = true) {
  return useQuery({
    queryKey: keys.oracle,
    queryFn: async () => {
      const c = await chain();
      if (!c.contracts.oracle) throw new Error("no oracle on this network");
      return c.near.view<{ max_shock_bps: number; network: string }>(c.contracts.oracle, "status", {});
    },
    enabled,
    staleTime: 5 * 60 * SECOND,
  });
}

/** The Hyperliquid market the vault hedges on (asset and index), from the vault contract's config. */
export function useHedgeMarket() {
  return useQuery({
    queryKey: ["vault-config"],
    queryFn: async () => {
      const c = await chain();
      const config = await c.near.view<{ hedge: { asset: string; asset_index: number } } | null>(c.contracts.vault, "config", {});
      if (!config?.hedge) throw new Error("the vault has no hedge config");
      return config.hedge;
    },
    staleTime: 10 * 60 * SECOND,
    retry: 0,
  });
}
