import type { ReactNode } from "react";
import { Skeleton, SkeletonSwap } from "./Skeleton";
import { cn } from "@/lib/cn";

export type StatDelta = {
  /** Already formatted, for example "+2.4%" or "-3". */
  value: ReactNode;
  trend: "up" | "down" | "flat";
  /** Whether the change is good, bad or neither; defaults to neutral. */
  tone?: "positive" | "negative" | "neutral";
  /** Context for the change, for example "24 h". */
  period?: string;
};

export type StatProps = {
  label: ReactNode;
  /** The figure; rendered in the mono face with tabular digits. */
  value: ReactNode;
  delta?: StatDelta;
  hint?: ReactNode;
  /** While true a skeleton holds the value's place. */
  loading?: boolean;
  size?: "md" | "lg";
  className?: string;
};

const toneClass = { positive: "text-safe", negative: "text-critical", neutral: "text-muted" } as const;
const trendWord = { up: "up", down: "down", flat: "unchanged" } as const;

function TrendArrow({ trend }: { trend: StatDelta["trend"] }) {
  if (trend === "flat") {
    return (
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path d="M1.5 5 H8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" className={trend === "down" ? "rotate-180" : undefined}>
      <path d="M5 1.5 L8.5 6.5 H1.5 Z" fill="currentColor" />
    </svg>
  );
}

/** A <dl> grid for Stats; each Stat is a dt and dd pair. */
export function StatGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid gap-6", className)}>{children}</dl>;
}

/** One figure with its label. Place inside StatGroup (or any <dl>). */
export function Stat({ label, value, delta, hint, loading = false, size = "md", className }: StatProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[13px] font-medium text-muted">{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-end gap-x-2.5 gap-y-1">
        <span className={cn("num font-medium tracking-[-0.02em] text-fg", size === "lg" ? "text-[32px] leading-10" : "text-2xl leading-8")}>
          <SkeletonSwap ready={!loading} fallback={<Skeleton width="5ch" />}>
            {value}
          </SkeletonSwap>
        </span>
        {delta && !loading ? (
          <span className={cn("num inline-flex items-center gap-1 text-[13px] font-medium", toneClass[delta.tone ?? "neutral"])}>
            <TrendArrow trend={delta.trend} />
            <span className="sr-only">{trendWord[delta.trend]} </span>
            {delta.value}
            {delta.period ? <span className="font-sans text-muted">{delta.period}</span> : null}
          </span>
        ) : null}
      </dd>
      {hint ? <dd className="mt-1 text-[13px] text-muted">{hint}</dd> : null}
    </div>
  );
}
