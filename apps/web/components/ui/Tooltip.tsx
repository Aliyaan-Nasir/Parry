"use client";

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

type TriggerProps = {
  "aria-describedby"?: string;
};

export type TooltipProps = {
  /** Short supporting text; never the only place important information lives. */
  content: ReactNode;
  /** One focusable element (a button or link). */
  children: ReactElement<TriggerProps>;
  side?: "top" | "bottom";
  /** Hover delay in milliseconds; focus shows it at once. */
  delay?: number;
  className?: string;
};

const GAP = 8;
const EDGE = 8;

/** Shows on hover and keyboard focus, hides on Escape, pointer leave or blur. */
export function Tooltip({ content, children, side = "top", delay = 150, className }: TooltipProps) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: "top" | "bottom" } | null>(null);

  const show = useCallback(
    (immediate: boolean) => {
      window.clearTimeout(timer.current);
      if (immediate) setOpen(true);
      else timer.current = window.setTimeout(() => setOpen(true), delay);
    },
    [delay],
  );
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapRef.current?.firstElementChild ?? wrapRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;
    const r = trigger.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let place = side;
    if (place === "top" && r.top - t.height - GAP < EDGE) place = "bottom";
    if (place === "bottom" && r.bottom + t.height + GAP > window.innerHeight - EDGE) place = "top";
    const top = place === "top" ? r.top - t.height - GAP : r.bottom + GAP;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - EDGE);
    setPos({ top, left, side: place });
  }, [open, side, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  // Hidden routes keep their state; close the tooltip when this one is hidden or unmounted.
  useLayoutEffect(() => () => window.clearTimeout(timer.current), []);

  const describedBy = [children.props["aria-describedby"], open ? id : null].filter(Boolean).join(" ") || undefined;

  return (
    <span
      ref={wrapRef}
      className="inline-flex"
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") show(false);
      }}
      onPointerLeave={hide}
      onFocus={(e) => {
        if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) show(true);
      }}
      onBlur={hide}
    >
      {cloneElement(children, { "aria-describedby": describedBy })}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
              className={cn(
                "pointer-events-none fixed z-[70] max-w-64 rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium leading-5 text-bg",
                "motion-safe:animate-fade-in",
                className,
              )}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
