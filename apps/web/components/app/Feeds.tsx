"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Alert, Decision } from "@parry/sdk";
import { ALERT_KIND, ALERT_STATUS, ACTION_LABEL, OUTCOME, SEVERITY } from "./labels";
import { VENUE_LABEL } from "./PositionsTable";
import { Badge } from "@/components/ui/Badge";
import { formatRelativeTime } from "@/lib/format";
import { formatHealth } from "@/lib/units";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/cn";

export function SeverityGlyph({ severity, className }: { severity: Alert["severity"]; className?: string }) {
  const tone = severity === "critical" ? "text-critical" : severity === "warning" ? "text-caution" : "text-brass";
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={cn("mt-0.5 shrink-0", tone, className)}>
      {severity === "critical" ? (
        <>
          <path d="M5.1 1.2 H10.9 L14.8 5.1 V10.9 L10.9 14.8 H5.1 L1.2 10.9 V5.1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 4.6 V8.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.1" r="0.95" fill="currentColor" />
        </>
      ) : severity === "warning" ? (
        <>
          <path d="M8 1.6 L15 14 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 6.2 V9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.8" r="0.9" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 7.2 V11.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()} className={cn("whitespace-nowrap text-[13px] text-muted", className)}>
      {now ? formatRelativeTime(iso, now) : ""}
    </time>
  );
}

/** One alert, compact: severity, title, body and when. */
export function AlertRow({ alert, actions }: { alert: Alert; actions?: ReactNode }) {
  const status = ALERT_STATUS[alert.status];
  return (
    <div className="flex gap-3">
      <SeverityGlyph severity={alert.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-sm font-semibold text-fg">
            <span className="sr-only">{SEVERITY[alert.severity].label}: </span>
            {alert.title}
          </p>
          <TimeAgo iso={alert.createdAt} />
        </div>
        <p className="mt-0.5 text-[13px] leading-5 text-muted">{alert.body}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge tone={SEVERITY[alert.severity].tone}>{SEVERITY[alert.severity].label}</Badge>
          <Badge tone={status.tone} variant="outline">
            {status.label}
          </Badge>
          <span className="text-xs text-muted">{ALERT_KIND[alert.kind] ?? alert.kind}</span>
        </div>
        {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** One guardian decision, compact: the action, its outcome, and health before and after. */
export function DecisionRow({ decision }: { decision: Decision }) {
  const outcome = OUTCOME[decision.outcome] ?? { label: decision.outcome, tone: "neutral" as const };
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-fg">
          {ACTION_LABEL[decision.action] ?? decision.action}
          <span className="font-normal text-muted"> on {VENUE_LABEL[decision.venue] ?? decision.venue}</span>
        </p>
        <TimeAgo iso={decision.createdAt} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        {decision.healthBefore !== null ? (
          <span className="num text-[13px] text-muted">
            Health {formatHealth(decision.healthBefore)}
            {decision.healthAfter !== null ? (
              <>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> to </span>
                <span className="text-fg">{formatHealth(decision.healthAfter)}</span>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A "see everything" link under a feed. */
export function FeedLink({ href, children }: { href: "/app/alerts" | "/app/guardian" | "/app/watched"; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brass underline-offset-4 hover:underline">
      {children}
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

/** Alerts newest first, whatever order they arrive in. */
export function newestFirst<T extends { createdAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
