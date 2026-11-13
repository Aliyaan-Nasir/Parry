"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { riskScore } from "@parryguard/core";
import type { Market, Position } from "@parryguard/sdk";
import { QueryError, Segmented } from "@/components/app/bits";
import { CloseFlow } from "@/components/app/CloseFlow";
import { Copilot } from "@/components/app/Copilot";
import { PageHeader } from "@/components/app/PageHeader";
import { guardianSentence } from "@/components/app/PositionCard";
import { Heatmap } from "@/components/instrument/Heatmap";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { SeriesChart } from "@/components/instrument/SeriesChart";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useHeatmap } from "@/lib/live";
import { readPolicy } from "@/lib/policy-memory";
import { useAccountSummary, useDecisions, useHistory, useMarket, usePositions } from "@/lib/queries";
import { formatDuration, formatPercent, formatProbability, shortId } from "@/lib/units";
import { useNow } from "@/lib/use-now";

const RANGES = [
  { value: 6, label: "6 h" },
  { value: 24, label: "24 h" },
  { value: 168, label: "7 days" },
] as const;

/** The risk score taken apart: S = 100 × (0.70 √P + 0.15 V + 0.15 C), with health floors. */
function ScoreParts({ position, market }: { position: Position; market: Market | undefined }) {
  if (!market) return <Skeleton height="7rem" shape="block" />;
  const s = riskScore({ health: position.health ?? Infinity, probability24h: position.probability24h, annualVol: market.tremor.annual, cascadePressure: market.cascade.pressure });
  const parts = [
    { name: "Liquidation probability", detail: `0.70 × √P(24 h), P = ${formatProbability(position.probability24h)}`, points: s.components.liquidation, max: 70 },
    { name: "Market turbulence", detail: `0.15 × Tremor above 30%, now ${formatPercent(market.tremor.annual, 0)}`, points: s.components.volatility, max: 15 },
    { name: "Cascade pressure", detail: `0.15 × pressure, now ${formatPercent(market.cascade.pressure, 1)}`, points: s.components.cascade, max: 15 },
  ];
  const sum = parts.reduce((t, p) => t + p.points, 0);
  const floor = position.health !== null && position.health < 1.1 ? (position.health < 1.03 ? 75 : 50) : null;
  return (
    <div className="grid gap-5">
      <ul className="grid gap-5 sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.name} className="grid content-start gap-1.5">
            <div className="flex items-end justify-between gap-3">
              <span className="text-sm text-fg">{p.name}</span>
              <span className="num text-sm text-fg">
                {p.points}
                <span className="text-muted"> / {p.max}</span>
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div className="h-full rounded-full bg-fg/55" style={{ width: `${(p.points / p.max) * 100}%` }} />
            </div>
            <p className="text-[12.5px] text-muted">{p.detail}</p>
          </li>
        ))}
      </ul>
      <p className="text-[13px] leading-5 text-muted">
        With the current market the parts add up to <span className="num text-fg">{sum}</span>
        {floor !== null ? (
          <>
            ; health below {floor === 75 ? "1.03" : "1.10"} sets a floor of <span className="num text-fg">{floor}</span>
          </>
        ) : null}
        . The scored figure, <span className="num text-fg">{position.score}</span>, is the risk engine&apos;s at {new Date(position.updatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}.
      </p>
    </div>
  );
}

