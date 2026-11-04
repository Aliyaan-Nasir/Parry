import { cn } from "@/lib/cn";

export type SparklineTone = "fg" | "muted" | "brass" | "safe" | "caution" | "danger" | "critical";

export type SparklineProps = {
  data: readonly number[];
  /** Accessible description, for example "Health over the last 24 hours". */
  label: string;
  width?: number;
  height?: number;
  tone?: SparklineTone;
  /** Shade the area under the line with a faint wash of the same color. */
  area?: boolean;
  strokeWidth?: number;
  className?: string;
};

const strokeTone: Record<SparklineTone, string> = {
  fg: "text-fg",
  muted: "text-muted",
  brass: "text-brass",
  safe: "text-safe",
  caution: "text-caution",
  danger: "text-danger",
  critical: "text-critical",
};

/** Builds the line through the points, padded so round caps are never clipped. */
export function sparklinePath(data: readonly number[], width: number, height: number, pad: number): string {
  const finite = data.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return "";
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const step = (width - pad * 2) / (finite.length - 1);
  return finite
    .map((v, i) => {
      const x = pad + i * step;
      const y = max === min ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function Sparkline({ data, label, width = 120, height = 32, tone = "fg", area = false, strokeWidth = 1.5, className }: SparklineProps) {
  const pad = strokeWidth;
  const d = sparklinePath(data, width, height, pad);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={d ? label : `${label}: no data yet`}
      className={cn("block shrink-0 overflow-visible", strokeTone[tone], className)}
    >
      {d ? (
        <>
          {area ? <path d={`${d} L${width - pad} ${height} L${pad} ${height} Z`} fill="currentColor" opacity="0.08" /> : null}
          <path d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <path d={`M${pad} ${height / 2} H${width - pad}`} stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 3" />
      )}
    </svg>
  );
}
