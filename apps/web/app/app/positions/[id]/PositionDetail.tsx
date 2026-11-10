"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { riskScore } from "@parry/core";
import type { HistoryPoint, Market, Position } from "@parry/sdk";
import { DataList, DataRow, Eyebrow, QueryError, Segmented } from "@/components/app/bits";
import { Copilot } from "@/components/app/Copilot";
import { cascadeLabel, cascadeTone, TREMOR_LABEL, TREMOR_TONE } from "@/components/app/MarketStrip";
import { PageHeader } from "@/components/app/PageHeader";
import { HealthValue, VENUE_LABEL } from "@/components/app/PositionsTable";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { Chart, type ChartPoint, type ChartPriceLine, type ChartSeries } from "@/components/ui/Chart";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { Tabs } from "@/components/ui/Tabs";
import { TierBadge } from "@/components/ui/TierBadge";
import { useHistory, useMarket, usePositions } from "@/lib/queries";
import { formatDuration, formatPercent, formatProbability, shortId } from "@/lib/units";
import { cn } from "@/lib/cn";

const RANGES = [
  { value: 6, label: "6 h" },
  { value: 24, label: "24 h" },
  { value: 168, label: "7 days" },
] as const;

function series(points: HistoryPoint[], pick: (p: HistoryPoint) => number | null, scale = 1): ChartPoint[] {
  const out: ChartPoint[] = [];
  let last = -1;
  for (const p of points) {
    const v = pick(p);
    const time = Math.floor(Date.parse(p.t) / 1000);
    if (v === null || !Number.isFinite(v) || !Number.isFinite(time) || time <= last) continue;
    out.push({ time, value: v * scale });
    last = time;
  }
  return out;
}

function History({ position }: { position: Position }) {
  const [hours, setHours] = useState<number>(24);
  const q = useHistory(position.id, hours);
  const { rate, shown } = useMoney();
  const points = useMemo(() => q.data ?? [], [q.data]);
  const k = rate ?? 1;

  const health = useMemo<ChartSeries[]>(() => [{ id: "health", kind: "area", tone: "fg", title: "Health", data: series(points, (p) => p.health) }], [points]);
  const healthLines = useMemo<ChartPriceLine[]>(() => [{ price: 1, title: "Liquidation", tone: "critical" }], []);
  const price = useMemo<ChartSeries[]>(() => [{ id: "price", kind: "line", tone: "brass", title: "NEAR", data: series(points, (p) => p.price, k) }], [points, k]);
  const priceLines = useMemo<ChartPriceLine[]>(
    () => (position.liqPrice !== null ? [{ price: position.liqPrice * k, title: "Liquidation", tone: "critical" }] : []),
    [position.liqPrice, k],
  );
  const score = useMemo<ChartSeries[]>(() => [{ id: "score", kind: "area", tone: "danger", title: "Score", data: series(points, (p) => p.score) }], [points]);
  const scoreLines = useMemo<ChartPriceLine[]>(() => [{ price: 75, title: "Critical", tone: "critical" }, { price: 50, title: "Danger", tone: "danger" }], []);
  const range = RANGES.find((r) => r.value === hours)?.label ?? `${hours} h`;

  return (
    <Card as="section" aria-labelledby="history-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="history-title">History</span>}
        description="Health, the NEAR price and the risk score, one point a minute."
        actions={<Segmented label="Time range" options={RANGES} value={hours as 6 | 24 | 168} onChange={setHours} />}
      />
      {q.isError && !q.data ? (
        <QueryError title="The history could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="320px" shape="block" />
      ) : (
        <Tabs
          label="Chart"
          items={[
            { id: "health", label: "Health", content: <Chart series={health} priceLines={healthLines} label={`Health factor, last ${range}`} height={280} precision={2} /> },
            {
              id: "price",
              label: "Price",
              content: <Chart series={price} priceLines={priceLines} label={`NEAR price, last ${range}`} height={280} valueFormat="usd" currency={shown} precision={shown === "JPY" || shown === "INR" ? 0 : 2} />,
            },
            { id: "score", label: "Score", content: <Chart series={score} priceLines={scoreLines} label={`Risk score, last ${range}`} height={280} precision={0} /> },
          ]}
        />
      )}
    </Card>
  );
}

