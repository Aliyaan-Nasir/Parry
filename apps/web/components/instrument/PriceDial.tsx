"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

const SWEEP = 135; // degrees either side of straight up
const r1 = (n: number) => Math.round(n * 100) / 100;

/**
 * A physical dial for a price move: turn the knob (drag, or the arrow keys when it has focus) and
 * the centre shows where NEAR would trade. Engraved "Testnet oracle", because it only ever moves
 * the test oracle's price.
 */
export function PriceDial({ value, min, max, onChange, price, disabled, className }: { value: number; min: number; max: number; onChange: (v: number) => void; price: number | null; disabled?: boolean; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const S = 280;
  const c = S / 2;
  const R = 112;
  const angle = (v: number) => ((v - min) / (max - min)) * 2 * SWEEP - SWEEP;
  const pt = (deg: number, rad: number): [number, number] => [r1(c + rad * Math.sin((deg * Math.PI) / 180)), r1(c - rad * Math.cos((deg * Math.PI) / 180))];
  const arc = (from: number, to: number, rad: number) => {
    const [x1, y1] = pt(from, rad);
    const [x2, y2] = pt(to, rad);
    return `M${x1} ${y1} A ${rad} ${rad} 0 ${Math.abs(to - from) > 180 ? 1 : 0} ${to > from ? 1 : 0} ${x2} ${y2}`;
  };
  const a = angle(value);
  const zero = angle(0);
  const next = price !== null ? price * (1 + value / 100) : null;

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * S - c;
    const y = ((e.clientY - box.top) / box.height) * S - c;
    const deg = Math.max(-SWEEP, Math.min(SWEEP, (Math.atan2(x, -y) * 180) / Math.PI));
    onChange(Math.round(min + ((deg + SWEEP) / (2 * SWEEP)) * (max - min)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const to = e.key === "ArrowRight" || e.key === "ArrowUp" ? value + step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? value - step : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (to === null) return;
    e.preventDefault();
    onChange(Math.max(min, Math.min(max, to)));
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${S} ${S}`}
      className={cn("mx-auto block w-full max-w-[19rem] touch-none select-none outline-none [&:focus-visible_.dial-knob]:stroke-brass", disabled ? "opacity-60" : "cursor-grab active:cursor-grabbing", className)}
      role="slider"
      aria-label="Move"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value > 0 ? "+" : ""}${value}%${next !== null ? `, NEAR at ${next.toFixed(2)} dollars` : ""}`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={disabled ? undefined : onKey}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={(e) => {
        if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
      }}
    >
      <defs>
        <radialGradient id="dial-face" cx="50%" cy="38%" r="65%">
          <stop offset="0" style={{ stopColor: "var(--parry-raised)" }} />
          <stop offset="1" style={{ stopColor: "var(--parry-surface)" }} />
        </radialGradient>
      </defs>
      {/* The bezel and the scale. */}
      <circle cx={c} cy={c} r={R + 18} style={{ fill: "var(--parry-surface)", stroke: "var(--parry-line-strong)" }} />
      <path d={arc(-SWEEP, SWEEP, R)} fill="none" style={{ stroke: "var(--parry-line)" }} strokeWidth={8} strokeLinecap="round" />
      {value !== 0 ? <path d={arc(Math.min(zero, a), Math.max(zero, a), R)} fill="none" style={{ stroke: value < 0 ? "var(--parry-critical)" : "var(--parry-brass-fill)" }} strokeWidth={8} strokeLinecap="round" opacity={0.85} /> : null}
      {Array.from({ length: (max - min) / 5 + 1 }, (_, i) => min + i * 5).map((v) => {
        const major = v % 20 === 0;
        const [x1, y1] = pt(angle(v), R - 10);
        const [x2, y2] = pt(angle(v), R - (major ? 22 : 16));
        const [tx, ty] = pt(angle(v), R + 13);
        return (
          <g key={v}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: "var(--parry-muted)" }} strokeOpacity={major ? 0.85 : 0.4} />
            {major ? (
              <text x={tx} y={ty + 3.5} textAnchor="middle" className="num" style={{ fill: "var(--parry-muted)", fontSize: 10 }}>
                {v > 0 ? `+${v}` : v}
              </text>
            ) : null}
          </g>
        );
      })}
      {/* The knob, its pointer and the reading. */}
      <circle className="dial-knob" cx={c} cy={c} r={R - 32} style={{ fill: "url(#dial-face)", stroke: "var(--parry-line-strong)" }} strokeWidth={1.5} />
      <g transform={`rotate(${r1(a)} ${c} ${c})`} style={{ transition: "transform var(--dur-1) var(--ease-out)" }}>
        <line x1={c} y1={c - (R - 36)} x2={c} y2={c - (R - 47)} style={{ stroke: "var(--parry-text)" }} strokeWidth={3} strokeLinecap="round" />
      </g>
      <text x={c} y={c - 8} textAnchor="middle" className="num" style={{ fill: "var(--parry-text)", fontSize: 30 }}>
        {next !== null ? `$${next.toFixed(2)}` : `${value}%`}
      </text>
      <text x={c} y={c + 16} textAnchor="middle" className="num" style={{ fill: value < 0 ? "var(--parry-critical)" : "var(--parry-muted)", fontSize: 13 }}>
        {value > 0 ? "+" : ""}
        {value}%
      </text>
      <text x={c} y={c + 44} textAnchor="middle" style={{ fill: "var(--parry-muted)", fontSize: 10, letterSpacing: "0.08em" }}>
        Testnet oracle
      </text>
    </svg>
  );
}
