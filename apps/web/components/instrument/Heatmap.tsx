"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { formatUsdCompact } from "@/lib/format";
import { cn } from "@/lib/cn";

export type HeatBucket = { price: number; collateralUsd: number; accounts: number };
export type HeatCascade = { from: number; to: number; collateralUsd: number };

/**
 * Where liquidations sit by price: for each NEAR price level below today's, the collateral that
 * would be liquidated there (bars, shaded by density), the running total as the price falls (a
 * line), chained cascades (brass arcs: liquidations at one level push the price into the next),
 * today's price, and optionally the viewer's own liquidation price and trigger.
 */
export function Heatmap({
  buckets,
  cascades = [],
  price,
  mine,
  height = 260,
  className,
}: {
  buckets: readonly HeatBucket[];
  cascades?: readonly HeatCascade[];
  price: number;
  mine?: { liqPrice?: number | null; triggerPrice?: number | null };
  height?: number;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sorted = [...buckets].filter((b) => b.price > 0).sort((a, b) => b.price - a.price);
  const lo = Math.min(price * 0.35, ...sorted.map((b) => b.price));
  const hi = price * 1.04;
  const padL = 8;
  const padR = 8;
  const top = 26;
  const bottom = height - 30;
  const w = Math.max(0, width - padL - padR);
  // Price falls to the right: the left edge is today, the right edge is a deep crash.
  const x = (p: number) => Math.round((padL + ((hi - p) / (hi - lo)) * w) * 10) / 10;
  const maxC = Math.max(1, ...sorted.map((b) => b.collateralUsd));
  const barW = Math.max(2, (w / Math.max(24, sorted.length)) * 0.72);
  const cumulative = sorted.reduce<{ p: number; c: number }[]>((acc, b) => [...acc, { p: b.price, c: (acc[acc.length - 1]?.c ?? 0) + b.collateralUsd }], []);
  const total = Math.max(1, cumulative[cumulative.length - 1]?.c ?? 0);
  const yBar = (c: number) => bottom - (c / maxC) * (bottom - top) * 0.78;
  const yCum = (c: number) => bottom - (c / total) * (bottom - top);
  const hovered = hover !== null ? sorted[hover] : null;

  return (
    <div ref={wrap} className={cn("relative w-full select-none", className)} style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} className="block" role="img" aria-label={`Collateral liquidated by NEAR price: ${formatUsdCompact(total)} in total below ${price.toFixed(2)} dollars`}>
          {/* Guides every 10 % below today's price. */}
          {[0.9, 0.8, 0.7, 0.6, 0.5, 0.4].map((f) => (
            <g key={f}>
              <line x1={x(price * f)} x2={x(price * f)} y1={top} y2={bottom} style={{ stroke: "var(--parry-line)" }} />
              <text x={x(price * f)} y={height - 10} textAnchor="middle" className="num" style={{ fill: "var(--parry-muted)", fontSize: 10.5 }}>
                -{Math.round((1 - f) * 100)}%
              </text>
            </g>
          ))}
          <line x1={padL} x2={width - padR} y1={bottom} y2={bottom} style={{ stroke: "var(--parry-line-strong)" }} />
          {/* Bars: collateral liquidated at each level. */}
          {sorted.map((b, i) => {
            const d = b.collateralUsd / maxC;
            return (
              <rect
                key={b.price}
                x={x(b.price) - barW / 2}
                y={yBar(b.collateralUsd)}
                width={barW}
                height={Math.max(1, bottom - yBar(b.collateralUsd))}
                rx={1}
                style={{ fill: "var(--parry-text)" }}
                opacity={hover === i ? 0.9 : 0.16 + 0.6 * d}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            );
          })}
          {/* Cascades: one level's liquidations pushing the price into the next. */}
          {cascades.map((c, i) => {
            const x1 = x(c.from);
            const x2 = x(c.to);
            const lift = 24 + Math.min(40, (c.collateralUsd / maxC) * 30);
            return <path key={i} d={`M${x1} ${top + 18} Q ${(x1 + x2) / 2} ${top + 18 - lift} ${x2} ${top + 18}`} fill="none" style={{ stroke: "var(--parry-brass-fill)" }} strokeWidth={1.5} opacity={0.85} />;
          })}
          {/* The running total as the price falls. */}
          <path
            d={cumulative.map((p, i) => `${i ? "L" : "M"}${x(p.p)} ${yCum(p.c)}`).join("")}
            fill="none"
            style={{ stroke: "var(--parry-brass)" }}
            strokeWidth={1.6}
          />
          {/* Today's price, and the viewer's own lines. */}
          <line x1={x(price)} x2={x(price)} y1={top - 10} y2={bottom} style={{ stroke: "var(--parry-text)" }} strokeWidth={1.5} />
          <text x={x(price) + 6} y={top - 2} style={{ fill: "var(--parry-text)", fontSize: 11 }}>
            NEAR ${price.toFixed(2)}
          </text>
          {mine?.triggerPrice ? (
            <g>
              <line x1={x(mine.triggerPrice)} x2={x(mine.triggerPrice)} y1={top} y2={bottom} style={{ stroke: "var(--parry-brass-fill)" }} strokeDasharray="4 4" />
              <text x={x(mine.triggerPrice) + 5} y={top + 12} style={{ fill: "var(--parry-brass)", fontSize: 10.5 }}>
                your trigger
              </text>
            </g>
          ) : null}
          {mine?.liqPrice ? (
            <g>
              <line x1={x(mine.liqPrice)} x2={x(mine.liqPrice)} y1={top} y2={bottom} style={{ stroke: "var(--parry-critical)" }} strokeWidth={1.5} />
              <text x={x(mine.liqPrice) + 5} y={top + 26} style={{ fill: "var(--parry-critical)", fontSize: 10.5 }}>
                your liquidation
              </text>
            </g>
          ) : null}
        </svg>
      ) : null}
      {hovered ? (
        <div className="surface-raised pointer-events-none absolute right-2 top-2 px-3 py-2 text-xs">
          <div className="num text-fg">NEAR ${hovered.price.toFixed(2)}</div>
          <div className="text-muted">
            {formatUsdCompact(hovered.collateralUsd)} liquidated, {hovered.accounts} {hovered.accounts === 1 ? "account" : "accounts"}
          </div>
        </div>
      ) : null}
    </div>
  );
}
