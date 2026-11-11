"use client";

import { useRef, type ReactNode, type PointerEvent } from "react";

/**
 * A subtle magnetic pull: the child drifts up to `strength` px toward the cursor while it is over
 * the wrapper, and springs back on leave. Only for fine pointers; reduced motion keeps it still.
 */
export function Magnetic({ children, strength = 6 }: { children: ReactNode; strength?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const move = (e: PointerEvent<HTMLSpanElement>) => {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * strength;
    const dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * strength;
    el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
  };
  const leave = () => {
    if (ref.current) ref.current.style.transform = "";
  };
  return (
    <span
      ref={ref}
      onPointerMove={move}
      onPointerLeave={leave}
      className="inline-flex transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)] will-change-transform"
    >
      {children}
    </span>
  );
}
