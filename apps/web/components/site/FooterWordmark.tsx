"use client";

import { Logo } from "@/components/brand/Logo";
import { useRevealed } from "@/components/fx/Reveal";

/** The wordmark across the whole footer, rising into view as the page ends. */
export function FooterWordmark() {
  const ref = useRevealed<HTMLDivElement>();
  return (
    <div ref={ref} aria-hidden="true" className="mx-auto max-w-[1400px] overflow-hidden px-4 pb-2 sm:px-6">
      <div className="translate-y-[35%] opacity-0 transition-[translate,opacity] duration-[1200ms] ease-[var(--ease-out)] in-data-[revealed=true]:translate-y-[8%] in-data-[revealed=true]:opacity-100 motion-reduce:translate-y-[8%] motion-reduce:opacity-100">
        <Logo height={400} className="h-auto w-full opacity-[0.92]" />
      </div>
    </div>
  );
}

