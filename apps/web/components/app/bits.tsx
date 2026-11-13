"use client";

// Small pieces the app pages share: external links, copy buttons, key and value rows, inline
// errors and notes.

import { m } from "framer-motion";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ParryApiError } from "@parryguard/sdk";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export function ExternalIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path d="M4.5 2.5 H9.5 V7.5 M9.3 2.7 L2.8 9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A link that opens another site in a new tab, said so to screen readers. */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-1.5 font-semibold text-brass underline-offset-4 hover:underline", className)}
    >
      {children}
      <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Copies `value` to the clipboard and says so for a moment. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      window.clearTimeout(timer.current);
      setCopied(false);
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold text-muted transition-colors hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="text-safe">
          <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.75 3.25 V3 A1.25 1.25 0 0 0 9.5 1.75 H4 A1.25 1.25 0 0 0 2.75 3 V8.5 A1.25 1.25 0 0 0 4 9.75 H4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      <span className="sr-only"> {label}</span>
    </button>
  );
}

/** A definition list laid out as rows: label on the left, value on the right. */
export function DataList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid divide-y divide-line", className)}>{children}</dl>;
}

export function DataRow({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3", className)}>
      <dt className="text-sm text-muted">
        {label}
        {hint ? <span className="mt-0.5 block text-[12px] leading-4 text-muted">{hint}</span> : null}
      </dt>
      <dd className="min-w-0 text-right text-sm font-semibold text-fg">{children}</dd>
    </div>
  );
}

/** The error a failed read or write carries, in plain words. */
export function errorMessage(e: unknown): string {
  if (e instanceof ParryApiError) {
    const body = e.body as { error?: unknown } | string | null;
    const detail = typeof body === "string" ? body : body && typeof body.error === "string" ? body.error : null;
    if (e.status === 404) return detail ?? "Not found.";
    if (e.status === 429) return detail ?? "Too many requests: try again in a little while.";
    return detail ? `${detail} (${e.status})` : `The Parry API answered ${e.status}.`;
  }
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return "The Parry API could not be reached.";
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

/** An inline error for a failed read, with a retry. */
export function QueryError({ title, error, onRetry, className }: { title: string; error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-wrap items-start justify-between gap-3 rounded-xl border border-critical/35 bg-critical-soft px-4 py-3.5", className)}>
      <div className="flex min-w-0 gap-3">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0 text-critical">
          <path d="M5.1 1.2 H10.9 L14.8 5.1 V10.9 L10.9 14.8 H5.1 L1.2 10.9 V5.1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 4.6 V8.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.1" r="0.95" fill="currentColor" />
        </svg>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg">{title}</p>
          <p className="mt-0.5 text-[13px] [overflow-wrap:anywhere] leading-5 text-muted">{errorMessage(error)}</p>
        </div>
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** A quiet note: context the person should know, never an error. */
export function Note({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "caution" | "brass"; className?: string }) {
  return (
    <div
      className={cn(
        "flex gap-3 rounded-xl border px-4 py-3 text-[13px] leading-5",
        tone === "caution" ? "border-caution/35 bg-caution-soft text-fg" : tone === "brass" ? "border-brass/35 bg-brass-soft text-fg" : "border-line bg-surface text-muted",
        className,
      )}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={cn("mt-0.5 shrink-0", tone === "caution" ? "text-caution" : "text-brass")}>
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 7.2 V11.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A small mono label above a group, as on the landing panels. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("label", className)}>{children}</p>;
}

/** A small choice among a few options, as a radio group (styled like the theme switcher). */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const pillId = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-lg border border-line bg-surface p-0.5", className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = options[(i + step + options.length) % options.length];
              if (!next) return;
              onChange(next.value);
              const sibling = e.currentTarget.parentElement?.children[(i + step + options.length) % options.length];
              if (sibling instanceof HTMLElement) sibling.focus();
            }}
            className={cn(
              "relative inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-semibold transition-colors",
              checked ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {checked ? (
              // The selection pill slides to the chosen option.
              <m.span
                layoutId={pillId}
                aria-hidden="true"
                className="absolute inset-0 rounded-md bg-raised shadow-[0_0_0_1px_var(--parry-line)]"
                transition={{ type: "spring", stiffness: 460, damping: 36, mass: 0.6 }}
              />
            ) : null}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
