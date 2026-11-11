"use client";

import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useParryAccount } from "./AccountProvider";
import { apiUrl } from "@/lib/env";
import { keys } from "@/lib/queries";

/** How the app hears about changes: the server's event stream, or polling while the stream is down. */
export type LiveState = { mode: "connecting" | "stream" | "polling"; events: number; lastEventAt: number | null; reconnects: number; since: number | null };

const LiveContext = createContext<LiveState>({ mode: "polling", events: 0, lastEventAt: null, reconnects: 0, since: null });

export const useLive = () => useContext(LiveContext);

const EVENTS = ["alert", "decision", "position", "price", "vault", "status"] as const;

/** What each event makes stale. Polling keeps running underneath at its own pace, so a missed event only delays a refresh. */
function staleFor(event: (typeof EVENTS)[number], account: string | null): QueryKey[] {
  switch (event) {
    case "alert":
      return account ? [keys.alerts(account), ["live", "incidents", account]] : [];
    case "decision":
      return [["decisions"], ["live", "savings"], ...(account ? [keys.account(account), keys.mandate(account)] : [])];
    case "position":
      return account ? [keys.positions(account), keys.account(account), keys.portfolio(account), ["history"]] : [];
    case "price":
      return [keys.market, ["live", "prices"]];
    case "vault":
      return [keys.vault, ["vault-history"], keys.reserves, ["live", "insurance"]];
    case "status":
      return [keys.status];
  }
}

/**
 * Opens one Server-Sent Events connection to the API for the selected account. While it is open,
 * every event refreshes exactly the reads it touches; when it drops, the browser reconnects with
 * backoff and the app keeps polling on each read's own interval, so nothing goes stale for long.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { account } = useParryAccount();
  const [state, setState] = useState<LiveState>({ mode: apiUrl ? "connecting" : "polling", events: 0, lastEventAt: null, reconnects: 0, since: null });

  useEffect(() => {
    // Without an API there is nothing to listen to (every browser the app supports has EventSource).
    if (!apiUrl || typeof EventSource === "undefined") return;
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const open = () => {
      const url = new URL(`${apiUrl}/v1/stream`);
      url.searchParams.set("events", EVENTS.join(","));
      if (account) url.searchParams.set("account", account);
      source = new EventSource(url.toString());
      source.onopen = () => {
        attempt = 0;
        setState((s) => ({ ...s, mode: "stream", since: Date.now() }));
      };
      for (const name of EVENTS) {
        source.addEventListener(name, () => {
          for (const key of staleFor(name, account)) void qc.invalidateQueries({ queryKey: key });
          setState((s) => ({ ...s, events: s.events + 1, lastEventAt: Date.now() }));
        });
      }
      source.onerror = () => {
        if (closed) return;
        // A closed source (a 404, or the API going away) does not retry by itself: back off and reopen.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          attempt += 1;
          setState((s) => ({ ...s, mode: "polling", reconnects: s.reconnects + 1, since: null }));
          retry = setTimeout(open, Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt)));
        } else setState((s) => ({ ...s, mode: "polling", since: null }));
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [account, qc]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}
