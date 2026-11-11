"use client";

import { useEffect } from "react";

const FIRST_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Smooth, eased scrolling for the public site (Lenis), anchor links included. Lenis loads on the
 * visitor's first wheel, touch or key press, so page load never pays for it; it stays off under
 * reduced motion, and dialogs opt out with `data-lenis-prevent`.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let lenis: { destroy: () => void } | null = null;
    let gone = false;
    const start = () => {
      for (const e of FIRST_INPUT) window.removeEventListener(e, start);
      void import("lenis").then(({ default: Lenis }) => {
        if (!gone) lenis = new Lenis({ autoRaf: true, lerp: 0.12, anchors: { offset: -88 } });
      });
    };
    for (const e of FIRST_INPUT) window.addEventListener(e, start, { passive: true, once: true });
    return () => {
      gone = true;
      for (const e of FIRST_INPUT) window.removeEventListener(e, start);
      lenis?.destroy();
    };
  }, []);
  return null;
}
