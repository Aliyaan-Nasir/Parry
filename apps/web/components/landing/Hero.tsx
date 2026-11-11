"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MARK } from "@/components/brand/paths";
import { DitherField } from "@/components/fx/Dither";
import { Magnetic } from "@/components/fx/Magnetic";
import { ButtonLink } from "@/components/ui/Button";

/**
 * The hero: a position's health runs across a live chart toward the liquidation line. Left alone
 * it falls on its own; dragged, it follows the visitor's hand. When it crosses the owner's
 * trigger, Parry's guard swings in like a blade, the strike is turned aside, and health recovers
 * to the target. Server render and reduced motion show one finished deflection.
 */

const W = 1000;
const H = 420;
const SAMPLES = 220;
const LIQ = 1.0;
const TRIGGER = 1.2;
const TARGET = 1.5;
const TOP = 1.95;
const BOTTOM = 0.86;
const y = (h: number) => Math.round((40 + ((TOP - h) / (TOP - BOTTOM)) * (H - 80)) * 10) / 10;
const fromY = (py: number) => TOP - ((py - 40) / (H - 80)) * (TOP - BOTTOM);
const xAt = (i: number) => Math.round((i / (SAMPLES - 1)) * (W - 40) * 10) / 10;

type Sample = { h: number; rescued: boolean };
type Phase = "calm" | "fall" | "strike" | "deflect";

/** A deterministic noise so the first frame is the same on the server and the client. */
function noise(i: number) {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

/** The still: a fall toward liquidation, the turn at the trigger, the recovery. */
function stillSeries(): Sample[] {
  const out: Sample[] = [];
  const strike = 150;
  for (let i = 0; i < SAMPLES; i++) {
    if (i < strike) {
      const t = i / strike;
      out.push({ h: 1.62 - 0.42 * t ** 1.7 + noise(i) * 0.012, rescued: false });
    } else {
      const t = Math.min(1, (i - strike) / 40);
      out.push({ h: TRIGGER + (TARGET - TRIGGER) * (1 - (1 - t) ** 3) + noise(i) * 0.008, rescued: true });
    }
  }
  return out;
}

/** One stroke per kind: the plain fall, and the rescued recovery (joined at the turn). */
function pathOf(series: readonly Sample[], rescued: boolean): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    const next = series[i + 1];
    // A point belongs to its own stroke, and also to the other stroke where that one starts, so
    // the two meet without a gap.
    const prev = series[i - 1];
    const include = s.rescued === rescued || (next !== undefined && next.rescued === rescued) || (prev !== undefined && prev.rescued === rescued);
    if (include) {
      d += `${pen ? "L" : "M"}${xAt(i)} ${y(s.h)}`;
      pen = true;
    } else pen = false;
  }
  return d;
}

export function Hero() {
  return (
    <section className="grain relative isolate overflow-hidden pb-20 pt-32 sm:pt-40">
      {/* Atmosphere: the dither field, the brass horizon arc, and a soft top light. */}
      <DitherField className="absolute inset-x-0 top-[22%] -z-10 h-[60%] w-full opacity-[0.16] [mask-image:radial-gradient(60%_55%_at_50%_75%,#000,transparent)]" />
      <div aria-hidden="true" className="absolute left-1/2 top-[52%] -z-10 h-[900px] w-[1600px] -translate-x-1/2 rounded-[50%] border-t border-brass-fill/50 shadow-[0_-40px_120px_-40px_color-mix(in_oklab,var(--parry-brass-fill)_70%,transparent)] [background:radial-gradient(60%_30%_at_50%_0%,color-mix(in_oklab,var(--parry-brass-fill)_22%,transparent),transparent)]" />
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <h1 className="display text-gradient mx-auto max-w-[14ch] text-center text-[3.4rem] sm:text-[5.5rem] lg:text-[7rem]">Liquidation, turned aside.</h1>
        <p className="mx-auto mt-6 max-w-[38rem] text-center text-lg leading-relaxed text-muted sm:text-xl">
          A guardian that sees trouble hours ahead and steps in on its own, inside limits only you set, with every move reviewed by a verifiable AI. Or earn without liquidation risk at all.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Magnetic>
            <ButtonLink href="/app" size="lg" className="!rounded-full px-7">
              Open the app
            </ButtonLink>
          </Magnetic>
          <ButtonLink href="/check" size="lg" variant="secondary" className="!rounded-full px-7">
            Check any account
          </ButtonLink>
        </div>
        <Deflection />
      </div>
    </section>
  );
}

