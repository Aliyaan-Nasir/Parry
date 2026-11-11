"use client";

import type { ReactNode } from "react";
import { QueryError } from "./bits";
import { useMoney } from "@/components/providers/MoneyProvider";
import type { BadgeTone } from "@/components/ui/Badge";
import { Skeleton, SkeletonSwap } from "@/components/ui/Skeleton";
import { useMarket } from "@/lib/queries";
import { formatRelativeTime } from "@/lib/format";
import { formatPercent } from "@/lib/units";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/cn";

export const TREMOR_TONE: Record<string, BadgeTone> = { calm: "safe", elevated: "caution", high: "danger", extreme: "critical" };
export const TREMOR_LABEL: Record<string, string> = { calm: "Calm", elevated: "Elevated", high: "High", extreme: "Extreme" };

export function cascadeTone(pressure: number): BadgeTone {
  if (pressure >= 0.5) return "critical";
  if (pressure >= 0.25) return "danger";
  if (pressure >= 0.1) return "caution";
  return "safe";
}

export function cascadeLabel(pressure: number): string {
  if (pressure >= 0.5) return "Severe";
  if (pressure >= 0.25) return "High";
  if (pressure >= 0.1) return "Moderate";
  return "Low";
}

function Cell({ label, children, foot, className }: { label: string; children: ReactNode; foot?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 px-5 py-4 sm:px-6", className)}>
      <dt className="label">{label}</dt>
      <dd className="mt-1.5 flex min-h-8 flex-wrap items-end gap-x-2.5 gap-y-1 text-2xl leading-8 tracking-[-0.02em] text-fg">{children}</dd>
      {foot ? <dd className="mt-0.5 text-[12.5px] text-muted">{foot}</dd> : null}
    </div>
  );
}

/** The regime as the model names it (calm, stressed, panic), else the Tremor level. */
function regimeOf(t: { level: string; regime?: string }): string {
  return t.regime ?? (TREMOR_LABEL[t.level] ?? t.level).toLowerCase();
}

/**
 * NEAR price, the Tremor volatility index with its regime, and cascade pressure (from the real
 * liquidation map), as one ruled strip. It names a time only when the data is stale.
 */
export function MarketStrip() {
  const q = useMarket();
  const { format } = useMoney();
  const now = useNow();
  const m = q.data;
  if (q.isError && !m) return <QueryError title="Market data is unavailable" error={q.error} onRetry={() => void q.refetch()} />;
  const ready = !!m;
  const stale = m && now && now - Date.parse(m.near.updatedAt) > 10 * 60_000;
  const tremor = m?.tremor as ({ level: string; regime?: string; annual: number; windows: unknown[] } | undefined);
  return (
    <section aria-labelledby="market-title" className="ruled">
      <h2 id="market-title" className="sr-only">
        Market
      </h2>
      <dl className="grid divide-y divide-line bg-bg sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Cell label="NEAR" foot={m ? (stale ? `As of ${formatRelativeTime(m.near.updatedAt, now!)}` : m.near.hlMid !== null ? `Hyperliquid mid ${format(m.near.hlMid)}` : "Oracle price") : <Skeleton width="14ch" />}>
          <span className="num">
            <SkeletonSwap ready={ready} fallback={<Skeleton width="6ch" />}>
              {m ? format(m.near.priceUsd) : null}
            </SkeletonSwap>
          </span>
        </Cell>
        <Cell label="Volatility" foot={m ? `Tremor index, annualized over ${tremor?.windows.length ?? 3} windows` : <Skeleton width="16ch" />}>
          <span className="num">
            <SkeletonSwap ready={ready} fallback={<Skeleton width="5ch" />}>
              {m ? formatPercent(m.tremor.annual, 0) : null}
            </SkeletonSwap>
          </span>
          {tremor ? <span className="pb-0.5 text-sm text-fg/70">{regimeOf(tremor)}</span> : null}
        </Cell>
        <Cell label="Cascade pressure" foot={m ? `${format(m.cascade.atRiskUsd, { compact: true })} liquidates in a 2σ day` : <Skeleton width="16ch" />}>
          <span className="num">
            <SkeletonSwap ready={ready} fallback={<Skeleton width="5ch" />}>
              {m ? formatPercent(m.cascade.pressure, 1) : null}
            </SkeletonSwap>
          </span>
          {m ? <span className="pb-0.5 text-sm text-fg/70">{cascadeLabel(m.cascade.pressure).toLowerCase()}</span> : null}
        </Cell>
      </dl>
    </section>
  );
}
