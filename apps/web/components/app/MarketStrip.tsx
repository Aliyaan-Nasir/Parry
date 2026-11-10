"use client";

import type { ReactNode } from "react";
import { QueryError } from "./bits";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
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
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd className="mt-1.5 flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1 text-2xl font-medium leading-8 tracking-[-0.02em] text-fg">{children}</dd>
      {foot ? <dd className="mt-0.5 text-[13px] text-muted">{foot}</dd> : null}
    </div>
  );
}

/** NEAR price, the Tremor volatility index and cascade pressure, from /v1/market. */
export function MarketStrip() {
  const q = useMarket();
  const { format } = useMoney();
  const now = useNow();
  const m = q.data;
  if (q.isError && !m) return <QueryError title="Market data is unavailable" error={q.error} onRetry={() => void q.refetch()} />;
  const ready = !!m;
  return (
    <Card as="section" padding="none" aria-labelledby="market-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 sm:px-6">
        <h2 id="market-title" className="text-sm font-semibold text-fg">
          Market
        </h2>
        <span className="text-[13px] text-muted">
          {m && now ? (
            <time dateTime={m.near.updatedAt}>Updated {formatRelativeTime(m.near.updatedAt, now)}</time>
          ) : (
            <Skeleton width="9ch" />
          )}
        </span>
      </div>
      <dl className="grid divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Cell label="NEAR price" foot={m ? (m.near.hlMid !== null ? `Hyperliquid mid ${format(m.near.hlMid)}` : "Oracle price") : <Skeleton width="14ch" />}>
          <span className="num">
            <SkeletonSwap ready={ready} fallback={<Skeleton width="6ch" />}>
              {m ? format(m.near.priceUsd) : null}
            </SkeletonSwap>
          </span>
        </Cell>
        <Cell label="Tremor index" foot={m ? `Annualized volatility, ${m.tremor.windows.length} windows` : <Skeleton width="16ch" />}>
          <span className="num">
            <SkeletonSwap ready={ready} fallback={<Skeleton width="5ch" />}>
              {m ? formatPercent(m.tremor.annual, 0) : null}
            </SkeletonSwap>
          </span>
          {m ? (
            <Badge tone={TREMOR_TONE[m.tremor.level] ?? "neutral"}>{TREMOR_LABEL[m.tremor.level] ?? m.tremor.level}</Badge>
          ) : null}
        </Cell>
        <Cell
          label="Cascade pressure"
          foot={
            m ? (
              `${format(m.cascade.atRiskUsd, { compact: true })} at risk in a 2σ day${m.cascade.correlatedOwners > 0 ? `, ${m.cascade.correlatedOwners} correlated owners` : ""}`
            ) : (
              <Skeleton width="16ch" />
            )
          }
        >
          <span className="num">
            <SkeletonSwap ready={ready} fallback={<Skeleton width="5ch" />}>
              {m ? formatPercent(m.cascade.pressure, 1) : null}
            </SkeletonSwap>
          </span>
          {m ? <Badge tone={cascadeTone(m.cascade.pressure)}>{cascadeLabel(m.cascade.pressure)}</Badge> : null}
        </Cell>
      </dl>
    </Card>
  );
}
