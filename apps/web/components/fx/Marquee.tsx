import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * An infinite row of items, duplicated once so the loop is seamless; paused on hover and still
 * for reduced motion. The edges fade into the page.
 */
export function Marquee({ items, reverse = false, seconds = 60, className, label }: { items: readonly ReactNode[]; reverse?: boolean; seconds?: number; className?: string; label: string }) {
  return (
    <div
      className={cn("marquee relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]", className)}
      role="list"
      aria-label={label}
    >
      <div className="marquee-track" data-reverse={reverse} style={{ ["--marquee-duration" as string]: `${seconds}s` }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1 ? true : undefined}>
            {items.map((item, i) => (
              <div key={i} role={copy === 0 ? "listitem" : undefined} className="shrink-0 px-7">
                {item}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
