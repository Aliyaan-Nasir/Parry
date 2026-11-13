"use client";

import Link from "next/link";
import type { Position } from "@parryguard/sdk";
import { useMoney } from "@/components/providers/MoneyProvider";
import { TierBadge } from "@/components/ui/TierBadge";
import { formatDuration, formatHealth, formatPercent } from "@/lib/units";
import { cn } from "@/lib/cn";

export const VENUE_LABEL: Record<string, string> = { rhea: "Rhea", hyperliquid: "Hyperliquid", aave: "Aave", evm: "Aave" };

export function positionHref(id: string) {
  return `/app/positions/${encodeURIComponent(id)}` as const;
}

/** The health figure, colored by how close it is to 1 (with the tier carrying the meaning too). */
export function HealthValue({ health, className }: { health: number | null; className?: string }) {
  const tone = health === null ? "text-muted" : health < 1.1 ? "text-critical" : health < 1.25 ? "text-danger" : health < 1.5 ? "text-caution" : "text-fg";
  return <span className={cn("num font-medium", tone, className)}>{formatHealth(health)}</span>;
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5">
      <path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Every position of the account with its risk: a table on wide screens, a list on phones. */
export function PositionsTable({ positions, caption }: { positions: Position[]; caption: string }) {
  const { format } = useMoney();
  return (
    <>
      <table className="hidden w-full border-collapse text-left text-sm md:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-[12.5px] font-normal text-muted">
            <th scope="col" className="px-5 py-3 font-semibold sm:px-6">
              Position
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Health
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Liquidation price
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Distance
            </th>
            <th scope="col" className="px-3 py-3 font-semibold">
              Score
            </th>
            <th scope="col" className="px-5 py-3 text-right font-semibold sm:px-6">
              Time to liquidation
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {positions.map((p) => (
            <tr key={p.id} className="group relative transition-colors hover:bg-hover">
              <th scope="row" className="px-5 py-3.5 font-normal sm:px-6">
                <Link href={positionHref(p.id)} className="flex flex-col after:absolute after:inset-0 after:content-['']">
                  <span className="font-semibold text-fg">{p.label}</span>
                  <span className="text-[13px] text-muted">{VENUE_LABEL[p.venue] ?? p.venue}</span>
                </Link>
              </th>
              <td className="px-3 py-3.5 text-right">
                <HealthValue health={p.health} />
              </td>
              <td className="num px-3 py-3.5 text-right text-fg">{p.liqPrice !== null ? format(p.liqPrice) : <span className="text-muted">None</span>}</td>
              <td className="num px-3 py-3.5 text-right text-fg">{p.liqPrice !== null ? formatPercent(p.distance, 1) : <span className="text-muted">n/a</span>}</td>
              <td className="px-3 py-3.5">
                <TierBadge tier={p.tier} score={p.score} />
              </td>
              <td className="px-5 py-3.5 text-right sm:px-6">
                <span className="inline-flex items-center gap-2">
                  <span className="num text-fg">{formatDuration(p.ttlHours)}</span>
                  <Arrow />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-line md:hidden" aria-label={caption}>
        {positions.map((p) => (
          <li key={p.id}>
            <Link href={positionHref(p.id)} className="group grid gap-3 px-5 py-4 transition-colors hover:bg-hover">
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-semibold text-fg">{p.label}</span>
                  <span className="block text-[13px] text-muted">{VENUE_LABEL[p.venue] ?? p.venue}</span>
                </span>
                <span className="flex items-center gap-2">
                  <TierBadge tier={p.tier} score={p.score} />
                  <Arrow />
                </span>
              </span>
              <span className="grid grid-cols-3 gap-3 text-[13px] [&>*]:min-w-0">
                <span className="min-w-0">
                  <span className="block text-muted">Health</span>
                  <HealthValue health={p.health} />
                </span>
                <span className="min-w-0">
                  <span className="block text-muted">Liquidation</span>
                  <span className="num block truncate text-fg">{p.liqPrice !== null ? format(p.liqPrice) : "None"}</span>
                </span>
                <span className="min-w-0">
                  <span className="block text-muted">Time left</span>
                  <span className="num block truncate text-fg">{formatDuration(p.ttlHours)}</span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
