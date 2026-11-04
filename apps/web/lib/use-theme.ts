"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  currentResolvedTheme,
  readPreference,
  setPreference,
  subscribeTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

/**
 * The theme as the page shows it. `preference` is what the person chose ("system" until they
 * choose); `resolved` is null on the server and during hydration, then "light" or "dark".
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme | null;
  setPreference: (p: ThemePreference) => void;
} {
  const preference = useSyncExternalStore<ThemePreference>(subscribeTheme, readPreference, () => "system");
  const resolved = useSyncExternalStore<ResolvedTheme | null>(subscribeTheme, currentResolvedTheme, () => null);
  const set = useCallback((p: ThemePreference) => setPreference(p), []);
  return { preference, resolved, setPreference: set };
}
