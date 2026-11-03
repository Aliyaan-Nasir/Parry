/**
 * Alert rules: what turns a risk assessment into a notification. Thresholds are per person
 * (Settings); an alert stays open until acknowledged and resolves itself when the condition clears.
 */

import type { Tier } from "./risk.js";

export type AlertKind = "risk" | "health" | "cascade" | "guardian" | "vault";
export type Severity = "info" | "warning" | "critical";

export interface AlertThresholds {
  /** Score at or above which a risk alert opens. */
  score: number;
  /** Health below which a health alert opens. */
  health: number;
  /** Cascade pressure at or above which a market alert opens. */
  cascade: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = { score: 50, health: 1.25, cascade: 0.5 };

export interface AlertCandidate {
  kind: AlertKind;
  severity: Severity;
  key: string;
  title: string;
  body: string;
}

const severityOf = (tier: Tier): Severity => (tier === "critical" ? "critical" : tier === "danger" ? "warning" : "info");

/** The alerts one position's assessment raises now. `key` dedupes an open alert. */
export function alertsFor(
  position: { id: string; label: string },
  a: { score: number; tier: Tier; health: number; ttlHours: number | null },
  t: AlertThresholds = DEFAULT_THRESHOLDS,
): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  if (a.score >= t.score) {
    const ttl = a.ttlHours === null ? "" : ` Median time to liquidation: ${a.ttlHours < 1 ? "under an hour" : `${a.ttlHours.toFixed(1)} hours`}.`;
    out.push({
      kind: "risk",
      severity: severityOf(a.tier),
      key: `risk:${position.id}`,
      title: `${position.label}: risk ${a.score} (${a.tier})`,
      body: `The risk score crossed your threshold of ${t.score}.${ttl}`,
    });
  }
  if (Number.isFinite(a.health) && a.health < t.health) {
    out.push({
      kind: "health",
      severity: a.health < 1.05 ? "critical" : "warning",
      key: `health:${position.id}`,
      title: `${position.label}: health ${a.health.toFixed(2)}`,
      body: `Health is below your threshold of ${t.health.toFixed(2)}. Liquidation starts at 1.00.`,
    });
  }
  return out;
}

/** A market-wide alert when cascade pressure is high. */
export function cascadeAlert(driver: string, pressure: number, atRiskUsd: number, t: AlertThresholds = DEFAULT_THRESHOLDS): AlertCandidate | null {
  if (pressure < t.cascade) return null;
  return {
    kind: "cascade",
    severity: pressure >= 0.8 ? "critical" : "warning",
    key: `cascade:${driver}`,
    title: `${driver}: liquidation cascade pressure ${(pressure * 100).toFixed(0)}%`,
    body: `About $${Math.round(atRiskUsd).toLocaleString("en-US")} of collateral would be liquidated by a 2σ daily move.`,
  };
}
