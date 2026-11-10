"use client";

import { useSyncExternalStore } from "react";

// One shared clock for relative times ("4 min ago", "expires in 12 min"): it ticks every few
// seconds while anything listens, and is null during the server render and hydration.

const TICK_MS = 5_000;
let now = 0;
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function snapshot(): number {
  if (now === 0) now = Date.now();
  return now;
}

/** The current time in milliseconds, refreshed every 5 seconds; null before hydration. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
