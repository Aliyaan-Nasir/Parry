"use client";

import { useState } from "react";
import { SeriesChart } from "@/components/instrument/SeriesChart";
import { useReplay } from "@/lib/live";
import { cn } from "@/lib/cn";

const SOURCE_LABEL: Record<string, string> = { candles: "NEAR prices", funding: "Funding", staking: "Staking yield", model: "Model" };

/** Every crash in the replay: the price, health with and without Parry, the guardian's steps, and the vault. */
export function ReplayView() {
  const { data, isLoading } = useReplay();
  const [pick, setPick] = useState(0);
  if (isLoading) return <div className="surface h-96 animate-shimmer" />;
  if (!data) return <p className="text-lg text-muted">The replay results load from the Parry API (pnpm replay writes them).</p>;
  const c = data.crashes[pick] ?? data.crashes[0];
  const sum = data.summary as typeof data.summary & { minWarningHours?: number; medianVaultDrawdownPct?: number; medianUnhedgedDrawdownPct?: number };
  if (!c) return null;
  const sec = (t: string) => Date.parse(t) / 1000;
  const t0 = sec(c.candles[0]!.t);
  const hours = (t: number) => `${Math.round((t - t0) / 3600)} h`;
  return (
    <div>
      <dl className="ruled grid-cols-2 lg:grid-cols-4">
        {[
          ["Median warning before liquidation", sum.medianWarningHours !== null ? `${sum.medianWarningHours.toFixed(0)} h` : "none"],
          ["Shortest warning", typeof sum.minWarningHours === "number" ? `${sum.minWarningHours} h` : "none"],
          ["Liquidations avoided", `${sum.liquidationsAvoided} of ${sum.crashes}`],
          ["Vault drawdown, median", typeof sum.medianVaultDrawdownPct === "number" ? `${sum.medianVaultDrawdownPct.toFixed(1)}%` : "none"],
        ].map(([k, v]) => (
          <div key={k} className="p-6">
            <dt className="label">{k}</dt>
            <dd className="display mt-2 whitespace-nowrap text-[2.5rem] text-fg sm:text-6xl lg:text-5xl">{v}</dd>
          </div>
        ))}
      </dl>
      {typeof sum.medianUnhedgedDrawdownPct === "number" ? (
        <p className="mt-4 text-sm text-muted">
          Holding the same NEAR unhedged lost a median of <span className="num text-fg">{sum.medianUnhedgedDrawdownPct.toFixed(1)}%</span> in the same crashes.
        </p>
      ) : null}
      <div className="mt-10 flex flex-wrap gap-2" role="tablist" aria-label="Crashes">
        {data.crashes.map((x, i) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={i === pick}
            onClick={() => setPick(i)}
            className={cn("rounded-full border px-4 py-2 text-sm transition-colors", i === pick ? "border-brass-fill bg-brass-fill/10 text-fg" : "border-line text-muted hover:text-fg")}
          >
            {x.name} <span className="num ml-1 text-xs">-{x.dropPct.toFixed(0)}%</span>
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
              {c.position.liquidatedWithParryAt ? ", and with it (the guardian had used its actions for the day)" : ""}
            </span>
          </div>
          <SeriesChart
            className="mt-5"
            label={`Health through the ${c.name} crash`}
            height={300}
            formatTime={hours}
            series={[
              { id: "without", label: "Without Parry", points: c.position.healthWithout.map((p) => ({ t: sec(p.t), v: p.h })), tone: "muted", dashed: true },
              { id: "with", label: "With Parry", points: c.position.healthWith.map((p) => ({ t: sec(p.t), v: p.h })), tone: "brass" },
            ]}
            zones={[{ from: 0, to: 1, tone: "critical" }]}
            lines={[{ v: 1, label: "Liquidation", tone: "critical" }]}
            events={c.position.steps.map((s) => ({ t: sec(s.t), label: `${s.action}: ${s.plan}` }))}
          />
          {c.position.steps.length ? (
            <ol className="mt-6 divide-y divide-line border-t border-line text-sm">
              {c.position.steps.map((s, i) => (
                <li key={i} className="grid gap-1 py-3 sm:grid-cols-[6rem_1fr_auto] sm:gap-6">
                  <span className="num text-muted">{hours(sec(s.t))}</span>
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
            <SeriesChart className="mt-5" label="NEAR price" height={220} formatTime={hours} format={(v) => `$${v.toFixed(2)}`} series={[{ id: "p", label: "NEAR", points: c.candles.map((p) => ({ t: sec(p.t), v: p.price })), tone: "text", area: true }]} />
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
                { id: "u", label: "Unhedged", points: c.vault.navUnhedged.map((p) => ({ t: sec(p.t), v: p.v })), tone: "muted", dashed: true },
                { id: "h", label: "Parry vault", points: c.vault.navWith.map((p) => ({ t: sec(p.t), v: p.v })), tone: "brass" },
              ]}
            />
            <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="label">Max drawdown</div>
                <div className="num mt-1 text-fg">{c.vault.maxDrawdownPct.toFixed(2)}%{typeof c.vault.maxDrawdownUnhedgedPct === "number" ? <span className="text-muted"> vs {c.vault.maxDrawdownUnhedgedPct.toFixed(1)}% unhedged</span> : null}</div>
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
      <section className="mt-12 border-t border-line pt-8" aria-labelledby="sources-title">
        <h2 id="sources-title" className="text-[15px] text-fg">
          Sources
        </h2>
        <dl className="mt-4 grid gap-3 text-sm">
          {Object.entries(data.sources ?? { candles: data.source }).map(([k, v]) => (
            <div key={k} className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-6">
              <dt className="text-muted">{SOURCE_LABEL[k] ?? k}</dt>
              <dd className="break-words text-fg/85">{v}</dd>
            </div>
          ))}
        </dl>
        {data.generatedAt ? <p className="mt-4 text-[13px] text-muted">Computed {new Date(data.generatedAt).toUTCString().slice(5, 22)} UTC by pnpm replay.</p> : null}
      </section>
    </div>
  );
}
