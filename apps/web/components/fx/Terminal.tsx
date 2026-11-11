"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export type TerminalLine = { kind: "cmd" | "out" | "comment"; text: string };

/**
 * A terminal that types its commands when it scrolls into view, then prints each command's output.
 * Reduced motion (and no JavaScript) shows the whole transcript at once.
 */
export function Terminal({ lines, title = "Terminal", className }: { lines: readonly TerminalLine[]; title?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{ line: number; chars: number }>({ line: lines.length, chars: 0 });
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting || started.current) return;
      started.current = true;
      io.disconnect();
      let line = 0;
      let chars = 0;
      const tick = () => {
        const l = lines[line];
        if (!l) return;
        if (l.kind === "cmd" && chars < l.text.length) {
          chars += 1;
          setShown({ line, chars });
          timer = window.setTimeout(tick, 22 + Math.random() * 28);
          return;
        }
        line += 1;
        chars = 0;
        setShown({ line, chars });
        timer = window.setTimeout(tick, l.kind === "cmd" ? 380 : 90);
      };
      setShown({ line: 0, chars: 0 });
      timer = window.setTimeout(tick, 300);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [lines]);

  return (
    <div ref={ref} className={cn("surface-raised overflow-hidden", className)} role="figure" aria-label={title}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="ml-2 text-xs text-muted">{title}</span>
      </div>
      <pre className="num overflow-x-auto px-5 py-4 text-[13px] leading-6">
        {lines.map((l, i) => {
          if (i > shown.line) return null;
          const text = i === shown.line && l.kind === "cmd" ? l.text.slice(0, shown.chars) : i === shown.line ? "" : l.text;
          if (i === shown.line && l.kind !== "cmd") return null;
          return (
            <div key={i} className={cn(l.kind === "cmd" ? "text-fg" : l.kind === "comment" ? "text-muted" : "text-fg/75")}>
              {l.kind === "cmd" ? <span className="select-none text-brass">$ </span> : null}
              {text}
              {i === shown.line ? <span className="caret ml-0.5" aria-hidden="true" /> : null}
            </div>
          );
        })}
        {shown.line >= lines.length ? (
          <div>
            <span className="select-none text-brass">$ </span>
            <span className="caret" aria-hidden="true" />
          </div>
        ) : null}
      </pre>
    </div>
  );
}
