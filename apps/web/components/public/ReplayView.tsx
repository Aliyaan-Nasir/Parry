"use client";

import { useState, type ReactNode } from "react";
import { SeriesChart, type ChartEvent } from "@/components/instrument/SeriesChart";
import { useReplay, type ReplayLive } from "@/lib/live";
import { cn } from "@/lib/cn";

type Crash = ReplayLive["crashes"][number];
type Spike = NonNullable<ReplayLive["spikes"]>[number];
type Vault = Crash["vault"];

const SOURCE_LABEL: Record<string, string> = { candles: "NEAR prices", funding: "Funding", staking: "Staking yield", model: "Model" };
/** Hyperliquid's maintenance margin for NEAR, as the replay uses it. */
const MAINTENANCE = 0.05;
/** The vault's lever events worth marking on a chart (rebalances happen most hours in a rally). */
const LEVER_EVENTS = new Set(["deposits_paused", "deposits_resumed", "leverage_reduced", "leverage_restored", "margin_top_up", "margin_top_up_refused", "margin_top_up_unpaid", "liquidated"]);
/** Lever events shown before "Show all". */
const FIRST_EVENTS = 6;

/** One row per hour: "Score 70: deposits paused" and "Score 70: the leverage cap drops to 2" read as one sentence. */
function byHour(events: readonly { t: string; detail: string }[]): { t: string; detail: string }[] {
  const rows: { t: string; parts: string[] }[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (last && last.t === e.t) last.parts.push(e.detail);
    else rows.push({ t: e.t, parts: [e.detail] });
  }
  return rows.map(({ t, parts }) => {
    const scored = parts.map((p) => /^Score (\d+): (.*?)\.?$/.exec(p));
    if (parts.length > 1 && scored.every((m) => m && m[1] === scored[0]![1])) return { t, detail: `Score ${scored[0]![1]}: ${scored.map((m) => m![2]).join("; ")}.` };
    return { t, detail: parts.join(" ") };
  });
}

const sec = (t: string) => Date.parse(t) / 1000;
const pct = (x: number, dp = 1) => `${x.toFixed(dp)}%`;
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** Share price: NAV over the NAV the episode opened with. */
const sharePrice = (pts: readonly { t: string; v: number }[]) => {
  const base = pts[0]?.v || 1;
  return pts.map((p) => ({ t: sec(p.t), v: p.v / base }));
};

