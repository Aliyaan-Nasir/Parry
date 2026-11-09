// Open Graph and Twitter card, drawn with next/og in the brand: ink, bone and brass.
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import tokens from "@parry/brand";
import { LOCKUP, MARK, WORDMARK } from "@/components/brand/paths";
import {
  APPROACH,
  CANVAS,
  GUIDES,
  LIQUIDATION_Y,
  PROJECTED,
  PROJECTED_HIT,
  RECOVERY,
  RECOVERY_END,
  SABRE,
  SABRE_SCALE,
  SABRE_TRANSLATE,
} from "./deflection";
import { isTestnet } from "./env";

export const OG_SIZE = { width: 1200, height: 630 } as const;

const ink = tokens.dark;

function font(pkg: string, file: string): Promise<Buffer> {
  return readFile(join(process.cwd(), "node_modules", "@fontsource", pkg, "files", file));
}

// The fonts never depend on the request, so they are read once at module scope and the
// images are prerendered at build time.
const [fraunces, manrope, mono] = await Promise.all([
  font("fraunces", "fraunces-latin-600-normal.woff"),
  font("manrope", "manrope-latin-500-normal.woff"),
  font("jetbrains-mono", "jetbrains-mono-latin-500-normal.woff"),
]);

export function renderOgImage(): ImageResponse {

  const logoH = 46;
  const logoW = (LOCKUP.width / LOCKUP.height) * logoH;
  const art = { w: 500, h: (500 * CANVAS.height) / CANVAS.width };

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: ink.bg,
          color: ink.text,
          padding: "64px 72px",
          fontFamily: "Manrope",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <svg width={logoW} height={logoH} viewBox={`0 0 ${LOCKUP.width} ${LOCKUP.height}`}>
            <g transform={`translate(${LOCKUP.mark.x} ${LOCKUP.mark.y}) scale(${LOCKUP.mark.scale})`}>
              <rect x={MARK.stem.x} y={MARK.stem.y} width={MARK.stem.width} height={MARK.stem.height} rx={MARK.stem.rx} fill={ink.text} />
              <path d={MARK.guard} fill={ink.mark} />
            </g>
            <path transform={`translate(${LOCKUP.word.x} ${LOCKUP.word.y})`} d={WORDMARK.d} fill={ink.text} />
          </svg>
          {isTestnet ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontFamily: "JetBrains Mono",
                fontSize: 20,
                letterSpacing: 3,
                color: ink.brass,
                border: `1px solid ${ink.line}`,
                borderRadius: 999,
                padding: "10px 20px",
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: 8, background: ink.brass }} />
              NEAR TESTNET
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", maxWidth: 540 }}>
          <div style={{ fontFamily: "Fraunces", fontSize: 76, lineHeight: 1.02, letterSpacing: -2.2, color: ink.text }}>
            Liquidation, turned aside.
          </div>
          <div style={{ marginTop: 26, fontSize: 26, lineHeight: 1.45, color: ink.muted }}>
            Parry sees trouble hours before it comes and steps in on its own. Or earn without liquidation risk at all.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "JetBrains Mono", fontSize: 18, color: ink.muted, letterSpacing: 1 }}>
          <div style={{ width: 40, height: 1, background: ink.brass }} />
          Liquidation protection and a delta-neutral vault on NEAR
        </div>

        <svg
          width={art.w}
          height={art.h}
          viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
          style={{ position: "absolute", right: 56, top: 176 }}
        >
          {GUIDES.map((f) => (
            <path key={f} d={`M0 ${f * CANVAS.height} H${CANVAS.width}`} stroke={ink.line} strokeWidth="1.5" />
          ))}
          <path d={`M0 ${LIQUIDATION_Y} H${CANVAS.width}`} stroke={ink.critical} strokeWidth="1.75" strokeDasharray="6 6" />
          <path d={PROJECTED} fill="none" stroke={ink.muted} strokeWidth="2" strokeDasharray="5 6" strokeLinecap="round" opacity="0.7" />
          <path
            d={`M${PROJECTED_HIT.x - 7} ${PROJECTED_HIT.y - 7} L${PROJECTED_HIT.x + 7} ${PROJECTED_HIT.y + 7} M${PROJECTED_HIT.x + 7} ${PROJECTED_HIT.y - 7} L${PROJECTED_HIT.x - 7} ${PROJECTED_HIT.y + 7}`}
            stroke={ink.critical}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path d={APPROACH} fill="none" stroke={ink.text} strokeWidth="4" strokeLinecap="round" />
          <path d={RECOVERY} fill="none" stroke={ink.safe} strokeWidth="4" strokeLinecap="round" />
          <g transform={`translate(${SABRE_TRANSLATE.x} ${SABRE_TRANSLATE.y}) scale(${SABRE_SCALE})`}>
            <path d={SABRE.blade} fill={ink.brass} />
            <path d={SABRE.grip} fill="none" stroke={ink.brass} strokeWidth={SABRE.gripWidth} strokeLinecap="round" />
            <path d={SABRE.guard} fill="none" stroke={ink.brass} strokeWidth={SABRE.guardWidth} strokeLinecap="round" />
            <circle cx={SABRE.pommel.cx} cy={SABRE.pommel.cy} r={SABRE.pommel.r} fill={ink.brass} />
          </g>
          <circle cx={RECOVERY_END.x} cy={RECOVERY_END.y} r="6" fill={ink.safe} />
        </svg>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Fraunces", data: fraunces, weight: 600, style: "normal" },
        { name: "Manrope", data: manrope, weight: 500, style: "normal" },
        { name: "JetBrains Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
