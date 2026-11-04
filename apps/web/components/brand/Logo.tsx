import { LOCKUP, MARK, WORDMARK } from "./paths";
import { cn } from "@/lib/cn";

type MarkProps = {
  /** Rendered size in pixels (the mark is square). */
  size?: number;
  className?: string;
  /** Accessible name; omit when the mark sits next to visible text that names it. */
  title?: string;
};

/** The shapes of the mark on its 32 unit grid: the strike in the text color, the sabre in brass. */
export function MarkShapes() {
  return (
    <>
      <path
        d={MARK.strike}
        fill="none"
        stroke="currentColor"
        strokeWidth={MARK.strikeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g className="text-brass">
        <path d={MARK.blade} fill="currentColor" />
        <path d={MARK.grip} fill="none" stroke="currentColor" strokeWidth={MARK.gripWidth} strokeLinecap="round" />
        <path d={MARK.guard} fill="none" stroke="currentColor" strokeWidth={MARK.guardWidth} strokeLinecap="round" />
        <circle cx={MARK.pommel.cx} cy={MARK.pommel.cy} r={MARK.pommel.r} fill="currentColor" />
      </g>
    </>
  );
}

/** The Parry mark: a sabre turning a falling strike aside. */
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
  /** Rendered height in pixels; width follows the lockup's proportions. */
  height?: number;
  className?: string;
};

/** Mark and wordmark lockup, outlined from Fraunces SemiBold. */
export function Logo({ height = 26, className }: LogoProps) {
  const width = Math.round((LOCKUP.width / LOCKUP.height) * height);
  return (
    <svg
      viewBox={`0 0 ${LOCKUP.width} ${LOCKUP.height}`}
      width={width}
      height={height}
      className={cn("shrink-0 text-fg", className)}
      role="img"
      aria-label="Parry"
      focusable="false"
    >
      <g transform={`translate(${LOCKUP.mark.x} ${LOCKUP.mark.y}) scale(${LOCKUP.mark.scale})`}>
        <MarkShapes />
      </g>
      <path transform={`translate(${LOCKUP.word.x} ${LOCKUP.word.y})`} d={WORDMARK.d} fill="currentColor" />
    </svg>
  );
}
