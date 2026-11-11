"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import type { Alert } from "@parry/sdk";
import { AccountGate } from "@/components/app/AccountGate";
import { errorMessage, Note, QueryError, Segmented } from "@/components/app/bits";
import { AlertRow, newestFirst } from "@/components/app/Feeds";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { Mark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/parry";
import { keys, useAlerts } from "@/lib/queries";
import { useIncidents } from "@/lib/live";
import { useNow } from "@/lib/use-now";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";

type Filter = "open" | "acknowledged" | "resolved" | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function Actions({ alert, account, signer }: { alert: Alert; account: string; signer: Signer }) {
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"ack" | "resolve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);
  if (alert.status === "resolved") return null;
  const canAct = signer !== "watch";

  const run = async (kind: "ack" | "resolve") => {
    setBusy(kind);
    setError(null);
    try {
      await acct.withSignIn((token) => (kind === "ack" ? api.ackAlert(alert.id, token) : api.resolveAlert(alert.id, token)));
      await queryClient.invalidateQueries({ queryKey: keys.alerts(account) });
      toast({ title: kind === "ack" ? "Alert acknowledged" : "Alert resolved", tone: "success" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {alert.status === "open" ? (
          <Button size="sm" variant="secondary" disabled={!canAct || busy === "resolve"} loading={busy === "ack"} loadingLabel="Acknowledging" onClick={() => void run("ack")}>
            Acknowledge
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={!canAct || busy === "ack"} loading={busy === "resolve"} loadingLabel="Resolving" onClick={() => void run("resolve")}>
          Resolve
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Alerts that belong together (one fall in health raising several), grouped by the API into incidents. */
function Incidents({ account }: { account: string }) {
  const q = useIncidents(account);
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <section className="surface overflow-hidden p-0" aria-labelledby="incidents-title">
      <div className="flex items-end justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id="incidents-title" className="text-[15px] text-fg">
          Incidents
        </h2>
        <span className="text-[12.5px] text-muted">Alerts within 15 minutes of each other, grouped</span>
      </div>
      <ul className="divide-y divide-line">
        {list.map((i) => (
          <li key={i.id}>
            <button type="button" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)} className="grid w-full grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-4 px-5 py-3 text-left hover:bg-hover">
              <span className={cn("text-[13px]", i.severity === "critical" ? "text-critical" : i.severity === "warning" ? "text-caution" : "text-muted")}>{i.severity === "critical" ? "Critical" : i.severity === "warning" ? "Warning" : "Info"}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm text-fg">{i.title}</span>
                <span className="block truncate text-[12.5px] text-muted">{i.body}</span>
              </span>
              <span className="text-right text-[12.5px] text-muted">
                {i.alerts.length} {i.alerts.length === 1 ? "alert" : "alerts"}
                <span className="block">{i.closedAt ? "closed" : now ? `open ${formatRelativeTime(i.openedAt, now)}` : "open"}</span>
              </span>
            </button>
            {open === i.id ? (
              <ul className="grid gap-3 border-t border-line bg-fg/[0.02] px-5 py-4">
                {i.alerts.map((a) => (
                  <li key={a.id}>
                    <AlertRow alert={a} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountAlerts({ account, signer }: { account: string; signer: Signer }) {
  const { signedIn } = useParryAccount();
  const [filter, setFilter] = useState<Filter>("open");
  const q = useAlerts(account);
  const all = newestFirst(q.data ?? []);
  const shown = filter === "all" ? all : all.filter((a) => a.status === filter);
  const counts = { open: all.filter((a) => a.status === "open").length };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{q.data ? `${counts.open} open of ${all.length}` : "Loading"}</p>
        <Segmented label="Show alerts" options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      <Incidents account={account} />

      {signer === "watch" ? (
        <Note>You are watching this account. Acknowledging and resolving alerts needs its owner&apos;s wallet or passkey.</Note>
      ) : !signedIn ? (
        <Note>Acknowledging or resolving asks your {signer === "wallet" ? "wallet to sign a message" : "passkey"} once to sign in; the session stays in this tab only.</Note>
      ) : null}

      {q.isPending ? (
        <Card className="grid content-start gap-4" aria-busy="true">
          <span className="sr-only">Loading alerts</span>
          <Skeleton width="50%" />
          <Skeleton width="80%" />
          <Skeleton width="40%" />
        </Card>
      ) : q.isError ? (
        <QueryError title="Alerts could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : shown.length === 0 ? (
        <EmptyState
          compact
          icon={<Mark size={22} />}
          title={filter === "open" ? "No open alerts" : "Nothing here"}
          description="Parry raises an alert when a position crosses your thresholds for risk score, health or cascade pressure. Change them in Settings."
        />
      ) : (
        <Card as="section" padding="none" aria-label="Alerts">
          <ul className="divide-y divide-line">
            {shown.map((a) => (
              <li key={a.id} className="px-5 py-4 sm:px-6">
                <AlertRow alert={a} actions={a.status !== "resolved" ? <Actions alert={a} account={account} signer={signer} /> : undefined} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export function AlertsList() {
  return (
    <AccountGate title="Connect an account to see its alerts" description="Alerts arrive here, and by push, Telegram or email if you turn those on in Settings.">
      {({ account, signer }) => <AccountAlerts account={account} signer={signer} />}
    </AccountGate>
  );
}
