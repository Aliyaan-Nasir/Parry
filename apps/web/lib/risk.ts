// Risk tiers for the 0 to 100 score: safe < 25 <= caution < 50 <= danger < 75 <= critical.

export const TIERS = ["safe", "caution", "danger", "critical"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  safe: "Safe",
  caution: "Caution",
  danger: "Danger",
  critical: "Critical",
};

/** Lower bound of each tier on the 0 to 100 score. */
export const TIER_FLOOR: Record<Tier, number> = {
  safe: 0,
  caution: 25,
  danger: 50,
  critical: 75,
};

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

export function tierFromScore(score: number): Tier {
  const s = clampScore(score);
  if (s >= TIER_FLOOR.critical) return "critical";
  if (s >= TIER_FLOOR.danger) return "danger";
  if (s >= TIER_FLOOR.caution) return "caution";
  return "safe";
}
