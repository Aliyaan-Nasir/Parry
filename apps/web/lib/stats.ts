import { apiUrl } from "./env";

/** GET /v1/stats: live network figures shown on the landing page. */
export type Stats = {
  network: string;
  positionsProtected: number;
  rescues: number;
  vaultTvlUsd: number;
  vaultRiskScore: number;
  updatedAt: string;
};

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Validates an API response; anything malformed is treated as unavailable rather than shown. */
export function parseStats(input: unknown): Stats | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.network !== "string" || o.network.length === 0) return null;
  if (!isCount(o.positionsProtected) || !isCount(o.rescues) || !isCount(o.vaultTvlUsd)) return null;
  if (!isCount(o.vaultRiskScore) || o.vaultRiskScore > 100) return null;
  if (typeof o.updatedAt !== "string" || Number.isNaN(Date.parse(o.updatedAt))) return null;
  return {
    network: o.network,
    positionsProtected: o.positionsProtected,
    rescues: o.rescues,
    vaultTvlUsd: o.vaultTvlUsd,
    vaultRiskScore: o.vaultRiskScore,
    updatedAt: o.updatedAt,
  };
}

export class StatsUnavailableError extends Error {
  constructor(reason: string) {
    super(`Live data unavailable: ${reason}`);
    this.name = "StatsUnavailableError";
  }
}

export async function fetchStats(signal?: AbortSignal): Promise<Stats> {
  if (!apiUrl) throw new StatsUnavailableError("no API configured");
  const res = await fetch(`${apiUrl}/v1/stats`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new StatsUnavailableError(`status ${res.status}`);
  const stats = parseStats(await res.json());
  if (!stats) throw new StatsUnavailableError("unexpected response");
  return stats;
}
