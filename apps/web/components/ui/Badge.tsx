import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "brass" | "safe" | "caution" | "danger" | "critical";

// A status is a plain word, not a pill: the tone only sets the text color, and risk colors are
// reserved for the risk instrument (critical stays for real failures).
const soft: Record<BadgeTone, string> = {
  neutral: "text-muted",
  brass: "text-brass",
  safe: "text-fg",
  caution: "text-fg",
  danger: "text-fg",
  critical: "text-critical",
};

const outline = soft;

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  variant?: "soft" | "outline";
  size?: "sm" | "md";
};

export function Badge({ tone = "neutral", variant = "soft", size = "sm", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap [&>.rounded-full.bg-current]:hidden",
        size === "sm" ? "text-[12.5px]" : "text-[13.5px]",
        variant === "soft" ? soft[tone] : outline[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