function Detail({ position, account }: { position: Position; account: string }) {
  const [hours, setHours] = useState<number>(24);
  const [flow, setFlow] = useState<"close" | "unwind" | null>(null);
  const history = useHistory(position.id, hours);
  const summary = useAccountSummary(account);
  const decisions = useDecisions(account, 50);
  const market = useMarket();
  const map = useHeatmap("testnet");
  const { format } = useMoney();
  const now = useNow();
  const own = typeof window === "undefined" ? null : readPolicy(account);
  const acted = useMemo(() => (decisions.data?.pages.flatMap((p) => p.items) ?? []).filter((d) => d.outcome === "executed" && (d.venue === position.venue || ((d.venue as string) === "evm" && position.venue === "aave"))), [decisions.data, position.venue]);
  const points = useMemo(() => (history.data ?? []).filter((p) => p.health !== null).map((p) => ({ t: Date.parse(p.t) / 1000, v: p.health! })), [history.data]);
  const prices = useMemo(() => (history.data ?? []).map((p) => ({ t: Date.parse(p.t) / 1000, v: p.price })), [history.data]);
  const scores = useMemo(() => (history.data ?? []).map((p) => ({ t: Date.parse(p.t) / 1000, v: p.score })), [history.data]);
  const tremor = market.data?.tremor as { annual: number; regime?: string; level: string; windows: { hours: number; sigma: number }[] } | undefined;
  const price = market.data?.near.priceUsd ?? null;
  const triggerPrice = own && position.health && price ? (price * own.triggerHealth) / position.health : null;

  return (
    <div className="grid gap-8">
      <section className="surface p-6 sm:p-8">
        <RiskInstrument
          health={position.health}
          tier={position.tier}
          variant="hero"
          annualVol={tremor?.annual ?? null}
          trigger={own?.triggerHealth ?? null}
          target={own?.targetHealth ?? null}
          marks={acted.slice(0, 8).map((d) => ({ health: d.trigger.healthBps / 10_000, label: `${d.plan} (${new Date(d.createdAt).toLocaleString()})`, href: `/app/guardian?decision=${d.id}` }))}
        />
        <p className="mt-4 text-sm text-fg/80">{guardianSentence(summary.data?.mandate, account, now ? now / 1000 : null)}</p>
      </section>

      <dl className="ruled grid-cols-2 sm:grid-cols-4">
        {[
          ["Liquidation price", position.liqPrice ? format(position.liqPrice) : "none"],
          ["Liquidation within 24 h", formatProbability(position.probability24h)],
          ["Time to liquidation", formatDuration(position.ttlHours)],
          ["Score", `${position.score} of 100`],
          ["Collateral", format(position.collateralUsd)],
          ["Debt", format(position.debtUsd)],
          ["Distance to liquidation", formatPercent(position.distance, 1)],
          ["Value at risk, 99 %", format(position.valueAtRisk99)],
        ].map(([k, v]) => (
          <div key={k} className="p-5">
            <dt className="label">{k}</dt>
            <dd className="num mt-2 text-xl text-fg">{v}</dd>
          </div>
        ))}
      </dl>

      <section className="surface p-6" aria-labelledby="chart-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="chart-title" className="text-[15px] text-fg">
            Health
          </h2>
          <Segmented label="Time range" options={RANGES} value={hours as 6 | 24 | 168} onChange={setHours} />
        </div>
        {history.isPending ? (
          <Skeleton height="320px" shape="block" className="mt-5" />
        ) : (
          <SeriesChart
            className="mt-5"
            label={`Health over the last ${hours} hours`}
            height={320}
            series={[{ id: "h", label: "Health", points, tone: "text", area: true }]}
            zones={[{ from: 0, to: 1, tone: "critical" }]}
            lines={[
              { v: 1, label: "Liquidation", tone: "critical" },
              ...(own ? [{ v: own.triggerHealth, label: "Your trigger", tone: "brass" as const, dashed: true }, { v: own.targetHealth, label: "Target", tone: "muted" as const, dashed: true }] : []),
            ]}
            events={acted.map((d) => ({ t: Date.parse(d.createdAt) / 1000, label: d.plan }))}
          />
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-3">
        <section className="surface p-5">
          <div className="label">Volatility</div>
          <div className="mt-1 flex items-end gap-2">
            <span className="num text-2xl text-fg">{tremor ? formatPercent(tremor.annual, 0) : "..."}</span>
            <span className="pb-0.5 text-sm text-fg/70">{tremor?.regime ?? tremor?.level ?? ""}</span>
          </div>
          <ul className="mt-4 grid gap-2 text-[12.5px]">
            {(tremor?.windows ?? []).map((w) => (
              <li key={w.hours} className="flex items-center gap-3">
                <span className="w-10 text-muted">{w.hours} h</span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                  <span className="block h-full rounded-full bg-fg/60" style={{ width: `${Math.min(100, ((w.sigma * Math.sqrt(8760)) / 1.5) * 100)}%` }} />
                </span>
                <span className="num w-12 text-right text-fg">{formatPercent(w.sigma * Math.sqrt(8760), 0)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="surface p-5">
          <div className="label">NEAR price</div>
          <SeriesChart className="mt-2" label="NEAR price" height={130} format={(v) => `$${v.toFixed(2)}`} series={[{ id: "p", label: "NEAR", points: prices, tone: "brass" }]} lines={position.liqPrice ? [{ v: position.liqPrice, label: "Liquidation", tone: "critical" }] : []} />
        </section>
        <section className="surface p-5">
          <div className="label">Risk score</div>
          <SeriesChart className="mt-2" label="Risk score" height={130} format={(v) => v.toFixed(0)} domain={[0, 100]} series={[{ id: "s", label: "Score", points: scores, tone: "text" }]} />
        </section>
      </div>

      <section className="surface p-6" aria-labelledby="score-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="score-title" className="text-[15px] text-fg">
            Score and its parts
          </h2>
          <span className="text-[12.5px] text-muted">S = 100 × (0.70 √P + 0.15 V + 0.15 C), with health floors</span>
        </div>
        <div className="mt-5">
          <ScoreParts position={position} market={market.data} />
        </div>
      </section>

      {map.data ? (
        <section className="surface p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-[15px] text-fg">Its place on the cascade map</h2>
            <Link href="/app/cascade" className="text-sm text-brass hover:underline">
              Full map
            </Link>
          </div>
          <Heatmap className="mt-4" buckets={map.data.buckets} cascades={map.data.cascades} price={map.data.price} mine={{ liqPrice: position.liqPrice, triggerPrice }} height={240} />
        </section>
      ) : null}

      <section className="surface flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-[15px] text-fg">Close or unwind</h2>
          <p className="mt-1 text-sm text-muted">Close this position in one step, or unwind the whole protected account and take everything back.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setFlow("unwind")}>
            Unwind the account
          </Button>
          <Button onClick={() => setFlow("close")}>Close the position</Button>
        </div>
      </section>
      {summary.data && flow ? <CloseFlow summary={summary.data} position={position} mode={flow} open onOpenChange={(v) => !v && setFlow(null)} /> : null}

      <Copilot account={account} positionId={position.id} />
    </div>
  );
}

export function PositionDetail() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? "");
  const account = id.split(":")[0] ?? "";
  const q = usePositions(account || null);
  const position = q.data?.find((p) => p.id === id) ?? null;
  return (
    <div className="grid gap-8">
      <PageHeader
        title={position?.label ?? (q.data ? "Position not found" : "Position")}
        description={
          <span className="num text-[13px]" title={account}>
            {shortId(account, 10, 6)}
          </span>
        }
      />
      {q.isError && !q.data ? (
        <QueryError title="The position could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <PositionSkeleton />
      ) : !position ? (
        <QueryError title="No such position" error={new Error(`The account has no position ${id}. It may have been closed.`)} />
      ) : (
        <Detail position={position} account={account} />
      )}
    </div>
  );
}

export function PositionSkeleton({ className }: { className?: string }) {
  return (
    <div className={className} aria-busy="true">
      <Skeleton height="16rem" shape="block" />
      <Skeleton height="20rem" shape="block" className="mt-6" />
    </div>
  );
}
