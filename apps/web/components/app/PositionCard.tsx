"use client";

import Link from "next/link";
import type { Decision, MandateView, Position } from "@parryguard/sdk";
import { Spotlight } from "@/components/fx/Spotlight";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Sparkline } from "@/components/ui/Sparkline";
import { useHistory, useMarket } from "@/lib/queries";
import { readPolicy } from "@/lib/policy-memory";
import { formatDuration } from "@/lib/units";
import { formatRelativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const VENUE: Record<string, string> = { rhea: "Rhea lending", hyperliquid: "Hyperliquid", aave: "Aave on Base", evm: "Aave on Base" };

/** The guardian's state for this position, said as a sentence. */
export function guardianSentence(mandate: MandateView | null | undefined, account: string, nowS: number | null): string {
  if (!mandate) return "Unguarded: no mandate set";
  if (nowS !== null && (mandate.expired || mandate.mandate.expires_at <= nowS)) return "Unguarded: the mandate expired";
  if (nowS !== null && mandate.paused_until > nowS) return "Paused by you";
  const own = typeof window === "undefined" ? null : readPolicy(account);
  return own ? `Guarding, trigger at ${own.triggerHealth.toFixed(2)}, target ${own.targetHealth.toFixed(2)}` : "Guarding, trigger sealed";
}

/** One position: the compact instrument, a 24 h sparkline, time to liquidation, the guardian, its last action. */
export function PositionCard({ position, mandate, lastDecision }: { position: Position; mandate: MandateView | null | undefined; lastDecision?: Decision | null }) {
  const { format } = useMoney();
  const now = useNow();
  const market = useMarket();
  const history = useHistory(position.id, 24);
  const series = (history.data ?? []).map((h) => h.health ?? 0).filter((h) => h > 0);
  return (
    <Spotlight className="surface block p-5">
      <Link href={`/app/positions/${encodeURIComponent(position.id)}`} className="block">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[15px] text-fg">{position.label}</div>
            <div className="text-[12.5px] text-muted">{VENUE[position.venue] ?? position.venue}</div>
          </div>
          <div className="h-8 w-28 shrink-0">{series.length > 1 ? <Sparkline data={series} label="Health over 24 hours" width={112} height={32} /> : null}</div>
        </div>
        <div className="mt-4">
          <RiskInstrument health={position.health} tier={position.tier} variant="compact" annualVol={market.data?.tremor.annual ?? null} />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-[12.5px]">
          <div>
            <dt className="text-muted">Time to liquidation</dt>
            <dd className="num mt-0.5 text-fg">{formatDuration(position.ttlHours)}</dd>
          </div>
          <div>
            <dt className="text-muted">Collateral</dt>
            <dd className="num mt-0.5 text-fg">{format(position.collateralUsd, { compact: true })}</dd>
          </div>
          <div>
            <dt className="text-muted">Debt</dt>
            <dd className="num mt-0.5 text-fg">{format(position.debtUsd, { compact: true })}</dd>
          </div>
        </dl>
        <div className="mt-4 border-t border-line pt-3 text-[12.5px]">
          <div className="text-fg/85">{guardianSentence(mandate, position.account, now ? now / 1000 : null)}</div>
          <div className="mt-0.5 truncate text-muted">
            {lastDecision ? `Last: ${lastDecision.plan} ${now ? formatRelativeTime(lastDecision.createdAt, now) : ""}` : "No guardian action yet"}
          </div>
        </div>
      </Link>
    </Spotlight>
  );
}
