"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState, type FormEvent } from "react";
import { ParryApiError } from "@parry/sdk";
import Link from "next/link";
import { DataList, DataRow, errorMessage, QueryError } from "@/components/app/bits";
import { DecisionRow, FeedLink } from "@/components/app/Feeds";
import { HealthValue, positionHref } from "@/components/app/PositionsTable";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { Slider } from "@/components/ui/Slider";
import { TierBadge } from "@/components/ui/TierBadge";
import { useToast } from "@/components/ui/Toast";
import type { ShockState } from "@/lib/api-types";
import { explorerUrl } from "@/lib/explorer";
import { api } from "@/lib/parry";
import { keys, PACE, useDecisions, useOracleStatus, usePositions, useShock } from "@/lib/queries";
import { formatDateTime, formatDuration, formatUntil } from "@/lib/units";
import { useNow } from "@/lib/use-now";

/** The oracle's fixed limits (contracts/oracle): how long a shock lasts and how often one may be applied. */
const SHOCK_MINUTES = 30;
const PER_CALLER_SECONDS = 60;
const PER_FEED_SECONDS = 10;

function priceOf(raw: string, expo: number): number {
  return Number(raw) * 10 ** expo;
}

/** The contract's refusal, in plain words: "next at <unix seconds>" becomes a wait. */
function shockError(e: unknown, nowMs: number): string {
  const text = errorMessage(e);
  const next = /next at (\d+)/.exec(text);
  if (next) {
    const wait = Math.max(1, Math.round(Number(next[1]) - nowMs / 1000));
    const who = /per price id/.test(text) ? "The price feed takes one shock" : "Parry's relayer applies one shock";
    return `${who} ${/per price id/.test(text) ? `every ${PER_FEED_SECONDS} s` : "a minute"}: try again in ${wait} s.`;
  }
  return text;
}

function ClearShock() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);
  return (
    <div className="grid gap-2 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          loading={busy}
          loadingLabel="Clearing the shock"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.applyShock(0);
              await queryClient.invalidateQueries({ queryKey: keys.shock });
              toast({
                title: "Shock cleared",
                description: "The oracle serves the market price again.",
                tone: "success",
                ...(r.txHash && explorerUrl("nearblocks", r.txHash) ? { explorer: { kind: "nearblocks" as const, hash: r.txHash } } : {}),
              });
            } catch (e) {
              setError(shockError(e, now ?? 0));
            } finally {
              setBusy(false);
            }
          }}
        >
          Clear the shock
        </Button>
        <span className="text-[13px] text-muted">Back to the market price at once.</span>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Price({ state }: { state: ShockState }) {
  const { format } = useMoney();
  const now = useNow();
  const expo = state.price?.expo ?? -8;
  const s = state.shock;
  const current = state.price ? priceOf(state.price.price, expo) : null;
  return (
    <Card as="section" aria-labelledby="price-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="price-title">Test oracle</span>}
        description="The NEAR price Rhea lending and the guardian read on testnet."
        actions={s ? <Badge tone={s.bps < 0 ? "critical" : "caution"}>Shock {s.bps > 0 ? "+" : ""}{s.bps / 100}%</Badge> : <Badge tone="safe">No shock</Badge>}
      />
      <p className="num text-[32px] font-medium leading-10 tracking-[-0.02em] text-fg">{current !== null ? format(current) : "n/a"}</p>
      {s ? (
        <DataList>
          <DataRow label="Market price">
            <span className="num">{format(priceOf(s.fed_price, expo))}</span>
          </DataRow>
          <DataRow label="Shocked price">
            <span className="num">{format(priceOf(s.shocked_price, expo))}</span>
          </DataRow>
          <DataRow label="Applied">
            <span className="text-[13px]">{formatDateTime(s.at)}</span>
          </DataRow>
          <DataRow label="Ends by itself">
            <span className="text-[13px]">
              {formatDateTime(s.expires_at)}
              {now ? <span className="text-muted">, {formatUntil(s.expires_at, now)}</span> : null}
            </span>
          </DataRow>
        </DataList>
      ) : (
        <p className="text-sm text-muted">The oracle serves the market price as fed by Parry&apos;s keepers.</p>
      )}
      {s ? <ClearShock /> : null}
    </Card>
  );
}

