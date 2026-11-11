"use client";

import { useState } from "react";
import { SeriesChart } from "@/components/instrument/SeriesChart";
import { useReplay } from "@/lib/live";
import { cn } from "@/lib/cn";

/** Every crash in the replay: the price, health with and without Parry, the guardian's steps, and the vault. */
export function ReplayView() {
  const { data, isLoading } = useReplay();
  const [pick, setPick] = useState(0);
  if (isLoading) return <div className="surface h-96 animate-shimmer" />;
  if (!data) return <p className="text-lg text-muted">The replay results load from the Parry API (`pnpm replay` writes them).</p>;
  const c = data.crashes[pick] ?? data.crashes[0];
  if (!c) return null;
  const hours = (t: number) => `${Math.round((t - c.candles[0]!.t) / 3600)} h`;
  return (
    <div>
      <dl className="ruled grid-cols-1 sm:grid-cols-3">
        <div className="p-6">
          <dt className="label">Median warning before liquidation</dt>
          <dd className="display mt-2 text-6xl text-fg">{data.summary.medianWarningHours.toFixed(0)} h</dd>
        </div>
        <div className="p-6">
          <dt className="label">Liquidations avoided</dt>
          <dd className="display mt-2 text-6xl text-fg">
            {data.summary.liquidationsAvoided} of {data.summary.crashes}
          </dd>
        </div>
        <div className="p-6">
          <dt className="label">Price source</dt>
          <dd className="mt-3 break-words text-sm text-fg">{data.source}</dd>
        </div>
      </dl>
      <div className="mt-10 flex flex-wrap gap-2" role="tablist" aria-label="Crashes">
        {data.crashes.map((x, i) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={i === pick}
            onClick={() => setPick(i)}
            className={cn("rounded-full border px-4 py-2 text-sm transition-colors", i === pick ? "border-brass-fill bg-brass-fill/10 text-fg" : "border-line text-muted hover:text-fg")}
          >
            {x.name} <span className="num ml-1 text-xs">{(x.dropPct * 100).toFixed(0)}%</span>
          </button>
        ))}
      </div>
      <div className="mt-6 grid gap-6">
        <div className="surface p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="display-sm text-2xl text-fg">Health, with and without Parry</h2>
            <span className="text-sm text-muted">
              {c.position.warningHours !== null ? `${c.position.warningHours.toFixed(0)} hours of warning` : "no warning needed"}
              {c.position.liquidatedAt ? ", liquidated without Parry" : ""}
            </span>
          </div>
          <SeriesChart
            className="mt-5"
            label={`Health through the ${c.name} crash`}
            height={300}
            formatTime={hours}
            series={[
              { id: "without", label: "Without Parry", points: c.position.healthWithout.map((p) => ({ t: p.t, v: p.h })), tone: "muted", dashed: true },
              { id: "with", label: "With Parry", points: c.position.healthWith.map((p) => ({ t: p.t, v: p.h })), tone: "brass" },
            ]}
            zones={[{ from: 0, to: 1, tone: "critical" }]}
            lines={[{ v: 1, label: "Liquidation", tone: "critical" }]}
            events={c.position.steps.map((s) => ({ t: s.t, label: `${s.action}: ${s.plan}` }))}
          />
          {c.position.steps.length ? (
            <ol className="mt-6 divide-y divide-line border-t border-line text-sm">
              {c.position.steps.map((s, i) => (
                <li key={i} className="grid gap-1 py-3 sm:grid-cols-[6rem_1fr_auto] sm:gap-6">
                  <span className="num text-muted">{hours(s.t)}</span>
                  <span className="text-fg">{s.plan}</span>
                  <span className="num text-muted">
                    {s.healthBefore.toFixed(2)} to {s.healthAfter.toFixed(2)}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="surface p-6">
            <h2 className="display-sm text-2xl text-fg">NEAR price</h2>
            <SeriesChart className="mt-5" label="NEAR price" height={220} formatTime={hours} format={(v) => `$${v.toFixed(2)}`} series={[{ id: "p", label: "NEAR", points: c.candles.map((p) => ({ t: p.t, v: p.price })), tone: "text", area: true }]} />
          </div>
          <div className="surface p-6">
            <h2 className="display-sm text-2xl text-fg">The vault through it</h2>
            <SeriesChart
              className="mt-5"
              label="Vault value per share, hedged and unhedged"
              height={220}
              formatTime={hours}
              format={(v) => v.toFixed(3)}
              series={[
                { id: "u", label: "Unhedged", points: c.vault.navUnhedged.map((p) => ({ t: p.t, v: p.v })), tone: "muted", dashed: true },
                { id: "h", label: "Parry vault", points: c.vault.navWith.map((p) => ({ t: p.t, v: p.v })), tone: "brass" },
              ]}
            />
            <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="label">Max drawdown</div>
                <div className="num mt-1 text-fg">{(c.vault.maxDrawdownPct * 100).toFixed(2)}%</div>
              </div>
              <div>
                <div className="label">Lowest margin ratio</div>
                <div className="num mt-1 text-fg">{c.vault.marginMin.toFixed(2)}</div>
              </div>
              <div>
                <div className="label">Insurance paid</div>
                <div className="num mt-1 text-fg">${c.vault.insurancePaidUsd.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
