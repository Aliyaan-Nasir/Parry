import { TierGlyph } from "./TierBadge";
import { TIERS, TIER_FLOOR, TIER_LABEL, clampScore, tierFromScore, type Tier } from "@/lib/risk";
import { cn } from "@/lib/cn";

export type RiskGaugeProps = {
  /** 0 to 100, or null when there is no score yet. */
  score: number | null;
  /** Rendered width in pixels; height follows. */
  size?: number;
  /** Accessible name, for example "Vault risk score". */
  label: string;
  className?: string;
};

// The arc spans 240 degrees, open at the bottom.
const START = -210;
const SWEEP = 240;
const R = 42;
const CX = 50;
const CY = 52;

function polar(angleDeg: number, r = R): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arc(from: number, to: number): string {
  const a0 = START + (SWEEP * from) / 100;
  const a1 = START + (SWEEP * to) / 100;
  const [x0, y0] = polar(a0);
  const [x1, y1] = polar(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const tierStroke: Record<Tier, string> = {
  safe: "stroke-safe",
  caution: "stroke-caution",
  danger: "stroke-danger",
  critical: "stroke-critical",
};
const tierText: Record<Tier, string> = {
  safe: "text-safe",
  caution: "text-caution",
  danger: "text-danger",
  critical: "text-critical",
};

/** A 0 to 100 arc with the four tier bands, the score in mono and the tier in words. */
export function RiskGauge({ score, size = 168, label, className }: RiskGaugeProps) {
  const has = typeof score === "number" && Number.isFinite(score);
  const s = has ? clampScore(score) : 0;
  const tier = tierFromScore(s);
  const bands = TIERS.map((t, i) => {
    const from = TIER_FLOOR[t];
    const to = i < TIERS.length - 1 ? TIER_FLOOR[TIERS[i + 1] as Tier] : 100;
    return { t, from: from + (i === 0 ? 0 : 0.8), to: to - (i === TIERS.length - 1 ? 0 : 0.8) };
  });
  const [mx, my] = polar(START + (SWEEP * s) / 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={has ? Math.round(s) : undefined}
      aria-valuetext={has ? `${Math.round(s)} out of 100, ${TIER_LABEL[tier]}` : "No score yet"}
      className={cn("relative inline-block", className)}
      style={{ width: size, height: size * 0.86 }}
    >
      <svg viewBox="0 0 100 86" width={size} height={size * 0.86} aria-hidden="true" className="overflow-visible">
        {bands.map((b) => (
          <path key={b.t} d={arc(b.from, b.to)} fill="none" strokeWidth="6" strokeLinecap="butt" className={cn(tierStroke[b.t], "opacity-30")} />
        ))}
        {has && s > 0.5 ? <path d={arc(0, s)} fill="none" strokeWidth="6" strokeLinecap="butt" className={tierStroke[tier]} /> : null}
        {has ? (
          <circle cx={mx} cy={my} r="4.6" className={cn("fill-raised", tierStroke[tier])} strokeWidth="2.4" />
        ) : null}
      </svg>
      <div className="absolute inset-x-0 top-[34%] flex flex-col items-center">
        {has ? (
          <span className="num font-medium leading-none tracking-[-0.03em] text-fg" style={{ fontSize: size * 0.22 }}>
            {Math.round(s)}
          </span>
        ) : (
          <span aria-hidden="true" className="flex items-center" style={{ height: size * 0.22 }}>
            <span className="h-0.5 w-6 rounded-full bg-line-strong" />
          </span>
        )}
        <span className={cn("mt-2 inline-flex items-center gap-1.5 text-xs font-semibold", has ? tierText[tier] : "text-muted")}>
          {has ? (
            <>
              <TierGlyph tier={tier} size={9} />
              {TIER_LABEL[tier]}
            </>
          ) : (
            "No score yet"
          )}
        </span>
      </div>
    </div>
  );
}
