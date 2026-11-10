"use client";

// Small values kept in localStorage (the connected wallet, the passkey, the selected account),
// read through useSyncExternalStore so the server render and hydration agree: until the browser
// has read storage the value is `undefined`.

import { useSyncExternalStore } from "react";

export type StoredValue<T> = {
  read: () => T | null;
  write: (value: T | null) => void;
  subscribe: (onChange: () => void) => () => void;
  /** The value, or undefined during the server render and hydration. */
  use: () => T | null | undefined;
};

export function storedValue<T>(key: string, valid: (v: unknown) => v is T): StoredValue<T> {
  const event = `${key}-change`;
  let lastRaw: string | null | undefined;
  let lastValue: T | null = null;
  // Kept in memory as well, in case storage is unavailable (private windows, blocked site data).
  let memory: string | null | undefined;

  const raw = (): string | null => {
    if (memory !== undefined) return memory;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const read = (): T | null => {
    const r = raw();
    if (r === lastRaw) return lastValue;
    lastRaw = r;
    let parsed: unknown = null;
    try {
      parsed = r === null ? null : JSON.parse(r);
    } catch {
      parsed = null;
    }
    lastValue = valid(parsed) ? parsed : null;
    return lastValue;
  };

  const write = (value: T | null) => {
    const r = value === null ? null : JSON.stringify(value);
    memory = r;
    try {
      if (r === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, r);
      memory = undefined;
    } catch {
      // Keep the in-memory copy.
    }
    window.dispatchEvent(new Event(event));
  };

  const subscribe = (onChange: () => void) => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) onChange();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(event, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(event, onChange);
    };
  };

  const use = () => useSyncExternalStore<T | null | undefined>(subscribe, read, () => undefined);

  return { read, write, subscribe, use };
}

export const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
