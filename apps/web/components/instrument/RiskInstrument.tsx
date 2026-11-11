"use client";

import Link from "next/link";
import { m, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/cn";

/**
 * Parry's risk instrument: a health scale that replaces every tier chip. Health runs left to right
 * on a log scale from just under liquidation (1.0, a hatched edge) to comfortably safe; the zones
 * are a soft field of the risk colors; a needle settles on the current health with a spring; a
 * ghost shows where health could be in 24 hours (the model's 80 % band); the owner's trigger and
 * target can be handles to drag; small marks show where the guardian acted.
 */

export type InstrumentMark = { health: number; label: string; href?: string };

type Variant = "compact" | "standard" | "hero";

export type RiskInstrumentProps = {
  /** Current health; null or Infinity when there is no debt. */
  health: number | null;
  /** The tier as a plain word ("safe", "caution", "danger", "critical"); derived from health if omitted. */
  tier?: string;
  variant?: Variant;
  /** Annualized volatility of the collateral's price, for the 24 h projection (0.6 = 60 %). */
  annualVol?: number | null;
  /** Hourly trend of the collateral's price (log), for the projection's median. */
  trendHourly?: number;
  trigger?: number | null;
  target?: number | null;
  onTriggerChange?: (v: number) => void;
  onTargetChange?: (v: number) => void;
  marks?: readonly InstrumentMark[];
  /** Hide the number beside the scale (for tables that show it in their own column). */
  hideValue?: boolean;
  label?: string;
  className?: string;
};

const MIN = 0.9;
const MAX = 3;
const TICKS = [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 2, 2.25, 2.5, 3];
const MAJOR = new Set([1, 1.2, 1.5, 2, 3]);
const SPRING = { type: "spring", stiffness: 260, damping: 26, mass: 0.9 } as const;

export function healthTier(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return "no debt";
  if (h < 1.05) return "critical";
  if (h < 1.15) return "danger";
  if (h < 1.35) return "caution";
  return "safe";
}

const clampH = (h: number) => Math.min(MAX, Math.max(MIN, h));
/** Rounded so the server and the client draw the same coordinates. */
const r = (v: number) => Math.round(v * 100) / 100;
const frac = (h: number) => (Math.log(clampH(h)) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN));
const fromFrac = (f: number) => Math.exp(Math.log(MIN) + Math.min(1, Math.max(0, f)) * (Math.log(MAX) - Math.log(MIN)));

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The 24 h projection: health scales with the collateral's price, so the band is lognormal. */
export function projection(health: number, annualVol: number, trendHourly = 0) {
  const sigma24 = (annualVol / Math.sqrt(8760)) * Math.sqrt(24);
  const mu = trendHourly * 24;
  const z = 1.2816; // 80 % two-sided
  return { median: health * Math.exp(mu), low: health * Math.exp(mu - z * sigma24), high: health * Math.exp(mu + z * sigma24) };
}

const format = (h: number | null) => (h === null || !Number.isFinite(h) ? "No debt" : h < 1 ? (Math.floor(h * 100) / 100).toFixed(2) : h.toFixed(2));

