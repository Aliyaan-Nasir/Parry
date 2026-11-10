"use client";

import { ExternalLink } from "./bits";
import { explorerUrl } from "@/lib/explorer";
import { cn } from "@/lib/cn";

export type StepStatus = "waiting" | "active" | "done" | "skipped" | "failed";

export type Step = { key: string; label: string; status: StepStatus; detail?: string | undefined; txHash?: string | undefined };

const WORD: Record<StepStatus, string> = { waiting: "Waiting", active: "In progress", done: "Done", skipped: "Skipped", failed: "Failed" };

function Dot({ status, index }: { status: StepStatus; index: number }) {
  if (status === "done") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-safe text-raised" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="11" height="11">
          <path d="M2.5 6.3 L4.9 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-critical text-raised" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-brass-fill" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12" className="text-brass motion-safe:animate-spin">
          <path d="M14 8A6 6 0 0 0 8 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={cn("num flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px]", status === "skipped" ? "border-dashed border-line-strong text-muted" : "border-line-strong text-muted")}
      aria-hidden="true"
    >
      {index + 1}
    </span>
  );
}

/** A run of transactions, one line each, with its status and its transaction link. */
export function StepList({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol className="grid gap-3" aria-label={label}>
      {steps.map((s, i) => {
        const href = s.txHash ? explorerUrl("nearblocks", s.txHash) : null;
        return (
          <li key={s.key} className="flex gap-3" aria-current={s.status === "active" ? "step" : undefined}>
            <Dot status={s.status} index={i} />
            <div className="min-w-0 pt-0.5">
              <p className={cn("text-sm font-semibold", s.status === "skipped" || s.status === "waiting" ? "text-muted" : "text-fg")}>
                {s.label}
                <span className="sr-only">: {WORD[s.status]}</span>
              </p>
              {s.detail ? <p className={cn("mt-0.5 text-[13px] leading-5", s.status === "failed" ? "text-critical" : "text-muted")}>{s.detail}</p> : null}
              {href ? (
                <ExternalLink href={href} className="mt-1 text-[13px]">
                  Transaction on NearBlocks
                </ExternalLink>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
