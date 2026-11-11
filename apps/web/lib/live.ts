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

export type StatsLive = {
  network: string;
  positionsProtected: number;
  positionsWatched?: number;
  rescues: number;
  vaultTvlUsd: number;
  vaultRiskScore: number | null;
  valueProtectedUsd?: number;
  insuranceUsd?: number;
  updatedAt: string;
};

export type RatesLive = {
  rhea: { asset: string; tokenId: string; supplyApr: number; borrowApr: number; utilization?: number; source: string }[];
  hyperliquid: { fundingHourly: number; funding24hApr: number; source: string } | null;
  vault: { stakingApr: number; fundingApr: number; netApr: number; insuranceShareBps: number; source: string } | null;
  readAt: string;
};

export type ReplayPoint = { t: number; h: number };
export type ReplayCrash = {
  id: string;
  name: string;
  start: string;
  end: string;
  dropPct: number;
  candles: { t: number; price: number }[];
  position: {
    startHealth: number;
    warningHours: number | null;
    liquidatedAt: number | null;
    steps: { t: number; action: string; plan: string; healthBefore: number; healthAfter: number }[];
    healthWith: ReplayPoint[];
    healthWithout: ReplayPoint[];
  };
  vault: { navWith: { t: number; v: number }[]; navUnhedged: { t: number; v: number }[]; maxDrawdownPct: number; marginMin: number; insurancePaidUsd: number };
};
export type ReplayLive = { source: string; crashes: ReplayCrash[]; summary: { medianWarningHours: number; liquidationsAvoided: number; crashes: number } };

export type HeatmapLive = {
  network: string;
  price: number;
  buckets: { price: number; collateralUsd: number; debtUsd: number; accounts: number }[];
  cascades: { from: number; to: number; collateralUsd: number }[];
  readAt: string;
  accounts: number;
};

export type PricesLive = { tokens: { id: string; symbol: string; priceUsd: number; change24h: number | null; source: string }[]; readAt: string };

export type InsuranceLive = {
  shareBps: number;
  valueUsd: number;
  paidTotalUsd: number;
  paidTodayUsd: number;
  capPerDayBps: number;
  marginReservedUsd: number;
  events: { kind: string; amountUsd: number; reason?: string; at: string; tx?: string | null }[];
};

export type Check = { name: string; ok: boolean; detail: string };
export type VerifyLive = { kind: "decision" | "certificate" | "transaction"; ok: boolean; checks: Check[]; subject: unknown };

export type CertificateLive = {
  hash: string;
  certificate: { account: string; reader: string; venue: string; threshold: number; block_height: number; issued_at: number; expires_at: number; statement: string };
  signature: string;
  enclavePublicKey: string;
  anchorTx: string | null;
  createdAt: string;
};

export type SavingsLive = { totalSavedUsd: number; rescues: { decision: string; chosen: string; worst: string; savedUsd: number; at: string }[] };

export type IncidentLive = { id: string; title: string; body: string; severity: string; alerts: unknown[]; openedAt: string; closedAt: string | null };

export const live = {
  stats: () => getJson<StatsLive>("/v1/stats"),
  rates: () => getJson<RatesLive>("/v1/rates"),
  replay: () => getJson<ReplayLive>("/v1/replay"),
  heatmap: (network: "testnet" | "mainnet") => getJson<HeatmapLive>(`/v1/heatmap?network=${network}`),
  prices: (tokens?: readonly string[]) => getJson<PricesLive>(`/v1/prices${tokens?.length ? `?tokens=${tokens.join(",")}` : ""}`),
  insurance: () => getJson<InsuranceLive>("/v1/vault/insurance"),
  verify: (id: string) => getJson<VerifyLive>(`/v1/verify/${encodeURIComponent(id)}`),
  certificates: (account?: string) => getJson<CertificateLive[]>(`/v1/certificates${account ? `?account=${account}` : ""}`),
  savings: (account?: string) => getJson<SavingsLive>(`/v1/routes/savings${account ? `?account=${account}` : ""}`),
  incidents: (account: string) => getJson<IncidentLive[]>(`/v1/incidents?account=${account}`),
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
