"use client";

import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "./env";

/**
 * Typed reads for the routes the redesigned site and app add (docs/api.md): rates, the crash
 * replay, the cascade heatmap, prices, insurance, certificates, verification, route savings,
 * incidents and watched accounts. Each answers null (not an error) while the API lacks the route,
 * so a section can hide itself instead of breaking the page.
 */

export async function getJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!apiUrl) return null;
  const res = await fetch(`${apiUrl}${path}`, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 404 || res.status === 503) return null;
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export type { Certificate as CertificateLive, Heatmap as HeatmapLive, Incident as IncidentLive, Prices as PricesLive, Rates as RatesLive, Replay as ReplayLive, ReplayCrash, RouteSavings as SavingsLive, Stats as StatsLive, VaultInsurance as InsuranceLive, VerifyResult as VerifyLive } from "@parry/sdk";
import type { Certificate, Heatmap, Incident, Prices, Rates, Replay, RouteSavings, Stats, VaultInsurance, VerifyResult } from "@parry/sdk";

export type Check = VerifyResult["checks"][number];

export const live = {
  stats: () => getJson<Stats>("/v1/stats"),
  rates: () => getJson<Rates>("/v1/rates"),
  replay: () => getJson<Replay>("/v1/replay"),
  heatmap: (network: "testnet" | "mainnet") => getJson<Heatmap>(`/v1/heatmap?network=${network}`),
  prices: (tokens?: readonly string[]) => getJson<Prices>(`/v1/prices${tokens?.length ? `?tokens=${tokens.join(",")}` : ""}`),
  insurance: () => getJson<VaultInsurance>("/v1/vault/insurance"),
  verify: (id: string) => getJson<VerifyResult>(`/v1/verify/${encodeURIComponent(id)}`),
  certificates: (account?: string) => getJson<Certificate[]>(`/v1/certificates${account ? `?account=${account}` : ""}`),
  savings: (account?: string) => getJson<RouteSavings>(`/v1/routes/savings${account ? `?account=${account}` : ""}`),
  incidents: (account: string) => getJson<Incident[]>(`/v1/incidents?account=${account}`),
};

const minute = 60_000;

export const useStatsLive = () => useQuery({ queryKey: ["live", "stats"], queryFn: live.stats, refetchInterval: minute, retry: 1 });
export const useRatesLive = () => useQuery({ queryKey: ["live", "rates"], queryFn: live.rates, refetchInterval: 2 * minute, retry: 1 });
export const useReplay = () => useQuery({ queryKey: ["live", "replay"], queryFn: live.replay, staleTime: 30 * minute, retry: 1 });
export const useHeatmap = (network: "testnet" | "mainnet") => useQuery({ queryKey: ["live", "heatmap", network], queryFn: () => live.heatmap(network), refetchInterval: 5 * minute, retry: 1 });
export const usePrices = (tokens?: readonly string[]) => useQuery({ queryKey: ["live", "prices", tokens?.join(",") ?? ""], queryFn: () => live.prices(tokens), refetchInterval: minute, retry: 1 });
export const useInsurance = () => useQuery({ queryKey: ["live", "insurance"], queryFn: live.insurance, refetchInterval: 2 * minute, retry: 1 });
export const useVerify = (id: string | null) => useQuery({ queryKey: ["live", "verify", id], queryFn: () => live.verify(id!), enabled: !!id, retry: 0 });
export const useCertificates = (account?: string) => useQuery({ queryKey: ["live", "certificates", account ?? ""], queryFn: () => live.certificates(account), refetchInterval: 2 * minute, retry: 1 });
export const useSavings = (account?: string) => useQuery({ queryKey: ["live", "savings", account ?? ""], queryFn: () => live.savings(account), refetchInterval: 2 * minute, retry: 1 });
export const useIncidents = (account: string | null) => useQuery({ queryKey: ["live", "incidents", account], queryFn: () => live.incidents(account!), enabled: !!account, refetchInterval: minute, retry: 1 });