function Apply({ maxBps, active }: { maxBps: number | null; active: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow();
  const limit = Math.min(40, Math.floor((maxBps ?? 4000) / 100));
  const [pct, setPct] = useState(-20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);
  const value = Math.max(-limit, Math.min(limit, pct));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (value === 0) return setError("Pick a move other than 0%.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.applyShock(value * 100);
      await queryClient.invalidateQueries({ queryKey: keys.shock });
      toast({
        title: `NEAR moved ${value > 0 ? "+" : ""}${value}% on the test oracle`,
        description: "Positions are rescored within seconds.",
        tone: "success",
        ...(r.txHash && explorerUrl("nearblocks", r.txHash) ? { explorer: { kind: "nearblocks" as const, hash: r.txHash } } : {}),
      });
    } catch (e2) {
      setError(e2 instanceof ParryApiError || e2 instanceof Error ? shockError(e2, now ?? 0) : errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" aria-labelledby="apply-title" className="grid content-start gap-5">
      <CardHeader titleAs="h2" title={<span id="apply-title">Move the price</span>} description="Relative to the market price, never compounding: a new shock replaces the active one." />
      <form onSubmit={onSubmit} className="grid gap-5">
        <Slider
          label="Move"
          min={-limit}
          max={limit}
          step={1}
          value={value}
          formatValue={(v) => `${v > 0 ? "+" : ""}${v}%`}
          onValueChange={setPct}
          description={`From −${limit}% to +${limit}%.`}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={busy} loadingLabel="Applying the shock" disabled={value === 0}>
            {active ? "Replace the shock" : "Apply the shock"}
          </Button>
          <span className="text-[13px] text-muted">Parry&apos;s relayer pays the gas.</span>
        </div>
        {error ? (
          <p role="alert" className="text-[13px] font-medium text-critical">
            {error}
          </p>
        ) : null}
      </form>
      <ul className="grid gap-1.5 border-t border-line pt-4 text-[13px] leading-5 text-muted">
        <li>The oracle bounds a shock at {maxBps !== null ? `${maxBps / 100}%` : "its configured maximum"} either way.</li>
        <li>
          It takes one shock per caller every {PER_CALLER_SECONDS} s (all shocks here come from Parry&apos;s relayer), one per feed every {PER_FEED_SECONDS} s, and the relayer adds a
          daily limit per visitor.
        </li>
        <li>A shock lasts {SHOCK_MINUTES} minutes and then ends by itself; clear it sooner from the price card.</li>
      </ul>
    </Card>
  );
}

function Watch({ account }: { account: string }) {
  const positions = usePositions(account, PACE.shock);
  const decisions = useDecisions(account, 3);
  const { format } = useMoney();
  const latest = decisions.data?.pages[0]?.items[0] ?? null;
  return (
    <Card as="section" aria-labelledby="watch-title" className="grid content-start gap-5">
      <CardHeader
        titleAs="h2"
        title={<span id="watch-title">Your position, live</span>}
        description="Refreshed every 5 seconds. Push the price down and watch the guardian step in."
        actions={<FeedLink href="/app/guardian">Guardian log</FeedLink>}
      />
      {positions.isError && !positions.data ? (
        <QueryError title="Your positions could not be loaded" error={positions.error} onRetry={() => void positions.refetch()} />
      ) : !positions.data ? (
        <Skeleton height="5rem" shape="block" />
      ) : positions.data.length === 0 ? (
        <p className="text-sm text-muted">
          This account has no position yet.{" "}
          <Link href="/app/open" className="font-semibold text-brass underline-offset-4 hover:underline">
            Open one
          </Link>{" "}
          to watch a rescue.
        </p>
      ) : (
        <ul className="grid gap-3" aria-live="polite">
          {positions.data.map((p) => (
            <li key={p.id}>
              <Link href={positionHref(p.id)} className="grid gap-3 rounded-xl border border-line p-4 transition-colors hover:bg-hover sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-6">
                <span className="text-sm font-semibold text-fg">{p.label}</span>
                <span className="grid">
                  <span className="text-[12px] text-muted">Health</span>
                  <HealthValue health={p.health} className="text-xl" />
                </span>
                <span className="grid">
                  <span className="text-[12px] text-muted">Liquidation</span>
                  <span className="num text-sm text-fg">{p.liqPrice !== null ? format(p.liqPrice) : "None"}</span>
                </span>
                <span className="grid justify-items-start gap-1">
                  <TierBadge tier={p.tier} score={p.score} />
                  <span className="num text-[12px] text-muted">{formatDuration(p.ttlHours)} left</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 border-t border-line pt-4">
        <p className="text-[13px] font-semibold text-fg">Latest guardian decision</p>
        {latest ? <DecisionRow decision={latest} /> : <p className="text-[13px] text-muted">None yet on this account.</p>}
      </div>
    </Card>
  );
}

export function ShockView() {
  const { account, ready, setConnectOpen } = useParryAccount();
  const q = useShock();
  const oracle = useOracleStatus();
  if (q.isError && !q.data) return <QueryError title="The test oracle could not be read" error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="grid gap-6" data-stagger>
      <div className="grid gap-6 lg:grid-cols-2">
        {q.data ? (
          <Price state={q.data} />
        ) : (
          <Card>
            <Skeleton height="12rem" shape="block" />
          </Card>
        )}
        <Apply maxBps={oracle.data?.max_shock_bps ?? null} active={!!q.data?.shock} />
      </div>
      {account ? (
        <Watch account={account} />
      ) : ready ? (
        <Card className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-fg">Watch a rescue on your own position</h2>
            <p className="mt-1 text-sm text-muted">Connect an account with a protected position to see its health react live.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConnectOpen(true)}>Connect</Button>
            <ButtonLink href="/app/guardian" variant="ghost">
              Guardian log
            </ButtonLink>
          </div>
        </Card>
      ) : null}
      <p className="text-[13px] text-muted">
        The shock exists only on testnet: it moves Parry&apos;s own test oracle, never a real market, and the oracle refuses to run on mainnet.
      </p>
    </div>
  );
}
