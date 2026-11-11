"use client";

import { useEffect, useRef, type ElementType, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Line-by-line masked text reveal: each line in `lines` slides up from behind its own mask when
 * the block scrolls into view, 80 ms apart. Reduced motion shows the text in place.
 */
export function RevealText({ lines, as: Tag = "h2", className }: { lines: readonly ReactNode[]; as?: ElementType; className?: string }) {
  const ref = useRevealed<HTMLElement>();
  return (
    <Tag ref={ref} className={className}>
      {lines.map((line, i) => (
        <span key={i} className="reveal-line" style={{ ["--i" as string]: i }}>
          <span>{line}</span>
        </span>
      ))}
    </Tag>
  );
}

/** Marks an element `data-revealed="true"` the first time it is a quarter visible. */
export function useRevealed<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          el.dataset.revealed = "true";
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** A block that fades and rises into place when it scrolls into view. */
export function Rise({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRevealed<HTMLDivElement>();
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "translate-y-4 opacity-0 transition-[opacity,translate] duration-[var(--dur-2)] ease-[var(--ease-out)] data-[revealed=true]:translate-y-0 data-[revealed=true]:opacity-100 motion-reduce:translate-y-0 motion-reduce:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
