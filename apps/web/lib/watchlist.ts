"use client";

import { useCallback, useSyncExternalStore } from "react";

/** The tokens shown in the app's watchlist bar, stored per browser profile (and per account once signed in). */
export const WATCHLIST_KEY = "parry-watchlist";
const EVENT = "parry-watchlist-change";
export const DEFAULT_WATCHLIST = ["NEAR", "LINEAR", "STNEAR", "USDC"] as const;

function read(): string {
  try {
    return localStorage.getItem(WATCHLIST_KEY) ?? DEFAULT_WATCHLIST.join(",");
  } catch {
    return DEFAULT_WATCHLIST.join(",");
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useWatchlist(): [string[], (next: string[]) => void] {
  const raw = useSyncExternalStore(subscribe, read, () => DEFAULT_WATCHLIST.join(","));
  const set = useCallback((next: string[]) => {
    try {
      localStorage.setItem(WATCHLIST_KEY, next.join(","));
    } catch {}
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [raw.split(",").filter(Boolean), set];
}
