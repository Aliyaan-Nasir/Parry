import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  /** A small line icon; the brand mark's hairline style suits it best. */
  icon?: ReactNode;
  /** Usually one Button or ButtonLink. */
  action?: ReactNode;
  /** Tighter spacing for use inside cards. */
  compact?: boolean;
  /** Heading level of the title; h2 under a page title, h3 inside a card. */
  titleAs?: "h2" | "h3";
  className?: string;
};

export function EmptyState({ title, description, icon, action, compact = false, titleAs: Title = "h2", className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed border-line-strong text-center",
        compact ? "gap-3 px-5 py-8" : "gap-4 px-6 py-14 sm:py-20",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-muted" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <div className="max-w-md">
        <Title className={cn("font-display font-semibold tracking-[-0.01em] text-fg", compact ? "text-lg" : "text-xl sm:text-[22px]")}>{title}</Title>
        {description ? <p className="mt-2 text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
