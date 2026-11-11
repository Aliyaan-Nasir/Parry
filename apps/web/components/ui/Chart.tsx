"use client";

// Wraps TradingView Lightweight Charts (Apache-2.0, https://www.tradingview.com/).
// Attribution: the library's own attribution logo stays on, as its license asks.

import { useEffect, useRef, useState } from "react";
import type * as LightweightCharts from "lightweight-charts";
import type { AutoscaleInfo, IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from "lightweight-charts";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/cn";

export type ChartTone = "fg" | "muted" | "brass" | "safe" | "caution" | "danger" | "critical";

export type ChartPoint = {
  /** Unix time in seconds. */
  time: number;
  value: number;
};

export type ChartSeries = {
  id: string;
  kind: "line" | "area";
  data: readonly ChartPoint[];
  tone?: ChartTone;
  /** Shown on the price scale label. */
  title?: string;
};

export type ChartPriceLine = {
  price: number;
  title: string;
  tone?: ChartTone;
  dashed?: boolean;
};

export type ChartProps = {
  series: readonly ChartSeries[];
  /** Accessible name and caption, for example "Health factor, last 7 days". */
  label: string;
  /** Fixed height in pixels, reserved before the library loads so nothing shifts. */
  height?: number;
  /** Horizontal markers such as the liquidation level. */
  priceLines?: readonly ChartPriceLine[];
  valueFormat?: "number" | "usd" | "percent";
  precision?: number;
  /** The currency "usd" values are shown in (already converted by the caller); USD by default. */
  currency?: string;
  /**
   * The smallest vertical range shown, as a fraction of the values' level (0.02 is 2 %), so a
   * near-flat series such as a share price does not stretch its noise across the whole height.
   */
  minSpan?: number;
  className?: string;
};

type Palette = Record<ChartTone, string> & { bg: string; line: string; font: string };

function readPalette(): Palette {
  const root = getComputedStyle(document.documentElement);
  const v = (name: string) => root.getPropertyValue(name).trim();
  return {
    bg: v("--parry-raised"),
    line: v("--parry-line"),
    fg: v("--parry-text"),
    muted: v("--parry-muted"),
    brass: v("--parry-brass"),
    safe: v("--parry-safe"),
    caution: v("--parry-caution"),
    danger: v("--parry-danger"),
    critical: v("--parry-critical"),
    font: v("--font-jetbrains") || "ui-monospace, monospace",
  };
}

/** "#rrggbb" plus alpha to "rgba(...)"; other formats pass through untouched. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function formatter(kind: NonNullable<ChartProps["valueFormat"]>, precision: number, currency = "USD") {
  if (kind === "usd") {
    const f = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: precision });
    return (v: number) => f.format(v);
  }
  if (kind === "percent") return (v: number) => `${v.toFixed(precision)}%`;
  return (v: number) => v.toFixed(precision);
}

type Api = { chart: IChartApi; lib: typeof LightweightCharts; series: ISeriesApi<SeriesType>[] };

export function Chart({ series, label, height = 280, priceLines = [], valueFormat = "number", precision = 2, currency = "USD", minSpan, className }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [ready, setReady] = useState(false);
  const { resolved } = useTheme();
  const empty = series.every((s) => s.data.length === 0);

  // Load the library on demand and create the chart once.
  useEffect(() => {
    let disposed = false;
    void import("lightweight-charts").then((lib) => {
      if (disposed || !box.current) return;
      const chart = lib.createChart(box.current, { autoSize: true });
      api.current = { chart, lib, series: [] };
      setReady(true);
    });
    return () => {
      disposed = true;
      api.current?.chart.remove();
      api.current = null;
      setReady(false);
    };
  }, []);

  // Theme, series and markers are applied together on every change (the data sets here are small).
  useEffect(() => {
    const a = api.current;
    if (!ready || !a) return;
    const p = readPalette();
    const fmt = formatter(valueFormat, precision, currency);
    a.chart.applyOptions({
      layout: {
        background: { type: a.lib.ColorType.Solid, color: p.bg },
        textColor: p.muted,
        fontFamily: p.font,
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(p.line, 0.7) } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: a.lib.CrosshairMode.Magnet,
        vertLine: { color: p.muted, labelBackgroundColor: p.fg, width: 1, style: a.lib.LineStyle.Dashed },
        horzLine: { color: p.muted, labelBackgroundColor: p.fg, width: 1, style: a.lib.LineStyle.Dashed },
      },
      localization: { priceFormatter: fmt },
      handleScale: false,
      handleScroll: false,
    });
    for (const s of a.series) a.chart.removeSeries(s);
    a.series = [];
    series.forEach((s, i) => {
      const color = p[s.tone ?? (i === 0 ? "fg" : "brass")];
      const marks = i === 0 ? priceLines.map((l) => l.price) : [];
      const span = minSpan ?? 0;
      const common = {
        title: s.title ?? "",
        lastValueVisible: true,
        priceLineVisible: false,
        lineWidth: 2 as const,
        // Markers such as the liquidation level stay in view, however far the data is from them,
        // and the range never shrinks under `minSpan` of the level.
        ...(marks.length > 0 || span > 0
          ? {
              autoscaleInfoProvider: (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
                const res = original();
                if (!res?.priceRange) return res;
                let lo = Math.min(res.priceRange.minValue, ...marks);
                let hi = Math.max(res.priceRange.maxValue, ...marks);
                const mid = (lo + hi) / 2;
                if (hi - lo < Math.abs(mid) * span) {
                  lo = mid - (Math.abs(mid) * span) / 2;
                  hi = mid + (Math.abs(mid) * span) / 2;
                }
                const pad = (hi - lo) * 0.04;
                return { ...res, priceRange: { minValue: lo - pad, maxValue: hi + pad } };
              },
            }
          : {}),
      };
      const created =
        s.kind === "area"
          ? a.chart.addSeries(a.lib.AreaSeries, {
              ...common,
              lineColor: color,
              // A flat wash, not a fade: calmer, and the line stays the figure.
              topColor: withAlpha(color, 0.07),
              bottomColor: withAlpha(color, 0.07),
            })
          : a.chart.addSeries(a.lib.LineSeries, { ...common, color });
      created.setData(s.data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      if (i === 0) {
        for (const line of priceLines) {
          created.createPriceLine({
            price: line.price,
            title: line.title,
            color: p[line.tone ?? "critical"],
            lineWidth: 1,
            lineStyle: line.dashed === false ? a.lib.LineStyle.Solid : a.lib.LineStyle.Dashed,
            axisLabelVisible: true,
          });
        }
      }
      a.series.push(created);
    });
    a.chart.timeScale().fitContent();
  }, [ready, series, priceLines, valueFormat, precision, currency, minSpan, resolved]);

  return (
    <figure className={cn("relative m-0", className)}>
      <div ref={box} role="img" aria-label={label} style={{ height }} className="w-full" />
      {empty ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted" aria-hidden="true">
          No data yet
        </div>
      ) : null}
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}
