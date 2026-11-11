"use client";

import { useCallback, useSyncExternalStore } from "react";

/** One account someone keeps an eye on: kept in this browser, and mirrored to the API for alerts when its viewer signs in. */
export type Watched = { account: string; label: string | null; thresholds: { score: number; health: number } };

export const WATCHED_KEY = "parry-watched";
const EVENT = "parry-watched-change";
export const DEFAULT_THRESHOLDS = { score: 60, health: 1.2 } as const;
const EMPTY = "[]";

function read(): string {
  try {
    return localStorage.getItem(WATCHED_KEY) ?? EMPTY;
  } catch {
    return EMPTY;
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

function parse(raw: string): Watched[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as Watched[]).filter((w) => typeof w?.account === "string") : [];
  } catch {
    return [];
  }
}

export function useWatched(): { list: Watched[]; save: (next: Watched[]) => void } {
  const raw = useSyncExternalStore(subscribe, read, () => EMPTY);
  const save = useCallback((next: Watched[]) => {
    try {
      localStorage.setItem(WATCHED_KEY, JSON.stringify(next));
    } catch {}
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { list: parse(raw), save };
}

/** The same rule the API alerts on: a risk score at or over the threshold, or health at or under it. */
export function watchState(pos: { score: number; health: number | null } | null, t: Watched["thresholds"]): "none" | "ok" | "alert" {
  if (!pos) return "none";
  return pos.score >= t.score || (pos.health !== null && pos.health <= t.health) ? "alert" : "ok";
}
