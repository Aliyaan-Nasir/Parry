import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "brass" | "safe" | "caution" | "danger" | "critical";

const soft: Record<BadgeTone, string> = {
  neutral: "bg-hover text-fg border-line",
  brass: "bg-brass-soft text-brass border-[color-mix(in_oklab,var(--parry-brass)_28%,transparent)]",
  safe: "bg-safe-soft text-safe border-[color-mix(in_oklab,var(--parry-safe)_28%,transparent)]",
  caution: "bg-caution-soft text-caution border-[color-mix(in_oklab,var(--parry-caution)_30%,transparent)]",
  danger: "bg-danger-soft text-danger border-[color-mix(in_oklab,var(--parry-danger)_28%,transparent)]",
  critical: "bg-critical-soft text-critical border-[color-mix(in_oklab,var(--parry-critical)_28%,transparent)]",
};

const outline: Record<BadgeTone, string> = {
  neutral: "border-line-strong text-muted",
  brass: "border-brass text-brass",
  safe: "border-safe text-safe",
  caution: "border-caution text-caution",
  danger: "border-danger text-danger",
  critical: "border-critical text-critical",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  variant?: "soft" | "outline";
  size?: "sm" | "md";
};

export function Badge({ tone = "neutral", variant = "soft", size = "sm", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold",
        size === "sm" ? "h-6 px-2.5 text-xs" : "h-7 px-3 text-[13px]",
        variant === "soft" ? soft[tone] : outline[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