/** Every replayed episode: the crashes for a borrower and the vault, the spikes for the vault's short, and how the regime thresholds were chosen. */
export function ReplayView() {
  const { data, isLoading } = useReplay();
  if (isLoading) return <div className="surface h-96 animate-shimmer" />;
  if (!data) return <p className="text-lg text-muted">The replay results load from the Parry API (pnpm replay writes them).</p>;
  const calibration = data.calibration as Calibration | undefined;
  return (
    <div>
      <Crashes data={data} />
      {data.spikes?.length ? <Spikes data={data} spikes={data.spikes} /> : null}
      {calibration?.regime.method ? <CalibrationNote c={calibration} /> : null}
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

function Crashes({ data }: { data: ReplayLive }) {
  const [pick, setPick] = useState(0);
  const c = data.crashes[pick] ?? data.crashes[0];
  const sum = data.summary as typeof data.summary & { minWarningHours?: number; medianVaultDrawdownPct?: number; medianUnhedgedDrawdownPct?: number };
  if (!c) return null;
  const t0 = sec(c.candles[0]!.t);
  const hours = (t: number) => `${Math.round((t - t0) / 3600)} h`;
  return (
    <section aria-labelledby="crashes-title">
      <SectionTitle id="crashes-title" title="Crashes" lead="A Rhea borrower at health 1.30 and the vault, from the peak of each of NEAR's six largest 72-hour falls." />
      <Summary
        items={[
          ["Median warning before liquidation", sum.medianWarningHours !== null ? `${sum.medianWarningHours.toFixed(0)} h` : "none"],
          ["Shortest warning", typeof sum.minWarningHours === "number" ? `${sum.minWarningHours} h` : "none"],
          ["Liquidations avoided", `${sum.liquidationsAvoided} of ${sum.crashes}`],
          ["Vault drawdown, median", typeof sum.medianVaultDrawdownPct === "number" ? pct(sum.medianVaultDrawdownPct) : "none"],
        ]}
      />
      {typeof sum.medianUnhedgedDrawdownPct === "number" ? (
        <p className="mt-4 text-sm text-muted">
          Holding the same NEAR unhedged lost a median of <span className="num text-fg">{pct(sum.medianUnhedgedDrawdownPct)}</span> in the same crashes.
        </p>
      ) : null}
      <Tabs label="Crashes" items={data.crashes.map((x) => ({ id: x.id, name: x.name, move: `-${x.dropPct.toFixed(0)}%` }))} pick={pick} onPick={setPick} />
      <div className="mt-6 grid gap-6">
        <div className="surface p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 className="display-sm text-2xl text-fg">Health, with and without Parry</h3>
            <span className="text-sm text-muted">
              {c.position.warningHours !== null ? `${c.position.warningHours.toFixed(0)} hours of warning` : "no warning needed"}
              {c.position.liquidatedAt ? ", liquidated without Parry" : ""}
              {c.position.liquidatedWithParryAt ? ", and with it (the guardian had used its actions for the day)" : ""}
            </span>
          </div>
          <Legend
            items={[
              { label: "With Parry", tone: "brass" },
              { label: "Without Parry", tone: "muted", dashed: true },
            ]}
          />
          <SeriesChart
            className="mt-4"
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
            <h3 className="display-sm text-2xl text-fg">NEAR price</h3>
            <SeriesChart className="mt-5" label={`NEAR price through the ${c.name} crash`} height={220} formatTime={hours} format={(v) => `$${v.toFixed(2)}`} series={[{ id: "p", label: "NEAR", points: c.candles.map((p) => ({ t: sec(p.t), v: p.price })), tone: "text", area: true }]} />
          </div>
          <div className="surface p-6">
            <h3 className="display-sm text-2xl text-fg">The vault through it</h3>
            <SharePriceChart className="mt-4" vault={c.vault} label={`Vault share price through the ${c.name} crash, hedged and unhedged`} formatTime={hours} />
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <Stat label="Max drawdown" value={pct(c.vault.maxDrawdownPct, 2)} note={typeof c.vault.maxDrawdownUnhedgedPct === "number" ? `${pct(c.vault.maxDrawdownUnhedgedPct)} unhedged` : undefined} />
              <Stat label="Lowest margin ratio" value={c.vault.marginMin.toFixed(3)} note="at an hour's high" />
              {typeof c.vault.hedgedMinPct === "number" ? <Stat label="Hedged" value={pct(c.vault.hedgedMinPct, 0)} note="of the NEAR, at its least" /> : null}
              {typeof c.vault.fundingUsd === "number" ? <Stat label="Funding" value={usd(c.vault.fundingUsd)} note={`${c.vault.fundingUsd < 0 ? "paid by the short" : "earned by the short"}${c.vault.insurancePaid?.negativeFundingUsd ? `, ${usd(c.vault.insurancePaid.negativeFundingUsd)} covered by the fund` : ""}`} /> : null}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function Spikes({ data, spikes }: { data: ReplayLive; spikes: Spike[] }) {
  const [pick, setPick] = useState(0);
  const [allEvents, setAllEvents] = useState(false);
  const s = spikes[pick] ?? spikes[0];
  if (!s) return null;
  const v = s.vault;
  const sum = data.summary as typeof data.summary & { spikeLiquidations?: number; spikeClosestLiquidationPct?: number | null; spikeMinMarginRatio?: number };
  const liquidations = sum.spikeLiquidations ?? spikes.filter((x) => x.vault.liquidatedAt).length;
  const closest = sum.spikeClosestLiquidationPct ?? null;
  const minMargin = sum.spikeMinMarginRatio ?? Math.min(...spikes.map((x) => x.vault.marginMin));
  const hedgedEnd = median(spikes.map((x) => x.vault.hedgedEndPct).filter((x): x is number => typeof x === "number"));
  const topUps = spikes.reduce((a, x) => a + (x.vault.insurancePaid?.marginTopUpUsd ?? 0), 0);
  const askedHours = spikes.reduce((a, x) => a + (x.vault.marginNeededHours ?? 0), 0);
  const unpaid = spikes.reduce((a, x) => a + (x.vault.marginTopUpsUnpaid ?? 0) + (x.vault.marginTopUpsRefused ?? 0), 0);
  const maxShortfall = Math.max(0, ...spikes.map((x) => x.vault.marginShortfallMaxUsd ?? 0));
  const pausedHours = spikes.reduce((a, x) => a + (x.vault.pausedHours ?? 0), 0);
  const t0 = sec(s.candles[0]!.t);
  const hours = (t: number) => `${Math.round((t - t0) / 3600)} h`;
  const hedge = v.hedge ?? [];
  const levers = (v.events ?? []).filter((e) => LEVER_EVENTS.has(e.kind));
  const rows = byHour(levers);
  const marks: ChartEvent[] = levers.map((e) => ({ t: sec(e.t), label: e.detail }));
  return (
    <section className="mt-20" aria-labelledby="spikes-title">
      <SectionTitle
        id="spikes-title"
        title="Spikes"
        lead="The vault's hedge is a short perp, so a sharp rally is where it can be liquidated. The vault from the low of each of NEAR's six largest 72-hour rallies: its margin, how close the short came to Hyperliquid's liquidation price, and what the rebalances did to the hedge."
      />
      <Summary
        items={[
          ["Vault liquidated", `${liquidations} of ${spikes.length}`],
          ["Closest to liquidation", closest !== null ? pct(closest) : "none"],
          ["Lowest margin ratio", minMargin.toFixed(3)],
          ["Hedge left at the end, median", hedgedEnd !== null ? pct(hedgedEnd, 0) : "none"],
        ]}
      />
      <p className="mt-4 max-w-3xl text-sm text-muted">
        {liquidations === 0 ? "The leverage cap kept every short alive by buying part of it back as NEAR rose. " : `The short was liquidated in ${liquidations} of the ${spikes.length} spikes. `}
        {hedgedEnd !== null && hedgedEnd < 50 ? `The cost is the hedge: at the end a median of only ${pct(hedgedEnd, 0)} of the NEAR was still hedged, so the share price followed NEAR part of the way up and back down. ` : ""}
        {pausedHours ? `A short near its liquidation price paused deposits for ${pausedHours} h in all. ` : ""}
        {askedHours === 0
          ? "The vault never asked for margin."
          : `The vault asked for margin for ${askedHours} h, against a shortfall of up to ${usd(maxShortfall)}: ${topUps > 0 ? `the keeper paid ${usd(topUps)}, all the insurance fund could pay then` : "the insurance fund could pay nothing"}${unpaid ? `, and in ${unpaid} of those hours nothing, the fund's daily cap already spent` : ""}.`}
      </p>
      <Tabs label="Spikes" items={spikes.map((x) => ({ id: x.id, name: x.name, move: `+${x.risePct.toFixed(0)}%` }))} pick={pick} onPick={setPick} />
      <div className="mt-6 grid gap-6">
        <div className="surface p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 className="display-sm text-2xl text-fg">The short against its liquidation price</h3>
            <span className="text-sm text-muted">
              {v.liquidatedAt
                ? `liquidated ${hours(sec(v.liquidatedAt))} in`
                : typeof v.liquidationHeadroomMinPct === "number"
                  ? `never liquidated; at its closest an hour's high came within ${pct(v.liquidationHeadroomMinPct)}`
                  : "never liquidated"}
            </span>
          </div>
          <Legend
            items={[
              { label: "NEAR price", tone: "text" },
              { label: "Liquidation price of the short", tone: "critical", dashed: true },
            ]}
          />
          <SeriesChart
            className="mt-4"
            label={`NEAR price and the short's liquidation price through the ${s.name} spike`}
            height={300}
            formatTime={hours}
            format={(x) => `$${x.toFixed(2)}`}
            series={[
              { id: "price", label: "NEAR", points: s.candles.map((p) => ({ t: sec(p.t), v: p.price })), tone: "text", area: true },
              { id: "liq", label: "Liquidation", points: hedge.filter((h) => h.liqPx !== null).map((h) => ({ t: sec(h.t), v: h.liqPx! })), tone: "critical", dashed: true },
            ]}
            events={marks}
          />
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm sm:grid-cols-4">
            <Stat label="Rise" value={`+${pct(s.risePct)}`} note={`$${s.startPrice.toFixed(2)} to $${s.peakPrice.toFixed(2)}`} />
            <Stat label="Highest vault score" value={String(v.maxScore ?? "none")} note={v.reducedLeverageHours ? `leverage cap cut to 2 for ${v.reducedLeverageHours} h` : "leverage cap stayed at 3"} />
            <Stat label="Rebalances" value={String(v.rebalances ?? 0)} note={`${v.buybacks ?? 0} bought the short back`} />
            <Stat label="Deposits paused" value={v.pausedHours ? `${v.pausedHours} h` : "never"} note={v.marginNeededHours ? `margin asked for ${v.marginNeededHours} h, ${usd(v.insurancePaid?.marginTopUpUsd ?? 0)} paid` : `insurance paid ${usd(v.insurancePaidUsd)}`} />
          </dl>
          {rows.length ? (
            <>
              <ol className="mt-5 divide-y divide-line border-t border-line text-sm">
                {(allEvents ? rows : rows.slice(0, FIRST_EVENTS)).map((e, i) => (
                  <li key={i} className="grid gap-1 py-3 sm:grid-cols-[6rem_1fr] sm:gap-6">
                    <span className="num text-muted">{hours(sec(e.t))}</span>
                    <span className="text-fg">{e.detail}</span>
                  </li>
                ))}
              </ol>
              {rows.length > FIRST_EVENTS ? (
                <button type="button" onClick={() => setAllEvents((x) => !x)} aria-expanded={allEvents} className="mt-3 text-sm text-brass underline-offset-4 hover:underline">
                  {allEvents ? "Show fewer" : `Show all ${rows.length} hours`}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="surface p-6">
            <h3 className="display-sm text-2xl text-fg">Margin ratio</h3>
            <Legend
              items={[
                { label: "At the hour's high", tone: "brass" },
                { label: "After the rebalance", tone: "muted", dashed: true },
              ]}
            />
            <SeriesChart
              className="mt-4"
              label={`Margin ratio of the short through the ${s.name} spike`}
              height={220}
              formatTime={hours}
              format={(x) => x.toFixed(2)}
              series={[
                { id: "close", label: "After the rebalance", points: hedge.filter((h) => h.marginRatio !== null).map((h) => ({ t: sec(h.t), v: h.marginRatio! })), tone: "muted", dashed: true },
                { id: "high", label: "At the high", points: hedge.filter((h) => typeof h.marginAtHigh === "number").map((h) => ({ t: sec(h.t), v: h.marginAtHigh! })), tone: "brass" },
              ]}
              zones={[{ from: 0, to: MAINTENANCE, tone: "critical" }]}
              lines={[{ v: MAINTENANCE, label: "Liquidation", tone: "critical" }]}
            />
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <Stat label="Lowest margin ratio" value={v.marginMin.toFixed(3)} note={v.marginMinAt ? `at an hour's high, ${hours(sec(v.marginMinAt))} in` : "at an hour's high"} />
              <Stat label="Hedged at the end" value={typeof v.hedgedEndPct === "number" ? pct(v.hedgedEndPct, 0) : "none"} note={typeof v.hedgedMinPct === "number" ? `${pct(v.hedgedMinPct, 0)} at its least` : undefined} />
            </dl>
          </div>
          <div className="surface p-6">
            <h3 className="display-sm text-2xl text-fg">Share price</h3>
            <SharePriceChart className="mt-4" vault={v} label={`Vault share price through the ${s.name} spike, hedged and unhedged`} formatTime={hours} />
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <Stat label="At the end" value={typeof v.sharePriceEnd === "number" ? v.sharePriceEnd.toFixed(3) : "none"} note={typeof v.unhedgedEnd === "number" ? `${v.unhedgedEnd.toFixed(3)} unhedged` : undefined} />
              <Stat label="Max drawdown" value={pct(v.maxDrawdownPct, 2)} note={typeof v.fundingUsd === "number" ? `funding ${usd(v.fundingUsd)}` : undefined} />
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

interface Calibration {
  regime: {
    stressed: number;
    panic: number;
    method?: string;
    panicHitRate?: number;
    panicFalseRate?: number;
    calibrationCrashes?: unknown[];
    test?: { crashes: { panicRate: number; stressedOrWorseRate: number }; spikes: { panicRate: number; stressedOrWorseRate: number } };
  };
  inSample?: { stressed: number; panic: number };
}

/** How the Tremor regime thresholds were chosen: away from every scored episode, then tested on them. */
function CalibrationNote({ c }: { c: Calibration }) {
  const r = c.regime;
  const share = (x: number | undefined) => (typeof x === "number" ? pct(100 * x, 0) : "none");
  return (
    <section className="mt-20" aria-labelledby="calibration-title">
      <SectionTitle
        id="calibration-title"
        title="Regime thresholds, out of sample"
        lead={`The Tremor index reads stressed from ${pct(100 * r.stressed, 0)} annual volatility and panic from ${pct(100 * r.panic, 0)}. They were chosen on ${r.calibrationCrashes?.length ?? "other"} other large falls and the ordinary hours around them, with every hour within 72 hours of a crash or spike above set aside, then tested on those episodes.`}
      />
      <dl className="ruled grid-cols-2 lg:grid-cols-4">
        {[
          ["Panic in the crashes above", share(r.test?.crashes.panicRate)],
          ["Stressed or worse in them", share(r.test?.crashes.stressedOrWorseRate)],
          ["Panic in the spikes above", share(r.test?.spikes.panicRate)],
          ["Panic in ordinary hours", share(r.panicFalseRate)],
        ].map(([k, val]) => (
          <div key={k} className="flex flex-col justify-between p-6">
            <dt className="label">{k}</dt>
            <dd className="display mt-2 whitespace-nowrap text-[2.5rem] text-fg sm:text-5xl">{val}</dd>
          </div>
        ))}
      </dl>
      {c.inSample ? (
        <p className="mt-4 max-w-3xl text-sm text-muted">
          Choosing them on the crashes above instead would have given {pct(100 * c.inSample.stressed, 0)} and {pct(100 * c.inSample.panic, 0)}. The regime is a label for people: no score or guardian trigger uses it.
        </p>
      ) : null}
    </section>
  );
}

function SectionTitle({ id, title, lead }: { id: string; title: string; lead: string }) {
  return (
    <div className="mb-8">
      <h2 id={id} className="display-sm text-3xl text-fg sm:text-4xl">
        {title}
      </h2>
      <p className="mt-3 max-w-3xl leading-relaxed text-muted">{lead}</p>
    </div>
  );
}

function Summary({ items }: { items: [string, string][] }) {
  return (
    <dl className="ruled grid-cols-2 lg:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="flex flex-col justify-between p-6">
          <dt className="label">{k}</dt>
          <dd className="display mt-2 whitespace-nowrap text-[2.5rem] text-fg sm:text-6xl lg:text-5xl">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Tabs({ label, items, pick, onPick }: { label: string; items: { id: string; name: string; move: string }[]; pick: number; onPick: (i: number) => void }) {
  return (
    <div className="mt-10 flex flex-wrap gap-2" role="tablist" aria-label={label}>
      {items.map((x, i) => (
        <button
          key={x.id}
          role="tab"
          aria-selected={i === pick}
          onClick={() => onPick(i)}
          className={cn("rounded-full border px-4 py-2 text-sm transition-colors", i === pick ? "border-brass-fill bg-brass-fill/10 text-fg" : "border-line text-muted hover:text-fg")}
        >
          {x.name} <span className="num ml-1 text-xs">{x.move}</span>
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="num mt-1 text-fg">{value}</dd>
      {note ? <dd className="mt-0.5 text-[13px] text-muted">{note}</dd> : null}
    </div>
  );
}

const SWATCH: Record<string, string> = { brass: "var(--parry-brass-fill)", muted: "var(--parry-muted)", critical: "var(--parry-critical)", text: "var(--parry-text)" };

function Legend({ items }: { items: { label: string; tone: keyof typeof SWATCH; dashed?: boolean }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
      {items.map((x) => (
        <li key={x.label} className="flex items-center gap-2">
          <svg width="18" height="6" aria-hidden="true">
            <line x1="1" x2="17" y1="3" y2="3" style={{ stroke: SWATCH[x.tone] }} strokeWidth={2} strokeDasharray={x.dashed ? "4 3" : undefined} strokeLinecap="round" />
          </svg>
          {x.label}
        </li>
      ))}
    </ul>
  );
}

function SharePriceChart({ vault, label, formatTime, className }: { vault: Vault; label: string; formatTime: (t: number) => string; className?: string }) {
  return (
    <div className={className}>
      <Legend
        items={[
          { label: "Parry vault", tone: "brass" },
          { label: "Unhedged", tone: "muted", dashed: true },
        ]}
      />
      <SeriesChart
        className="mt-4"
        label={label}
        height={220}
        formatTime={formatTime}
        format={(x) => x.toFixed(3)}
        series={[
          { id: "u", label: "Unhedged", points: sharePrice(vault.navUnhedged), tone: "muted", dashed: true },
          { id: "h", label: "Parry vault", points: sharePrice(vault.navWith), tone: "brass" },
        ]}
      />
    </div>
  );
}
