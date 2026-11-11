"use client";

import Lenis from "lenis";
import { useEffect } from "react";

/**
 * Smooth, eased scrolling for the public site (Lenis), anchor links included. It stays off when the
 * viewer asks for reduced motion, and dialogs opt out with `data-lenis-prevent`.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ autoRaf: true, lerp: 0.12, anchors: { offset: -88 } });
    return () => lenis.destroy();
  }, []);
  return null;
}
