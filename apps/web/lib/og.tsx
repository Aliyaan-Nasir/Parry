// Open Graph and Twitter card, drawn with next/og: ink, a brass horizon, the wordmark and the
// risk instrument's scale with its needle turned back from the liquidation edge.
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import tokens from "@parry/brand";
import { MARK, WORDMARK } from "@/components/brand/paths";
import { isTestnet } from "./env";

export const OG_SIZE = { width: 1200, height: 630 } as const;

const ink = tokens.dark;

function font(pkg: string, file: string): Promise<Buffer> {
  return readFile(join(process.cwd(), "node_modules", "@fontsource", pkg, "files", file));
}

// The fonts never depend on the request, so they are read once at module scope and the
// images are prerendered at build time.
const [fraunces, sans, mono] = await Promise.all([
  font("fraunces", "fraunces-latin-500-normal.woff"),
  font("instrument-sans", "instrument-sans-latin-500-normal.woff"),
  font("jetbrains-mono", "jetbrains-mono-latin-500-normal.woff"),
]);

// The instrument's log scale, as on the site.
const MIN = 0.9;
const MAX = 3;
const frac = (h: number) => (Math.log(h) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN));

export function renderOgImage(): ImageResponse {
  const logoH = 58;
  const logoW = (WORDMARK.width / WORDMARK.height) * logoH;
  const scaleW = 1056;
  const x = (h: number) => frac(h) * scaleW;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: ink.bg,
          backgroundImage: `radial-gradient(70% 55% at 50% 118%, ${ink.brass}55, ${ink.bg} 70%)`,
          color: ink.text,
          padding: "60px 72px",
          fontFamily: "Instrument Sans",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <svg width={logoW} height={logoH} viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}>
            <g transform={`translate(${WORDMARK.mark.x} ${WORDMARK.mark.y}) scale(${WORDMARK.mark.scale})`}>
              <rect x={MARK.stem.x} y={MARK.stem.y} width={MARK.stem.width} height={MARK.stem.height} rx={MARK.stem.rx} fill={ink.text} />
              <path d={MARK.guard} fill={ink.mark} />
            </g>
            <path d={WORDMARK.rest} fill={ink.text} />
          </svg>
          <div style={{ display: "flex", fontSize: 22, color: ink.muted }}>{isTestnet ? "Live on NEAR testnet" : "On NEAR"}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 70 }}>
          <div
            style={{
              fontFamily: "Fraunces",
              fontSize: 96,
              lineHeight: 0.98,
              letterSpacing: -3.4,
              backgroundImage: `linear-gradient(180deg, ${ink.text} 35%, ${ink.muted})`,
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            Liquidation, turned aside.
          </div>
          <div style={{ marginTop: 24, fontSize: 28, lineHeight: 1.4, color: ink.muted, maxWidth: 820 }}>
            A guardian that can only protect, reviewed by verifiable AI. And a vault with no liquidation risk.
          </div>
        </div>

        <svg width={scaleW} height={90} viewBox={`0 0 ${scaleW} 90`} style={{ position: "absolute", left: 72, bottom: 54 }}>
          <defs>
            <linearGradient id="f" x1="0" x2="1" y1="0" y2="0">
              <stop offset={frac(1)} stopColor={ink.critical} />
              <stop offset={frac(1.1)} stopColor={ink.danger} />
              <stop offset={frac(1.25)} stopColor={ink.caution} />
              <stop offset={frac(1.55)} stopColor={ink.safe} />
              <stop offset="1" stopColor={ink.safe} />
            </linearGradient>
          </defs>
          <rect x={0} y={44} width={scaleW} height={3} rx={1.5} fill="url(#f)" />
          <rect x={0} y={20} width={x(1)} height={27} fill={ink.critical} opacity={0.25} />
          <line x1={x(1)} x2={x(1)} y1={14} y2={56} stroke={ink.critical} strokeWidth={2} />
          {[1, 1.2, 1.5, 2, 3].map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={52} y2={64} stroke={ink.muted} strokeWidth={1.5} />
          ))}
          <line x1={x(1.18)} x2={x(1.18)} y1={12} y2={46} stroke={ink.brass} strokeWidth={2} strokeDasharray="4 4" />
          <line x1={x(1.42)} x2={x(1.42)} y1={6} y2={52} stroke={ink.text} strokeWidth={3} strokeLinecap="round" />
          <circle cx={x(1.42)} cy={6} r={5} fill={ink.text} />
        </svg>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Fraunces", data: fraunces, weight: 500, style: "normal" },
        { name: "Instrument Sans", data: sans, weight: 500, style: "normal" },
        { name: "JetBrains Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
