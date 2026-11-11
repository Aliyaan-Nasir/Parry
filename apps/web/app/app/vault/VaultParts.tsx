"use client";

import { useMemo, useState } from "react";
import type { VaultPoint } from "@parry/sdk";
import { Segmented } from "@/components/app/bits";
import { SeriesChart, type Series } from "@/components/instrument/SeriesChart";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Skeleton } from "@/components/ui/Skeleton";
import type { VaultView as Vault } from "@/lib/api-types";
import { useInsurance, useRatesLive } from "@/lib/live";
import { useVaultHistory } from "@/lib/queries";
import { formatPercent, fromUnits, shortId } from "@/lib/units";
import { cn } from "@/lib/cn";

const DAYS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The vault as a balance: what it holds staked on one pan, the Hyperliquid short on the other.
 * When the short matches the staked NEAR times the hedge ratio the beam sits level; the tilt is
 * the unhedged exposure, capped at 9 degrees.
 */
export function VaultBalance({ v }: { v: Vault }) {
  const { format } = useMoney();
  const stakedNear = (Number(v.stakedLinear) / 1e24) * v.linearRate;
  const longUsd = stakedNear * v.nearPriceUsd;
  const shortUsd = v.hedge.currentNear * v.hedge.mark;
  const targetUsd = longUsd * v.hedge.hedgeRatio;
  const gap = targetUsd > 0 ? (targetUsd - shortUsd) / targetUsd : 0;
  const tilt = r1(Math.max(-9, Math.min(9, gap * 9)));
  const level = Math.abs(gap) < 0.03;
  const W = 540;
  const cx = W / 2;
  const beamY = 62;
  const arm = 196;
  const rad = (tilt * Math.PI) / 180;
  const lx = r1(cx - arm * Math.cos(rad));
  const ly = r1(beamY + arm * Math.sin(rad));
  const rx = r1(cx + arm * Math.cos(rad));
  const ry = r1(beamY - arm * Math.sin(rad));
  const pan = (x: number, y: number, title: string, value: string, sub: string, filled: boolean) => (
    <g>
      <line x1={x} y1={y} x2={x - 46} y2={y + 54} style={{ stroke: "var(--parry-line-strong)" }} />
      <line x1={x} y1={y} x2={x + 46} y2={y + 54} style={{ stroke: "var(--parry-line-strong)" }} />
      <path d={`M${x - 58} ${y + 54} Q ${x} ${y + 80} ${x + 58} ${y + 54} Z`} style={{ fill: filled ? "var(--parry-brass-fill)" : "var(--parry-raised)", stroke: "var(--parry-line-strong)" }} fillOpacity={filled ? 0.18 : 1} />
      {/* On phones the figure is too small for these; the legend under it carries them. */}
      <g className="hidden sm:inline">
        <text x={x} y={y + 102} textAnchor="middle" style={{ fill: "var(--parry-muted)", fontSize: 12 }}>
          {title}
        </text>
        <text x={x} y={y + 124} textAnchor="middle" className="num" style={{ fill: "var(--parry-text)", fontSize: 17 }}>
          {value}
        </text>
        <text x={x} y={y + 142} textAnchor="middle" style={{ fill: "var(--parry-muted)", fontSize: 11.5 }}>
          {sub}
        </text>
      </g>
    </g>
  );
  return (
    <figure className="grid gap-3">
      <svg viewBox={`0 0 ${W} 230`} className="h-auto w-full" role="img" aria-label={`Staked ${format(longUsd)} against a short of ${format(shortUsd)}; target short ${format(targetUsd)}`}>
        <path d={`M${cx - 26} 220 L${cx} 70 L${cx + 26} 220 Z`} style={{ fill: "var(--parry-raised)", stroke: "var(--parry-line-strong)" }} />
        <line x1={cx - 60} x2={cx + 60} y1={220} y2={220} style={{ stroke: "var(--parry-line-strong)" }} />
        <g style={{ transition: "all var(--dur-2) var(--ease-out)" }}>
          <line x1={lx} y1={ly} x2={rx} y2={ry} style={{ stroke: "var(--parry-text)" }} strokeWidth={2.5} strokeLinecap="round" />
          {pan(lx, ly, "Staked in LiNEAR", format(longUsd), `${stakedNear.toFixed(3)} NEAR`, true)}
          {pan(rx, ry, "Short on Hyperliquid", format(shortUsd), `${v.hedge.currentNear.toFixed(3)} NEAR`, false)}
        </g>
        <circle cx={cx} cy={beamY} r={6} style={{ fill: "var(--parry-brass-fill)" }} />
      </svg>
      <dl className="grid grid-cols-2 gap-4 border-y border-line py-3 text-sm sm:hidden">
        <div>
          <dt className="text-muted">Staked in LiNEAR</dt>
          <dd className="num mt-0.5 text-fg">
            {format(longUsd)} <span className="text-[12px] text-muted">{stakedNear.toFixed(3)} NEAR</span>
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-muted">Short on Hyperliquid</dt>
          <dd className="num mt-0.5 text-fg">
            {format(shortUsd)} <span className="text-[12px] text-muted">{v.hedge.currentNear.toFixed(3)} NEAR</span>
          </dd>
        </div>
      </dl>
      <figcaption className="text-[13px] leading-5 text-muted">
        {level
          ? `Level: the short covers ${formatPercent(v.hedge.hedgeRatio, 0)} of the staked NEAR, so a NEAR price move barely changes a share's value.`
          : v.hedge.currentNear === 0
            ? `The short is not open yet${v.hedge.accountValueUsd <= 0 ? ": the hedge account holds no margin" : ""}. Until it is, the vault holds NEAR's price risk. Target short ${format(targetUsd)}.`
            : `The short is ${gap > 0 ? "smaller" : "larger"} than its ${format(targetUsd)} target; the keeper rebalances it on its next report.`}
      </figcaption>
    </figure>
  );
}

