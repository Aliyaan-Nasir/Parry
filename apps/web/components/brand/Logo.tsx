import { MARK, WORDMARK } from "./paths";
import { cn } from "@/lib/cn";

type MarkProps = {
  /** Rendered size in pixels (the mark is square). */
  size?: number;
  className?: string;
  /** Accessible name; omit when the mark sits next to visible text that names it. */
  title?: string;
};

/** The shapes of the mark on its 32 unit grid: the stem in the text color, the guard in brass. */
export function MarkShapes() {
  return (
    <>
      <rect x={MARK.stem.x} y={MARK.stem.y} width={MARK.stem.width} height={MARK.stem.height} rx={MARK.stem.rx} fill="currentColor" />
      <path d={MARK.guard} className="text-mark" fill="currentColor" />
    </>
  );
}

/** The Parry mark: a P cut into a stem and the guard raised beside it. */
export function Mark({ size = 28, className, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0 text-fg", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <MarkShapes />
    </svg>
  );
}

type LogoProps = {
  /** Rendered height in pixels; width follows the wordmark's proportions. */
  height?: number;
  className?: string;
};

/** The wordmark: the mark stands in for the P, then "arry" outlined from Instrument Sans Semibold. */
export function Logo({ height = 26, className }: LogoProps) {
  const width = Math.round((WORDMARK.width / WORDMARK.height) * height * 100) / 100;
  return (
    <svg
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      width={width}
      height={height}
      className={cn("shrink-0 text-fg", className)}
      role="img"
      aria-label="Parry"
      focusable="false"
    >
      <g transform={`translate(${WORDMARK.mark.x} ${WORDMARK.mark.y}) scale(${WORDMARK.mark.scale})`}>
        <MarkShapes />
      </g>
      <path d={WORDMARK.rest} fill="currentColor" />
    </svg>
  );
}
