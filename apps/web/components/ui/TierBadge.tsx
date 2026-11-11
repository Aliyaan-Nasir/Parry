import { TIER_LABEL, type Tier } from "@/lib/risk";
import { cn } from "@/lib/cn";

/** A distinct shape per tier, so the tier never depends on color alone. */
export function TierGlyph({ tier, size = 10, className }: { tier: Tier; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 10 10", "aria-hidden": true as const, className: cn("shrink-0", className) };
  switch (tier) {
    case "safe":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      );
    case "caution":
      return (
        <svg {...common}>
          <path d="M5 0.9 L9.3 8.9 H0.7 Z" fill="currentColor" />
        </svg>
      );
    case "danger":
      return (
        <svg {...common}>
          <path d="M5 0.4 L9.6 5 L5 9.6 L0.4 5 Z" fill="currentColor" />
        </svg>
      );
    case "critical":
      return (
        <svg {...common}>
          <path d="M3.2 0.6 H6.8 L9.4 3.2 V6.8 L6.8 9.4 H3.2 L0.6 6.8 V3.2 Z" fill="currentColor" />
          <rect x="4.3" y="2.3" width="1.4" height="3.6" rx="0.5" className="fill-raised" />
          <rect x="4.3" y="6.6" width="1.4" height="1.3" rx="0.5" className="fill-raised" />
        </svg>
      );
  }
}

export type TierBadgeProps = {
  tier: Tier;
  /** Optional 0 to 100 score shown after the label in mono. */
  score?: number;
  size?: "sm" | "md";
  className?: string;
};

/** The tier as a plain word in the text color (the instrument carries the color). */
export function TierBadge({ tier, score, size = "sm", className }: TierBadgeProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-fg/80", size === "sm" ? "text-[12.5px]" : "text-[13.5px]", className)}>
      <span>{TIER_LABEL[tier]}</span>
      {typeof score === "number" ? (
        <span className="num text-muted">
          <span className="sr-only">, score </span>
          {Math.round(score)}
        </span>
      ) : null}
    </span>
  );
}