function ScoreParts({ position, market }: { position: Position; market: Market | undefined }) {
  if (!market) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }
  const s = riskScore({
    health: position.health ?? Infinity,
    probability24h: position.probability24h,
    annualVol: market.tremor.annual,
    cascadePressure: market.cascade.pressure,
  });
  const parts = [
    { name: "Liquidation probability", detail: `0.70 × √P(24 h), P = ${formatProbability(position.probability24h)}`, points: s.components.liquidation, max: 70 },
    { name: "Market turbulence", detail: `0.15 × Tremor above 30%, now ${formatPercent(market.tremor.annual, 0)}`, points: s.components.volatility, max: 15 },
    { name: "Cascade pressure", detail: `0.15 × pressure, now ${formatPercent(market.cascade.pressure, 1)}`, points: s.components.cascade, max: 15 },
  ];
  const sum = parts.reduce((t, p) => t + p.points, 0);
  const floor = position.health !== null && position.health < 1.1 ? (position.health < 1.03 ? 75 : 50) : null;
  return (
    <div className="grid gap-4">
      <ul className="grid gap-4">
        {parts.map((p) => (
          <li key={p.name} className="grid gap-1.5">
            <div className="flex flex-wrap items-end justify-between gap-x-3">
              <span className="text-sm font-semibold text-fg">{p.name}</span>
              <span className="num text-sm text-fg">
                {p.points}
                <span className="text-muted"> / {p.max}</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div className="h-full rounded-full bg-brass-fill" style={{ width: `${(p.points / p.max) * 100}%` }} />
            </div>
            <p className="text-[13px] text-muted">{p.detail}</p>
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
  const market = useMarket();
  const { format } = useMoney();
  const m = market.data;
  return (
    <div className="grid gap-6" data-stagger>
      <Card as="section" aria-labelledby="risk-title">
        <h2 id="risk-title" className="sr-only">
          Risk now
        </h2>
        <StatGroup className="grid-cols-2 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Health" value={<HealthValue health={position.health} />} hint="Liquidation below 1.00" size="lg" />
          <Stat label="Liquidation price" value={position.liqPrice !== null ? format(position.liqPrice) : "None"} hint={position.liqPrice !== null ? `${formatPercent(position.distance, 1)} below the price` : "No fall liquidates it"} size="lg" />
          <Stat label="Score" value={<TierBadge tier={position.tier} score={position.score} size="md" />} hint="0 to 100, four tiers" size="lg" />
          <Stat label="Liquidation within 24 h" value={formatProbability(position.probability24h)} hint="First passage, Tremor volatility" size="lg" />
          <Stat label="Time to liquidation" value={formatDuration(position.ttlHours)} hint="Median at the current pace" />
          <Stat label="Value at risk" value={format(position.valueAtRisk99)} hint="99%, one day" />
          <Stat label="Collateral" value={format(position.collateralUsd)} />
          <Stat label="Debt" value={format(position.debtUsd)} />
        </StatGroup>
      </Card>

      <History position={position} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card as="section" aria-labelledby="score-title" className="grid content-start gap-5">
          <CardHeader titleAs="h2" title={<span id="score-title">Score and its parts</span>} description="S = 100 × (0.70 √P + 0.15 V + 0.15 C), with health floors." />
          <ScoreParts position={position} market={m} />
        </Card>

        <Card as="section" aria-labelledby="market-title" className="grid content-start gap-5">
          <CardHeader titleAs="h2" title={<span id="market-title">Market around it</span>} description="The Tremor index and cascade pressure on NEAR." />
          {market.isError && !m ? (
            <QueryError title="Market data is unavailable" error={market.error} onRetry={() => void market.refetch()} />
          ) : !m ? (
            <div className="grid gap-3" aria-busy="true">
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          ) : (
            <div className="grid gap-5">
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Eyebrow>Tremor index</Eyebrow>
                  <Badge tone={TREMOR_TONE[m.tremor.level] ?? "neutral"}>{TREMOR_LABEL[m.tremor.level] ?? m.tremor.level}</Badge>
                </div>
                <DataList>
                  {m.tremor.windows.map((w) => (
                    <DataRow key={w.hours} label={`Last ${w.hours} h`}>
                      <span className="num">{w.sigma !== null ? `${formatPercent(w.sigma * Math.sqrt(8760), 0)} a year` : "Too few samples"}</span>
                    </DataRow>
                  ))}
                  <DataRow label="Weighted">
                    <span className="num">{formatPercent(m.tremor.annual, 0)} a year</span>
                  </DataRow>
                </DataList>
              </div>
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Eyebrow>Cascade pressure</Eyebrow>
                  <Badge tone={cascadeTone(m.cascade.pressure)}>{cascadeLabel(m.cascade.pressure)}</Badge>
                </div>
                <DataList>
                  <DataRow label="Pressure">
                    <span className="num">{formatPercent(m.cascade.pressure, 1)}</span>
                  </DataRow>
                  <DataRow label="Collateral a 2σ day would liquidate">
                    <span className="num">{format(m.cascade.atRiskUsd)}</span>
                  </DataRow>
                  <DataRow label="Owners exposed on several venues">
                    <span className="num">{m.cascade.correlatedOwners}</span>
                  </DataRow>
                </DataList>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Copilot account={account} positionId={position.id} />
    </div>
  );
}

/** One position: its risk now, its history, the model's parts and the copilot. */
export function PositionDetail() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? "");
  const account = id.split(":")[0] ?? "";
  const q = usePositions(account || null);
  const position = q.data?.find((p) => p.id === id);
  const missing = q.isSuccess && !position;

  return (
    <div className="grid gap-8">
      <PageHeader
        title={position?.label ?? (missing ? "Position not found" : "Position")}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{position ? (VENUE_LABEL[position.venue] ?? position.venue) : "Loading"}</span>
            <span aria-hidden="true">·</span>
            <span className="num text-[13px]" title={account}>
              {shortId(account, 10, 6)}
            </span>
          </span>
        }
        actions={
          <Link href="/app" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-muted transition-colors hover:bg-hover hover:text-fg">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M10 3.5 L5.5 8 L10 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Dashboard
          </Link>
        }
      />
      {q.isError && !q.data ? (
        <QueryError title="This position could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : missing ? (
        <QueryError title="No such position" error={new Error(`The account has no position ${id}. It may have been closed.`)} />
      ) : position ? (
        <Detail position={position} account={account} />
      ) : (
        <PositionSkeleton />
      )}
    </div>
  );
}

export function PositionSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-6", className)} aria-busy="true">
      <span className="sr-only">Loading the position</span>
      <Card>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="grid gap-2">
              <Skeleton width="60%" />
              <Skeleton width="45%" height="2rem" shape="block" />
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <Skeleton height="320px" shape="block" />
      </Card>
    </div>
  );
}
