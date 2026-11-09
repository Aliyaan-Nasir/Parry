/**
 * Limits on the write tools: a per-call cap and a count per UTC day for each.
 */

export interface McpCaps {
  /** `create_protected_account` calls per UTC day. */
  createPerDay: number;
  /** `set_mandate` calls per UTC day. */
  setMandatePerDay: number;
  /** Largest `vault_deposit`, in NEAR. */
  depositMaxNear: number;
  /** `vault_deposit` calls per UTC day. */
  depositPerDay: number;
  /** `vault_withdraw` calls per UTC day. */
  withdrawPerDay: number;
  /** `paid_risk_check` calls per UTC day. */
  paidPerDay: number;
  /** Most a `paid_risk_check` may pay, in USDC units (6 decimals). */
  paidMaxUnits: number;
}

export const DEFAULT_CAPS: Readonly<McpCaps> = {
  createPerDay: 3,
  setMandatePerDay: 10,
  depositMaxNear: 1,
  depositPerDay: 5,
  withdrawPerDay: 5,
  paidPerDay: 20,
  paidMaxUnits: 50_000,
};

/** Counts write-tool calls per UTC day. Share one ledger across server instances (HTTP). */
export interface UsageLedger {
  /** Calls of `tool` recorded on the UTC day of `now`. */
  used(tool: string, now: Date): number;
  /** Records one call when fewer than `limit` were recorded today; false when the cap is reached. */
  take(tool: string, limit: number, now: Date): boolean;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** An in-memory ledger (forgets on restart). */
export function createUsageLedger(): UsageLedger {
  const counts = new Map<string, number>();
  return {
    used: (tool, now) => counts.get(`${utcDay(now)}|${tool}`) ?? 0,
    take(tool, limit, now) {
      const day = utcDay(now);
      for (const k of counts.keys()) if (!k.startsWith(`${day}|`)) counts.delete(k);
      const key = `${day}|${tool}`;
      const n = counts.get(key) ?? 0;
      if (n >= limit) return false;
      counts.set(key, n + 1);
      return true;
    },
  };
}

export function resolveCaps(caps: Partial<McpCaps> | undefined): McpCaps {
  const out = { ...DEFAULT_CAPS, ...Object.fromEntries(Object.entries(caps ?? {}).filter(([, v]) => v !== undefined)) } as McpCaps;
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`cap ${k} must be a non-negative number`);
  }
  return out;
}
