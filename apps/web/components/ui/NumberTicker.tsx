"use client";

import { useEffect, useRef, useState } from "react";
import { formatInteger, formatUsdCompact } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/cn";

export type NumberFormat = "integer" | "usdCompact" | ((value: number) => string);

export type NumberTickerProps = {
  value: number;
  /** Where the first animation starts from. */
  from?: number;
  format?: NumberFormat;
  /** Animation length in milliseconds. */
  duration?: number;
  className?: string;
};

function formatter(format: NumberFormat): (value: number) => string {
  if (format === "integer") return formatInteger;
  if (format === "usdCompact") return formatUsdCompact;
  return format;
}

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

/**
 * Counts to `value` in the mono face. The box is reserved at the final width (mono digits are
 * all one width), so nothing around it moves. Screen readers get the final value only.
 * Under reduced motion the value is shown at once.
 */
export function NumberTicker({ value, from = 0, format = "integer", duration = 1200, className }: NumberTickerProps) {
  const fmt = formatter(format);
  const [shown, setShown] = useState(from);
  const current = useRef(from);

  useEffect(() => {
    const start = current.current;
    if (start === value || prefersReducedMotion()) {
      current.current = value;
      const id = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(id);
    }
    let frame = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = start + (value - start) * easeOutQuint(t);
      current.current = v;
      setShown(v);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  const finalText = fmt(value);
  return (
    <span className={cn("num inline-block text-left", className)} style={{ minWidth: `${finalText.length}ch` }}>
      <span aria-hidden="true">{fmt(shown)}</span>
      <span className="sr-only">{finalText}</span>
    </span>
  );
}
