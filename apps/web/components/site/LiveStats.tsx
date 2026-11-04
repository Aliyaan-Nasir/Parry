"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Container } from "./Section";
import { NumberTicker } from "@/components/ui/NumberTicker";
import { Skeleton, SkeletonSwap } from "@/components/ui/Skeleton";
import { TierBadge } from "@/components/ui/TierBadge";
import { fetchStats, type Stats } from "@/lib/stats";
import { formatRelativeTime } from "@/lib/format";
import { tierFromScore } from "@/lib/risk";
import { network } from "@/lib/env";
import { cn } from "@/lib/cn";

export const STATS_QUERY_KEY = ["stats"] as const;

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 px-5 py-5 sm:px-6", className)}>
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd className="mt-2 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-[28px] leading-9 font-medium tracking-[-0.02em] text-fg">
        {children}
      </dd>
    </div>
  );
}

function Unavailable() {
  return <span aria-hidden="true" className="mt-1 inline-block h-px w-10 bg-line-strong align-middle" />;
}

/** Relative "updated" time that refreshes itself once a minute. */
function UpdatedAt({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);
  return (
    <time dateTime={iso} className="text-muted">
      {now === null ? "" : `Updated ${formatRelativeTime(iso, now)}`}
    </time>
  );
}

/**
 * Real figures from the Parry API on testnet. Skeletons hold the space while loading; when the
 * API cannot be reached the strip says so quietly and shows no numbers at all.
 */
export function LiveStats() {
  const query = useQuery<Stats>({
    queryKey: STATS_QUERY_KEY,
    queryFn: ({ signal }) => fetchStats(signal),
    refetchInterval: 60_000,
    retry: 1,
  });
  const data = query.data;
  const loading = query.isPending;
  const unavailable = !loading && !data;
  const tier = data ? tierFromScore(data.vaultRiskScore) : null;
  const shownNetwork = data?.network ?? network;

  const value = (render: (s: Stats) => ReactNode, width: string) =>
    unavailable ? <Unavailable /> : <SkeletonSwap ready={!!data} fallback={<Skeleton width={width} />}>{data ? render(data) : null}</SkeletonSwap>;

  return (
    <section aria-labelledby="live-title" className="border-t border-line">
      <Container className="py-10 sm:py-12">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <h2 id="live-title" className="flex items-center gap-2.5 text-sm font-semibold text-fg">
            <span aria-hidden="true" className={cn("relative flex size-2", unavailable ? "text-muted" : "text-safe")}>
              {!unavailable && !loading ? (
                <span className="absolute inline-flex size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
              ) : null}
              <span className="relative inline-flex size-2 rounded-full bg-current" />
            </span>
            <span>
              Live from NEAR <span className="capitalize">{shownNetwork}</span>
            </span>
          </h2>
          <p className="text-[13px]" aria-live="polite">
            {unavailable ? (
              <span className="text-muted">Live data unavailable right now.</span>
            ) : data ? (
              <UpdatedAt iso={data.updatedAt} />
            ) : (
              <span className="text-muted">Loading live data</span>
            )}
          </p>
        </div>
        <dl
          className="mt-5 grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-raised lg:grid-cols-4"
          aria-busy={loading || undefined}
        >
          <Cell label="Positions protected" className="border-b border-r border-line lg:border-b-0">
            {value((s) => <NumberTicker value={s.positionsProtected} />, "4ch")}
          </Cell>
          <Cell label="Rescues" className="border-b border-line lg:border-b-0 lg:border-r">
            {value((s) => <NumberTicker value={s.rescues} />, "3ch")}
          </Cell>
          <Cell label="Vault TVL" className="border-r border-line">
            {value((s) => <NumberTicker value={s.vaultTvlUsd} format="usdCompact" />, "6ch")}
          </Cell>
          <Cell label="Vault risk score">
            {value((s) => <NumberTicker value={s.vaultRiskScore} />, "3ch")}
            {tier ? <TierBadge tier={tier} className="text-xs tracking-normal" /> : null}
          </Cell>
        </dl>
      </Container>
    </section>
  );
}
