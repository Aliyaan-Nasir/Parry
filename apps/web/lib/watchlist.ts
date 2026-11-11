"use client";

import { useCallback, useSyncExternalStore } from "react";

/** The tokens shown in the app's watchlist bar, in the viewer's order, stored per account in this browser. */
export const WATCHLIST_KEY = "parry-watchlist";
const EVENT = "parry-watchlist-change";
export const DEFAULT_WATCHLIST = ["NEAR", "LINEAR", "STNEAR", "USDC"] as const;

const keyFor = (account: string | null | undefined) => (account ? `${WATCHLIST_KEY}:${account}` : WATCHLIST_KEY);

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(WATCHLIST_KEY) ?? DEFAULT_WATCHLIST.join(",");
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

/** The connected account's own list (each account keeps its own), falling back to this browser's. */
export function useWatchlist(account?: string | null): [string[], (next: string[]) => void] {
  const key = keyFor(account);
  const raw = useSyncExternalStore(subscribe, () => read(key), () => DEFAULT_WATCHLIST.join(","));
  const set = useCallback(
    (next: string[]) => {
      try {
        localStorage.setItem(key, next.join(","));
      } catch {}
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [raw.split(",").filter(Boolean), set];
}
