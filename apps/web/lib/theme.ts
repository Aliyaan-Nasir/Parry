// Theme: the <html> element carries data-theme="light" | "dark". The person's choice is kept in
// localStorage under THEME_STORAGE_KEY ("light", "dark", or absent for "follow the system").
// An inline script in <head> applies it before the first paint, so there is no flash.

import tokens from "@parryguard/brand";

export const THEME_STORAGE_KEY = "parry-theme";
export const THEME_EVENT = "parry-theme-change";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_BG: Record<ResolvedTheme, string> = {
  light: tokens.light.bg,
  dark: tokens.dark.bg,
};

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemDark ? "dark" : "light";
}

export function parsePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Runs in <head> before paint. Kept tiny and dependency free. */
export const themeScript = `(function(){try{var d=document.documentElement,k=${JSON.stringify(THEME_STORAGE_KEY)},p=null;try{p=localStorage.getItem(k)}catch(e){}var t=p==="light"||p==="dark"?p:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");d.dataset.theme=t;d.style.colorScheme=t;var c=t==="dark"?${JSON.stringify(THEME_BG.dark)}:${JSON.stringify(THEME_BG.light)};document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",c)})}catch(e){}})();`;

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readPreference(): ThemePreference {
  try {
    return parsePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_BG[resolved]));
  return resolved;
}

export function setPreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this page only.
  }
  applyTheme(preference);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Subscribes to choice changes in this tab, other tabs and the system color scheme. */
export function subscribeTheme(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => {
    if (readPreference() === "system") applyTheme("system");
    onChange();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    applyTheme(readPreference());
    onChange();
  };
  media.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    media.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

export function currentResolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
