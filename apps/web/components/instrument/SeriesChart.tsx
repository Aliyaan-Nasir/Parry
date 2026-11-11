"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export type Series = {
  id: string;
  label: string;
  points: readonly { t: number; v: number }[];
  /** "text", "brass", "muted" or a risk color name. */
  tone?: "text" | "brass" | "muted" | "critical" | "safe";
  dashed?: boolean;
  /** Shade the area under this series. */
  area?: boolean;
};

export type ChartLine = { v: number; label: string; tone?: "brass" | "critical" | "muted" | "text"; dashed?: boolean };
export type ChartZone = { from: number; to: number; tone: "critical" | "danger" | "caution" | "safe" | "brass"; label?: string };
export type ChartEvent = { t: number; label: string; href?: string };

const color = (tone: string | undefined) =>
  tone === "brass" ? "var(--parry-brass-fill)" : tone === "muted" ? "var(--parry-muted)" : tone === "critical" ? "var(--parry-critical)" : tone === "safe" ? "var(--parry-safe)" : tone === "danger" ? "var(--parry-danger)" : tone === "caution" ? "var(--parry-caution)" : "var(--parry-text)";

/**
 * A calm time-series chart for health, prices, NAV and yields: hairline guides, shaded zones (the
 * liquidation zone first of all), reference lines (trigger, target), event marks on the timeline
 * (guardian actions), and a hover crosshair with a readout of every series at that time.
 */
export function SeriesChart({
  series,
  lines = [],
  zones = [],
  events = [],
  height = 280,
  format = (v) => v.toFixed(2),
  formatTime = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  domain,
  className,
  label,
}: {
  series: readonly Series[];
  lines?: readonly ChartLine[];
  zones?: readonly ChartZone[];
  events?: readonly ChartEvent[];
  height?: number;
  format?: (v: number) => string;
  formatTime?: (t: number) => string;
  /** Fixed value range; otherwise fitted to the data and the lines. */
  domain?: [number, number];
  className?: string;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hx, setHx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <div ref={wrap} className={cn("grid place-items-center text-sm text-muted", className)} style={{ height }}>No data yet</div>;
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const vs = [...all.map((p) => p.v), ...lines.map((l) => l.v)];
  let [lo, hi] = domain ?? [Math.min(...vs), Math.max(...vs)];
  if (!domain) {
    const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.12;
    lo -= pad;
    hi += pad;
  }
  const left = 8;
  const right = 52;
  const top = 12;
  const bottom = height - 26;
  const w = Math.max(1, width - left - right);
  const x = (t: number) => Math.round((left + ((t - t0) / Math.max(1, t1 - t0)) * w) * 10) / 10;
  const y = (v: number) => Math.round((top + ((hi - v) / Math.max(1e-9, hi - lo)) * (bottom - top)) * 10) / 10;
  const guides = Array.from({ length: 4 }, (_, i) => lo + ((i + 0.5) / 4) * (hi - lo));
  const path = (pts: readonly { t: number; v: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)} ${y(p.v)}`).join("");
  const at = hx !== null ? t0 + ((hx - left) / w) * (t1 - t0) : null;
  const nearest = (pts: readonly { t: number; v: number }[]) => (at === null || pts.length === 0 ? null : pts.reduce((a, b) => (Math.abs(b.t - at) < Math.abs(a.t - at) ? b : a)));

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    setHx(px < left || px > left + w ? null : px);
  };

  return (
    <div ref={wrap} className={cn("relative w-full", className)} style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} className="block touch-pan-y" role="img" aria-label={label} onPointerMove={move} onPointerLeave={() => setHx(null)}>
          {zones.map((z, i) => (
            <rect key={i} x={left} width={w} y={y(Math.min(hi, Math.max(z.from, z.to)))} height={Math.max(0, y(Math.max(lo, Math.min(z.from, z.to))) - y(Math.min(hi, Math.max(z.from, z.to))))} style={{ fill: color(z.tone) }} opacity={0.09} />
          ))}
          {guides.map((g) => (
            <g key={g}>
              <line x1={left} x2={left + w} y1={y(g)} y2={y(g)} style={{ stroke: "var(--parry-line)" }} />
              <text x={left + w + 8} y={y(g) + 4} className="num" style={{ fill: "var(--parry-muted)", fontSize: 10.5 }}>
                {format(g)}
              </text>
            </g>
          ))}
          {lines.map((l) => (
            <g key={l.label}>
              <line x1={left} x2={left + w} y1={y(l.v)} y2={y(l.v)} style={{ stroke: color(l.tone) }} strokeWidth={1.2} strokeDasharray={l.dashed ? "5 5" : undefined} />
              <text x={left + 6} y={y(l.v) - 6} style={{ fill: color(l.tone), fontSize: 11 }}>
                {l.label}
              </text>
            </g>
          ))}
          {series.map((s) =>
            s.area ? <path key={`${s.id}-a`} d={`${path(s.points)}L${x(s.points[s.points.length - 1]!.t)} ${bottom}L${x(s.points[0]!.t)} ${bottom}Z`} style={{ fill: color(s.tone) }} opacity={0.07} /> : null,
          )}
          {series.map((s) => (
            <path key={s.id} d={path(s.points)} fill="none" style={{ stroke: color(s.tone) }} strokeWidth={s.tone === "muted" ? 1.4 : 2} strokeDasharray={s.dashed ? "4 5" : undefined} strokeLinejoin="round" />
          ))}
          {events.map((e, i) => (
            <g key={i} transform={`translate(${x(e.t)} ${bottom})`}>
              <title>{e.label}</title>
              <line y1={-(bottom - top)} y2={0} style={{ stroke: "var(--parry-brass-fill)" }} strokeOpacity={0.45} strokeDasharray="2 3" />
              <rect x={-4} y={-4} width={8} height={8} transform="rotate(45)" style={{ fill: "var(--parry-brass-fill)" }} />
            </g>
          ))}
          <line x1={left} x2={left + w} y1={bottom} y2={bottom} style={{ stroke: "var(--parry-line-strong)" }} />
          <text x={left} y={height - 6} style={{ fill: "var(--parry-muted)", fontSize: 10.5 }}>
            {formatTime(t0)}
          </text>
          <text x={left + w} y={height - 6} textAnchor="end" style={{ fill: "var(--parry-muted)", fontSize: 10.5 }}>
            {formatTime(t1)}
          </text>
          {hx !== null ? <line x1={hx} x2={hx} y1={top} y2={bottom} style={{ stroke: "var(--parry-text)" }} strokeOpacity={0.35} /> : null}
          {hx !== null
            ? series.map((s) => {
                const n = nearest(s.points);
                return n ? <circle key={s.id} cx={x(n.t)} cy={y(n.v)} r={3.5} style={{ fill: color(s.tone), stroke: "var(--parry-bg)" }} strokeWidth={1.5} /> : null;
              })
            : null}
        </svg>
      ) : null}
      {hx !== null && at !== null ? (
        <div className="surface-raised pointer-events-none absolute top-2 px-3 py-2 text-xs" style={{ left: Math.min(Math.max(8, hx + 12), Math.max(8, width - 200)) }}>
          <div className="text-muted">{formatTime(at)}</div>
          {series.map((s) => {
            const n = nearest(s.points);
            return n ? (
              <div key={s.id} className="mt-1 flex items-center justify-between gap-4">
                <span className="text-fg/80">{s.label}</span>
                <span className="num text-fg">{format(n.v)}</span>
              </div>
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}
