"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * True when the person asked for reduced motion. On the server, and during hydration, it reports
 * true, so nothing starts moving before the real preference is known.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}

export function prefersReducedMotion(): boolean {
  return typeof window === "undefined" || window.matchMedia(QUERY).matches;
}