export function RiskInstrument({
  health,
  tier,
  variant = "standard",
  annualVol,
  trendHourly = 0,
  trigger,
  target,
  onTriggerChange,
  onTargetChange,
  marks = [],
  hideValue,
  label = "Health",
  className,
}: RiskInstrumentProps) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const finite = health !== null && Number.isFinite(health);
  const word = tier ?? healthTier(health);
  const compact = variant === "compact";
  const pad = compact ? 2 : 14;
  const w = Math.max(0, width - pad * 2);
  const x = (h: number) => r(pad + frac(h) * w);
  // Rows (standard and hero): handle labels at the top, the 24 h ghost, the zone field down to
  // the scale line, then ticks and their labels.
  const scaleY = compact ? 12 : 64;
  const bandH = compact ? 10 : 22;
  const ghostY = scaleY - bandH - 12;
  const height = compact ? 26 : 96;
  const proj = finite && annualVol && !compact ? projection(health, annualVol, trendHourly) : null;
  const needleX = finite ? x(health) : x(MAX);
  // Major ticks get a label only where it clears the one before it, so a narrow scale stays legible.
  const labelled = new Set<number>();
  let lastLabel = -Infinity;
  for (const t of TICKS) {
    if (MAJOR.has(t) && x(t) - lastLabel >= 30) {
      labelled.add(t);
      lastLabel = x(t);
    }
  }

  return (
    <div className={cn("flex w-full items-center gap-5", compact && "gap-3", className)}>
      <div className="min-w-0 flex-1">
        {variant === "hero" ? <Arc health={health} reduced={!!reduced} /> : null}
        <div ref={wrapRef} className="relative w-full" style={{ height }}>
          {width > 0 ? (
            <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={`${label} ${format(health)}, ${word}`}>
              <defs>
                <linearGradient id={`field-${id}`} x1="0" x2="1" y1="0" y2="0">
                  <stop offset={frac(1)} style={{ stopColor: "var(--parry-critical)" }} />
                  <stop offset={frac(1.1)} style={{ stopColor: "var(--parry-danger)" }} />
                  <stop offset={frac(1.25)} style={{ stopColor: "var(--parry-caution)" }} />
                  <stop offset={frac(1.55)} style={{ stopColor: "var(--parry-safe)" }} />
                  <stop offset="1" style={{ stopColor: "var(--parry-safe)" }} />
                </linearGradient>
                <linearGradient id={`fade-${id}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#fff" stopOpacity="0" />
                  <stop offset="1" stopColor="#fff" stopOpacity="1" />
                </linearGradient>
                <mask id={`fieldmask-${id}`}>
                  <rect x={0} y={scaleY - bandH} width={width} height={bandH} fill={`url(#fade-${id})`} />
                </mask>
                <pattern id={`hatch-${id}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: "var(--parry-critical)" }} strokeWidth="1.4" />
                </pattern>
              </defs>

              {/* The zone field, fading up from the scale. */}
              <rect x={pad} y={scaleY - bandH} width={w} height={bandH} fill={`url(#field-${id})`} mask={`url(#fieldmask-${id})`} opacity={compact ? 0.45 : 0.32} />
              {/* The scale line in the zone colors. */}
              <rect x={pad} y={scaleY} width={w} height={compact ? 2 : 2} fill={`url(#field-${id})`} opacity={0.9} rx={1} />
              {/* Liquidation: a hatched edge left of 1.0. */}
              <rect x={pad} y={scaleY - bandH} width={Math.max(0, x(1) - pad)} height={bandH + 2} fill={`url(#hatch-${id})`} opacity={0.55} />
              <line x1={x(1)} x2={x(1)} y1={scaleY - bandH - (compact ? 0 : 6)} y2={scaleY + (compact ? 2 : 8)} style={{ stroke: "var(--parry-critical)" }} strokeWidth={1.5} />

              {/* Ticks. */}
              {!compact
                ? TICKS.map((t) => (
                    <g key={t}>
                      <line x1={x(t)} x2={x(t)} y1={scaleY + 4} y2={scaleY + (MAJOR.has(t) ? 11 : 7)} style={{ stroke: "var(--parry-muted)" }} strokeOpacity={MAJOR.has(t) ? 0.7 : 0.35} strokeWidth={1} />
                      {labelled.has(t) ? (
                        <text x={x(t)} y={scaleY + 25} textAnchor="middle" className="num" style={{ fill: "var(--parry-muted)", fontSize: 11 }}>
                          {t === 1 ? "1.00" : t.toFixed(t % 1 ? 1 : 0)}
                        </text>
                      ) : null}
                    </g>
                  ))
                : null}

              {/* The 24 h projection: a ghost band and needle. */}
              {proj ? (
                <g aria-hidden="true">
                  <rect x={x(proj.low)} y={ghostY - 2} width={r(Math.max(2, x(proj.high) - x(proj.low)))} height={4} rx={2} style={{ fill: "var(--parry-text)" }} opacity={0.14} />
                  <line x1={x(proj.median)} x2={x(proj.median)} y1={ghostY - 5} y2={scaleY} style={{ stroke: "var(--parry-text)" }} strokeOpacity={0.3} strokeDasharray="2 3" />
                </g>
              ) : null}

              {/* Guardian action marks. */}
              {!compact
                ? marks.map((m, i) => (
                    <MarkPin key={`${m.health}-${i}`} x={x(m.health)} y={scaleY - 8} mark={m} />
                  ))
                : null}

              {/* Trigger and target handles. */}
              {!compact && trigger ? <Handle kind="trigger" value={trigger} x={x} fromX={(px) => fromFrac((px - pad) / Math.max(1, w))} y={scaleY} onChange={onTriggerChange} min={1.02} max={target ? target - 0.05 : 1.5} /> : null}
              {!compact && target ? <Handle kind="target" value={target} x={x} fromX={(px) => fromFrac((px - pad) / Math.max(1, w))} y={scaleY} onChange={onTargetChange} min={trigger ? trigger + 0.05 : 1.1} max={3} /> : null}

              {/* The needle. */}
              <m.g initial={false} animate={{ x: needleX }} transition={reduced ? { duration: 0 } : SPRING}>
                <line x1={0} x2={0} y1={scaleY - bandH - (compact ? 2 : 4)} y2={scaleY + (compact ? 4 : 7)} style={{ stroke: "var(--parry-text)" }} strokeWidth={2} strokeLinecap="round" />
                {!compact ? <circle cx={0} cy={scaleY - bandH - 6} r={3.5} style={{ fill: "var(--parry-text)" }} /> : null}
              </m.g>
            </svg>
          ) : null}
        </div>
      </div>
      {!hideValue ? (
        <div className={cn("shrink-0 text-right", compact ? "w-20" : "w-32")}>
          <div className={cn("num leading-none tracking-tight text-fg", compact ? "text-base" : variant === "hero" ? "text-5xl" : "text-4xl")}>{format(health)}</div>
          <div className={cn("mt-1.5 text-fg/70", compact ? "text-xs" : "text-sm")}>{word === "no debt" ? "nothing to liquidate" : word}</div>
          {proj ? (
            <div className="mt-3 text-xs leading-snug text-muted">
              In 24 h
              <br />
              <span className="num text-fg/80">
                {format(proj.low)} to {format(proj.high)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MarkPin({ x, y, mark }: { x: number; y: number; mark: InstrumentMark }) {
  const body = (
    <g transform={`translate(${x} ${y})`} className="cursor-pointer">
      <title>{mark.label}</title>
      <rect x={-3.5} y={-3.5} width={7} height={7} transform="rotate(45)" style={{ fill: "var(--parry-brass-fill)", stroke: "var(--parry-bg)" }} strokeWidth={1.5} />
    </g>
  );
  return mark.href ? (
    <Link href={mark.href} aria-label={mark.label}>
      {body}
    </Link>
  ) : (
    body
  );
}

function Handle({
  kind,
  value,
  x,
  fromX,
  y,
  onChange,
  min,
  max,
}: {
  kind: "trigger" | "target";
  value: number;
  x: (h: number) => number;
  fromX: (px: number) => number;
  y: number;
  onChange?: (v: number) => void;
  min: number;
  max: number;
}) {
  const dragging = useRef(false);
  const ref = useRef<SVGGElement>(null);
  const set = useCallback((v: number) => onChange?.(Math.round(Math.min(max, Math.max(min, v)) * 100) / 100), [onChange, min, max]);
  const move = (e: ReactPointerEvent<SVGGElement>) => {
    if (!dragging.current) return;
    const svg = ref.current?.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    set(fromX(e.clientX - r.left));
  };
  const key = (e: KeyboardEvent<SVGGElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") set(value + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(value - step);
    else return;
    e.preventDefault();
  };
  const hx = x(value);
  const editable = !!onChange;
  const name = kind === "trigger" ? "Trigger" : "Target";
  return (
    <g
      ref={ref}
      transform={`translate(${hx} 0)`}
      role={editable ? "slider" : undefined}
      aria-label={editable ? `${name} health` : undefined}
      aria-valuemin={editable ? min : undefined}
      aria-valuemax={editable ? max : undefined}
      aria-valuenow={editable ? value : undefined}
      tabIndex={editable ? 0 : undefined}
      onKeyDown={editable ? key : undefined}
      onPointerDown={(e) => {
        if (!editable) return;
        dragging.current = true;
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      className={cn(editable && "cursor-ew-resize outline-none [&:focus-visible_circle]:stroke-[3]")}
      style={{ touchAction: "none" }}
    >
      <line x1={0} x2={0} y1={14} y2={y} style={{ stroke: kind === "trigger" ? "var(--parry-brass)" : "var(--parry-text)" }} strokeOpacity={0.7} strokeWidth={1} strokeDasharray={kind === "target" ? "3 3" : undefined} />
      <circle cx={0} cy={y + 1} r={editable ? 7 : 4.5} style={{ fill: "var(--parry-bg)", stroke: kind === "trigger" ? "var(--parry-brass-fill)" : "var(--parry-text)" }} strokeWidth={2} />
      <text x={kind === "trigger" ? -6 : 6} y={10} textAnchor={kind === "trigger" ? "end" : "start"} style={{ fill: "var(--parry-muted)", fontSize: 10.5 }}>
        {name} <tspan className="num" style={{ fill: "var(--parry-text)" }}>{value.toFixed(2)}</tspan>
      </text>
    </g>
  );
}

/** The hero variant's radial arc: the same scale bent into a half circle, with its own needle. */
function Arc({ health, reduced }: { health: number | null; reduced: boolean }) {
  const id = useId().replace(/:/g, "");
  const finite = health !== null && Number.isFinite(health);
  const R = 120;
  const cx = 150;
  const cy = 140;
  const angle = (h: number) => Math.PI * (1 - frac(h)); // 180° at liquidation side, 0° safe
  const pt = (a: number, rr = R) => [r(cx + rr * Math.cos(a)), r(cy - rr * Math.sin(a))] as const;
  const arcPath = (from: number, to: number, rr = R) => {
    const [x1, y1] = pt(angle(from), rr);
    const [x2, y2] = pt(angle(to), rr);
    return `M${x1} ${y1} A ${rr} ${rr} 0 0 1 ${x2} ${y2}`;
  };
  // The needle settles on a spring, rotated about the hub.
  const deg = useSpringNumber(finite ? 90 - (angle(health) * 180) / Math.PI : 90, reduced);
  return (
    <svg viewBox="0 0 300 160" className="mx-auto mb-2 block w-full max-w-[420px]" aria-hidden="true">
      <defs>
        <linearGradient id={`arc-${id}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: "var(--parry-critical)" }} />
          <stop offset="0.3" style={{ stopColor: "var(--parry-danger)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--parry-caution)" }} />
          <stop offset="0.75" style={{ stopColor: "var(--parry-safe)" }} />
        </linearGradient>
      </defs>
      <path d={arcPath(MIN, MAX)} fill="none" stroke={`url(#arc-${id})`} strokeWidth={10} strokeLinecap="butt" opacity={0.28} />
      <path d={arcPath(MIN, 1)} fill="none" style={{ stroke: "var(--parry-critical)" }} strokeWidth={10} opacity={0.6} strokeDasharray="2 2" />
      {TICKS.map((t) => {
        const [x1, y1] = pt(angle(t), R - 12);
        const [x2, y2] = pt(angle(t), R - (MAJOR.has(t) ? 22 : 17));
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: "var(--parry-muted)" }} strokeOpacity={MAJOR.has(t) ? 0.8 : 0.4} />;
      })}
      <line x1={cx} y1={cy} x2={cx} y2={cy - R + 6} transform={`rotate(${r(deg)} ${cx} ${cy})`} style={{ stroke: "var(--parry-text)" }} strokeWidth={2} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={5} style={{ fill: "var(--parry-brass-fill)" }} />
    </svg>
  );
}

/**
 * A number that follows its target on a damped spring (stiffness 260, damping 26), one frame at a
 * time. It starts at the target, so the server render and the first client render agree.
 */
function useSpringNumber(target: number, reduced: boolean): number {
  const [value, setValue] = useState(target);
  const state = useRef({ x: target, v: 0 });
  useEffect(() => {
    let raf = 0;
    if (reduced) {
      state.current = { x: target, v: 0 };
      raf = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(raf);
    }
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const s = state.current;
      const a = -260 * (s.x - target) - 26 * s.v;
      s.v += a * dt;
      s.x += s.v * dt;
      setValue(s.x);
      if (Math.abs(s.x - target) > 0.01 || Math.abs(s.v) > 0.01) raf = requestAnimationFrame(step);
      else {
        s.x = target;
        s.v = 0;
        setValue(target);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return value;
}