function Deflection() {
  const [series, setSeries] = useState<Sample[]>(stillSeries);
  const [strike, setStrike] = useState<{ i: number; at: number } | null>({ i: 150, at: 0 });
  const [health, setHealth] = useState(TARGET);
  const [hint, setHint] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ active: boolean; want: number | null }>({ active: false, want: null });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let visible = true;
    let phase: Phase = "calm";
    let phaseAt = performance.now();
    let h = TARGET;
    let v = 0;
    let from = TARGET;
    let i = 0;
    let buf = stillSeries();
    let lastStep = performance.now();
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (!visible || document.hidden) {
        lastStep = now;
        return;
      }
      if (now - lastStep < 1000 / 45) return; // 45 samples a second across a 220 sample window
      lastStep = now;
      i += 1;
      const t = (now - phaseAt) / 1000;
      const want = drag.current.active ? drag.current.want : null;
      if (phase === "calm") {
        h += (TARGET - 0.02 - h) * 0.02 + noise(i) * 0.01;
        if (want !== null) h += (want - h) * 0.18;
        if ((want === null && t > 2.2) || (want !== null && h < TRIGGER + 0.08)) {
          phase = "fall";
          phaseAt = now;
          v = 0;
        }
      } else if (phase === "fall") {
        if (want !== null) h += (want - h) * 0.18;
        else {
          v += 0.00045;
          h -= v + Math.abs(noise(i)) * 0.004;
        }
        h += noise(i * 3) * 0.006;
        if (h <= TRIGGER) {
          phase = "strike";
          phaseAt = now;
          from = h;
          setStrike({ i: SAMPLES - 1, at: now });
        } else if (want !== null && h > TRIGGER + 0.25) {
          phase = "calm";
          phaseAt = now;
        }
      } else if (phase === "strike") {
        h -= 0.002;
        if (t > 0.35) {
          phase = "deflect";
          phaseAt = now;
          from = h;
        }
      } else {
        const k = Math.min(1, t / 0.9);
        h = from + (TARGET - from) * (1 - (1 - k) ** 3) + noise(i) * 0.004;
        if (k >= 1) {
          phase = "calm";
          phaseAt = now;
        }
      }
      h = Math.max(LIQ + 0.02, Math.min(TOP - 0.05, h));
      const rescued = phase === "deflect" || (phase === "calm" && buf[buf.length - 1]!.rescued && t < 1.2);
      buf = [...buf.slice(1), { h, rescued }];
      setSeries(buf);
      setHealth(h);
      setStrike((s) => (s ? { ...s, i: s.i - 1 } : s));
    };
    raf = requestAnimationFrame(step);
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(svg);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);

  const pointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !drag.current.active) return;
    const r = svg.getBoundingClientRect();
    drag.current.want = Math.max(BOTTOM + 0.04, Math.min(TOP - 0.05, fromY(((e.clientY - r.top) / r.height) * H)));
  };

  const last = series[series.length - 1]!;
  const strikeX = strike && strike.i >= 0 ? xAt(strike.i) : null;
  const strikeH = strike && strike.i >= 0 ? series[Math.max(0, strike.i)]?.h ?? TRIGGER : TRIGGER;
  // The ghost: where health was heading without Parry, from the strike down through liquidation.
  const ghost = strikeX !== null ? `M${strikeX} ${y(strikeH)} Q ${strikeX + 70} ${y(strikeH - 0.08)} ${strikeX + 130} ${y(LIQ - 0.05)}` : null;
  const markScale = 2.2;

  return (
    <div className="relative mx-auto mt-16 max-w-[1100px]">
      <div className="surface-glass overflow-hidden p-0 [--edge-angle:180deg]">
        <div className="flex items-center justify-between gap-4 px-5 pt-4 text-[13px] sm:px-7 sm:pt-5">
          <span className="text-muted">A protected position on Rhea</span>
          <span className="text-muted">
            Health <span className="num ml-1 text-base text-fg">{health.toFixed(2)}</span>
          </span>
        </div>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full cursor-ns-resize touch-none select-none"
          role="img"
          aria-label="Health falls toward liquidation; at the trigger Parry steps in and health recovers to the target."
          onPointerDown={(e) => {
            drag.current.active = true;
            setHint(false);
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointer(e);
          }}
          onPointerMove={pointer}
          onPointerUp={() => (drag.current = { active: false, want: null })}
          onPointerCancel={() => (drag.current = { active: false, want: null })}
        >
          <defs>
            <pattern id="hero-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="7" style={{ stroke: "var(--parry-critical)" }} strokeWidth="1.4" />
            </pattern>
            <linearGradient id="hero-fade" x1="0" x2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.12" stopColor="#fff" stopOpacity="1" />
            </linearGradient>
            <mask id="hero-mask">
              <rect width={W} height={H} fill="url(#hero-fade)" />
            </mask>
          </defs>
          {/* Guides. */}
          {[1.2, 1.4, 1.6, 1.8].map((g) => (
            <line key={g} x1={0} x2={W} y1={y(g)} y2={y(g)} style={{ stroke: "var(--parry-line)" }} strokeWidth={1} />
          ))}
          {/* Liquidation: a hatched floor. */}
          <rect x={0} y={y(LIQ)} width={W} height={H - y(LIQ)} fill="url(#hero-hatch)" opacity={0.28} />
          <line x1={0} x2={W} y1={y(LIQ)} y2={y(LIQ)} style={{ stroke: "var(--parry-critical)" }} strokeWidth={1.5} />
          <text x={12} y={y(LIQ) - 8} style={{ fill: "var(--parry-critical)", fontSize: 13 }}>
            Liquidation 1.00
          </text>
          {/* Trigger and target. */}
          <line x1={0} x2={W} y1={y(TRIGGER)} y2={y(TRIGGER)} style={{ stroke: "var(--parry-brass-fill)" }} strokeWidth={1.2} strokeDasharray="5 6" />
          <text x={12} y={y(TRIGGER) - 8} style={{ fill: "var(--parry-brass)", fontSize: 13 }}>
            Your trigger 1.20
          </text>
          <line x1={0} x2={W} y1={y(TARGET)} y2={y(TARGET)} style={{ stroke: "var(--parry-text)" }} strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2 6" />
          <text x={12} y={y(TARGET) - 8} style={{ fill: "var(--parry-muted)", fontSize: 13 }}>
            Target 1.50
          </text>

          <g mask="url(#hero-mask)">
            {ghost ? <path d={ghost} fill="none" style={{ stroke: "var(--parry-muted)" }} strokeWidth={1.6} strokeDasharray="4 6" opacity={0.75} /> : null}
            <path d={pathOf(series, false)} fill="none" style={{ stroke: "var(--parry-text)" }} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
            <path d={pathOf(series, true)} fill="none" style={{ stroke: "var(--parry-brass-fill)" }} strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />
          </g>
          {/* The guard turning the strike aside. */}
          {strikeX !== null ? (
            <g transform={`translate(${strikeX} ${y(TRIGGER)})`}>
              <circle r={26} style={{ fill: "var(--parry-brass-fill)" }} opacity={0.12} />
              <g key={strike?.at} transform={`translate(${-14.25 * markScale} ${-12.5 * markScale}) scale(${markScale})`} className="hero-guard">
                <path d={MARK.guard} style={{ fill: "var(--parry-brass-fill)" }} />
              </g>
            </g>
          ) : null}
          <circle cx={xAt(SAMPLES - 1)} cy={y(last.h)} r={5} style={{ fill: last.rescued ? "var(--parry-brass-fill)" : "var(--parry-text)" }} />
        </svg>
      </div>
      <p className={`mt-4 text-center text-sm text-muted transition-opacity duration-500 ${hint ? "opacity-100" : "opacity-0"}`}>
        Drag the chart to push the price. Parry steps in at your trigger.
      </p>
    </div>
  );
}
