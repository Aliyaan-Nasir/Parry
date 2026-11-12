"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { QueryError, Segmented } from "@/components/app/bits";
import { DECISION_GRID, DecisionRow } from "@/components/app/DecisionCard";
import { cn } from "@/lib/cn";
import { useMoney } from "@/components/providers/MoneyProvider";
import { useSavings } from "@/lib/live";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { Mark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useDecisions } from "@/lib/queries";

type Scope = "mine" | "all";

function LogSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <span className="sr-only">Loading the guardian log</span>
      {[0, 1].map((i) => (
        <Card key={i} className="grid content-start gap-3">
          <Skeleton width="40%" height="1.4rem" />
          <Skeleton width="70%" />
          <Skeleton height="5rem" shape="block" />
        </Card>
      ))}
    </div>
  );
}

/** Every guardian decision, newest first: for the connected account, or for every account. */
export function GuardianLog() {
  const { account, ready } = useParryAccount();
  const [picked, setPicked] = useState<Scope | null>(null);
  const scope: Scope = picked ?? (account ? "mine" : "all");
  const q = useDecisions(scope === "mine" ? account : null, 10);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const params = useSearchParams();
  const wanted = params.get("decision");
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // The newest decision opens by default, or the one a link names (from a position's chart).
  const isOpen = (id: string, i: number) => opened[id] ?? (wanted ? wanted === id : i === 0);
  const savings = useSavings(scope === "mine" ? (account ?? undefined) : undefined);
  const { format } = useMoney();
  useEffect(() => {
    if (wanted && items.some((d) => d.id === wanted)) document.getElementById(`d-${wanted}`)?.scrollIntoView({ block: "start" });
  }, [wanted, items]);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {scope === "mine" ? "Decisions on your protected account." : "Decisions on every protected account, as published on the risk board."}
        </p>
        {account ? (
          <Segmented
            label="Show decisions for"
            options={[
              { value: "mine", label: "My account" },
              { value: "all", label: "All accounts" },
            ]}
            value={scope}
            onChange={setPicked}
          />
        ) : null}
      </div>

      {!ready || q.isPending ? (
        <LogSkeleton />
      ) : q.isError && items.length === 0 ? (
        <QueryError title="The guardian log could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Mark size={22} />}
          title="No guardian decisions yet"
          description={
            scope === "mine"
              ? "When your position crosses the thresholds sealed in your mandate, the guardian plans a rescue, has it reviewed and acts. Each decision appears here."
              : "No protected account has needed the guardian yet. Each decision appears here with its review and transactions."
          }
        />
      ) : (
        <div className="grid gap-4">
          <p className="text-[13px] text-muted">
            {items.length} {items.length === 1 ? "decision" : "decisions"} loaded, {items.filter((d) => d.outcome === "executed").length} executed
            {savings.data && savings.data.totalSavedUsd > 0 ? (
              <>
                , <span className="text-fg">{format(savings.data.totalSavedUsd)}</span> saved by picking the better rescue route
              </>
            ) : null}
            .
          </p>
          <div className="surface overflow-hidden p-0">
            <div className={cn("hidden gap-x-4 border-b border-line px-5 py-2.5 text-[12.5px] text-muted sm:grid", DECISION_GRID)}>
              <span>When</span>
              <span>Action</span>
              <span>Health</span>
              <span className="text-right">Route</span>
              <span className="text-right">Outcome</span>
              <span aria-hidden="true" />
            </div>
            {items.map((d, i) => (
              <DecisionRow key={d.id} decision={d} open={isOpen(d.id, i)} onToggle={() => setOpened((o) => ({ ...o, [d.id]: !isOpen(d.id, i) }))} />
            ))}
          </div>
        </div>
      )}

      {q.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="secondary" loading={q.isFetchingNextPage} loadingLabel="Loading older decisions" onClick={() => void q.fetchNextPage()}>
            Load older decisions
          </Button>
        </div>
      ) : null}
    </div>
  );
}