type Metric = "share" | "yield" | "hedge" | "risk" | "insurance" | "basis";
const METRICS = [
  { value: "share", label: "Share price" },
  { value: "yield", label: "Yield" },
  { value: "hedge", label: "Hedge ratio" },
  { value: "risk", label: "Risk score" },
  { value: "insurance", label: "Insurance" },
  { value: "basis", label: "Basis" },
] as const;

const usd = (v: number) => `$${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) >= 1 ? 2 : 4)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** One chart for every series the vault records, picked by name, over 7, 30 or 90 days. */
export function VaultHistory() {
  const [days, setDays] = useState<number>(30);
  const [metric, setMetric] = useState<Metric>("share");
  const q = useVaultHistory(days);
  const points = useMemo(() => ((q.data ?? []) as unknown as VaultPoint[]).map((p) => ({ ...p, s: Date.parse(p.t) / 1000 })).filter((p) => Number.isFinite(p.s)), [q.data]);
  const pick = (f: (p: VaultPoint) => number | null | undefined) => points.flatMap((p) => (typeof f(p) === "number" && Number.isFinite(f(p)) ? [{ t: p.s, v: f(p) as number }] : []));

  const view: { series: Series[]; format: (v: number) => string; note: string; domain?: [number, number] } = (() => {
    switch (metric) {
      case "yield": {
        const staking = pick((p) => p.stakingYieldUsd);
        const total = pick((p) => (p.stakingYieldUsd != null && p.fundingYieldUsd != null ? p.stakingYieldUsd + p.fundingYieldUsd : null));
        return {
          series: [
            { id: "total", label: "Staking and funding", points: total, tone: "brass", area: true },
            { id: "staking", label: "Staking alone", points: staking, tone: "text", area: true },
          ],
          format: usd,
          note: "Cumulative dollars earned: the shaded band under the line is staking yield, the band between the lines is funding paid to the short.",
        };
      }
      case "hedge":
        return { series: [{ id: "h", label: "Hedge ratio", points: pick((p) => p.hedgeRatio), tone: "brass" }], format: pct, domain: [0, 1.05], note: "The short over the staked NEAR. The keeper keeps it inside the vault's bounds and lowers it when funding turns against the short." };
      case "risk":
        return { series: [{ id: "r", label: "Risk score", points: pick((p) => p.riskScore), tone: "text" }], format: (v) => v.toFixed(0), domain: [0, 100], note: "The vault's risk score on each report. Over 80 the contract pauses deposits by itself." };
      case "insurance":
        return { series: [{ id: "i", label: "Insurance fund", points: pick((p) => p.insuranceUsd), tone: "brass", area: true }], format: usd, note: "The fund's value in dollars. It fills with a share of positive yield and pays only the three cases it is for." };
      case "basis":
        return {
          series: [
            { id: "b", label: "Basis, a year", points: pick((p) => p.basisApr), tone: "brass" },
            { id: "d", label: "Drawdown", points: pick((p) => (p.drawdown != null ? -p.drawdown : null)), tone: "critical", dashed: true },
          ],
          format: pct,
          note: "Basis: staking yield plus the funding the short earns, a year. Drawdown: how far the share price sits under its best so far.",
        };
      default:
        return { series: [{ id: "s", label: "Share price", points: pick((p) => p.sharePriceUsd), tone: "brass", area: true }], format: (v) => `$${v.toFixed(4)}`, note: "One share was worth one dollar at the first deposit; it grows with staking yield and funding." };
    }
  })();
  const empty = view.series.every((s) => s.points.length < 2);

  return (
    <section className="surface p-6" aria-labelledby="history-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 id="history-title" className="text-[15px] text-fg">
          History
        </h2>
        <Segmented label="Time range" options={DAYS} value={days as 7 | 30 | 90} onChange={setDays} />
      </div>
      <div className="mt-4 flex flex-wrap gap-1" role="tablist" aria-label="Series">
        {METRICS.map((m) => (
          <button
            key={m.value}
            role="tab"
            aria-selected={metric === m.value}
            onClick={() => setMetric(m.value)}
            className={cn("rounded-full px-3 py-1.5 text-[13px] transition-colors duration-[var(--dur-1)]", metric === m.value ? "bg-fg/[0.07] text-fg" : "text-muted hover:text-fg")}
          >
            {m.label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Skeleton height="280px" shape="block" className="mt-5" />
      ) : empty ? (
        <div className="mt-5 grid h-[280px] place-items-center border-y border-line text-center text-sm text-muted">
          <p className="max-w-sm">The vault has not recorded this series over these {days} days yet. It records one point every report.</p>
        </div>
      ) : (
        <SeriesChart className="mt-5" label={`${METRICS.find((m) => m.value === metric)?.label}, last ${days} days`} height={280} series={view.series} format={view.format} domain={view.domain} />
      )}
      <p className="mt-3 text-[13px] leading-5 text-muted">{view.note}</p>
    </section>
  );
}

/** Each distinct proof-of-reserves root the vault published, newest first. */
export function ReserveRoots() {
  const q = useVaultHistory(90);
  const roots = useMemo(() => {
    const out: { root: string; t: string }[] = [];
    for (const p of (q.data ?? []) as unknown as VaultPoint[]) if (p.reservesRoot && out[out.length - 1]?.root !== p.reservesRoot) out.push({ root: p.reservesRoot, t: p.t });
    return out.reverse().slice(0, 12);
  }, [q.data]);
  if (!roots.length) return null;
  return (
    <div className="grid gap-2">
      <div className="label">Every root published, last 90 days</div>
      <ol className="divide-y divide-line border-y border-line text-[13px]">
        {roots.map((r, i) => (
          <li key={`${r.root}-${r.t}`} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-2">
            <span className="num text-fg" title={r.root}>
              {shortId(r.root, 12, 8)}
              {i === 0 ? <span className="ml-2 text-muted">current</span> : null}
            </span>
            <span className="text-muted">{new Date(r.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const PAYS: [string, string][] = [
  ["Negative funding streaks", "When the short pays funding for more than a day in a row, the fund covers it so a share does not shrink."],
  ["Hedge slippage beyond the band", "When a rebalance fills worse than the price band allows, the fund pays the difference."],
  ["Hyperliquid margin top-ups", "When the short's margin runs low, the fund tops it up before it can be liquidated."],
];

/** The insurance fund: what it holds, what it has paid, and the three things it pays for. */
export function Insurance() {
  const q = useInsurance();
  const rates = useRatesLive();
  const { format } = useMoney();
  const ins = q.data;
  const share = ins?.shareBps ?? rates.data?.vault?.insuranceShareBps ?? 1000;
  const live = !!ins?.available;
  const e6 = (s: string | undefined) => Number(s ?? 0) / 1e6;
  return (
    <section className="surface p-6" aria-labelledby="insurance-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 id="insurance-title" className="text-[15px] text-fg">
          Insurance fund
        </h2>
        <span className="text-[13px] text-muted">{(share / 100).toFixed(0)}% of positive yield goes in</span>
      </div>
      {live ? (
        <dl className="ruled mt-5 grid-cols-2 sm:grid-cols-4">
          {[
            ["Held", format(e6(ins.valueUsdE6))],
            ["Paid out in total", format(e6(ins.paidTotalE6))],
            ["Paid today", format(e6(ins.paidTodayE6))],
            ["Daily cap", ins.capPerDayBps !== null ? `${(ins.capPerDayBps / 100).toFixed(1)}% of NAV` : "none"],
          ].map(([k, val]) => (
            <div key={k} className="p-4">
              <dt className="label">{k}</dt>
              <dd className="num mt-1.5 text-lg text-fg">{val}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">{q.isPending ? "Reading the fund." : `The fund is not live on this vault yet (${ins?.source ?? "no reading"}). Its rules are fixed in the vault contract:`}</p>
      )}
      <ul className="mt-5 grid gap-3 sm:grid-cols-3">
        {PAYS.map(([k, body]) => (
          <li key={k} className="border-t border-line pt-3">
            <div className="text-sm text-fg">{k}</div>
            <p className="mt-1 text-[12.5px] leading-5 text-muted">{body}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12.5px] leading-5 text-muted">It pays nothing else, and never more than the daily cap. Every inflow and payout is an event on the vault contract, and the fund is a leaf in the proof of reserves.</p>
      {live && ins.events.length ? (
        <ol className="mt-4 divide-y divide-line border-y border-line text-[13px]">
          {ins.events.slice(0, 8).map((e, i) => (
            <li key={i} className="flex justify-between gap-6 py-2">
              <span className="text-fg">{e.kind === "inflow" ? "Inflow" : `Payout${typeof e.reason === "string" ? `, ${e.reason.replace(/_/g, " ")}` : ""}`}</span>
              <span className="text-muted">{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** Where a share's growth comes from: live rates with their sources, and what the vault has earned. */
export function YieldSources({ v }: { v: Vault }) {
  const rates = useRatesLive();
  const { format } = useMoney();
  const vr = rates.data?.vault;
  const rows: [string, string, string | undefined][] = [
    ["Staking, a year", vr?.stakingApr != null ? formatPercent(vr.stakingApr, 2) : v.yield.stakingApr !== null ? formatPercent(v.yield.stakingApr, 2) : "not enough history", vr?.source],
    ["Funding to the short, a year", vr?.fundingApr != null ? formatPercent(vr.fundingApr, 2) : "n/a", rates.data?.hyperliquid?.source],
    ["Net, a year", vr?.netApr != null ? formatPercent(vr.netApr, 2) : "n/a", undefined],
    ["Funding received", format(v.yield.fundingUsd, { signed: true }), undefined],
    ["Hedge profit and loss", format(v.yield.hedgePnlUsd, { signed: true }), undefined],
    ["Staked", `${fromUnits(v.stakedLinear, 24, 3)} LiNEAR at ${v.linearRate.toFixed(4)} NEAR`, undefined],
  ];
  return (
    <section className="surface p-6" aria-labelledby="yield-title">
      <h2 id="yield-title" className="text-[15px] text-fg">
        Yield
      </h2>
      <dl className="mt-4 divide-y divide-line">
        {rows.map(([k, val, src]) => (
          <div key={k} className="flex flex-wrap items-end justify-between gap-x-6 gap-y-0.5 py-2.5">
            <dt className="text-sm text-muted">
              {k}
              {src ? <span className="block max-w-[18rem] truncate text-[11.5px] text-muted/80" title={src}>{src}</span> : null}
            </dt>
            <dd className="num text-sm text-fg">{val}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
