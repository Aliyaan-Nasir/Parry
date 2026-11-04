import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SkeletonProps = {
  /** Width as a CSS length ("6ch", "100%"); defaults to the full width. */
  width?: string;
  /** Height as a CSS length; defaults to one line of the surrounding text (1lh), so swaps never shift. */
  height?: string;
  /** Pill corners for text, rounded rectangle for blocks. */
  shape?: "text" | "block" | "circle";
  className?: string;
};

/** A quiet placeholder that holds the exact space of the content it stands in for. */
export function Skeleton({ width = "100%", height, shape = "text", className }: SkeletonProps) {
  // A text skeleton fills one line box exactly: 0.9 of the line high, with the rest as margin.
  const lineFill = shape === "text" && height === undefined;
  const style: CSSProperties = {
    width,
    height: height ?? (lineFill ? "0.9lh" : "1lh"),
    marginBlock: lineFill ? "0.05lh" : undefined,
  };
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "inline-block max-w-full bg-hover align-top motion-safe:animate-shimmer",
        shape === "text" && "rounded-md",
        shape === "block" && "rounded-lg",
        shape === "circle" && "rounded-full",
        className,
      )}
    />
  );
}

export type SkeletonSwapProps = {
  /** True once the content can render; until then the fallback holds its place. */
  ready: boolean;
  /** Usually one or more Skeletons sized like the content. */
  fallback: ReactNode;
  children?: ReactNode;
  className?: string;
};

/**
 * Hands over from a skeleton to content in place: both share one grid cell, so the box keeps
 * its size, and the content fades in instead of popping.
 */
export function SkeletonSwap({ ready, fallback, children, className }: SkeletonSwapProps) {
  return (
    <span className={cn("inline-grid [&>*]:[grid-area:1/1]", className)} aria-busy={ready ? undefined : true}>
      {ready ? <span className="min-w-0 animate-fade-in">{children}</span> : <span className="min-w-0">{fallback}</span>}
    </span>
  );
}
