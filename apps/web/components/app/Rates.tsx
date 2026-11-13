"use client";

import type { Rates } from "@parryguard/sdk";
import Link from "next/link";
import { QueryError } from "@/components/app/bits";
import { Skeleton } from "@/components/ui/Skeleton";
import { useRatesLive } from "@/lib/live";
import { useNow } from "@/lib/use-now";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";

const pct = (v: number | null | undefined, dp = 2) => (v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(dp)}%`);

function Source({ children }: { children: string }) {
  return (
    <p className="mt-3 break-words text-[12px] leading-5 text-muted" title={children}>
      Source: {children}
    </p>
  );
}

function RheaTable({ rows, compact }: { rows: Rates["rhea"]; compact?: boolean }) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <caption className="sr-only">Rhea lending rates per asset</caption>
      <thead>
        <tr className="border-b border-line text-[12.5px] text-muted">
          <th scope="col" className="py-2 pr-4 font-normal">
            Asset
          </th>
          <th scope="col" className="py-2 pr-4 text-right font-normal">
            Supply, a year
          </th>
          <th scope="col" className="py-2 pr-4 text-right font-normal">
            Borrow, a year
          </th>
          {!compact ? (
            <th scope="col" className="py-2 text-right font-normal">
              Utilization
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((r) => (
          <tr key={r.tokenId}>
            <th scope="row" className="py-2.5 pr-4 font-normal text-fg">
              {r.asset}
              {!compact ? <span className="num block text-[11.5px] text-muted">{r.tokenId}</span> : null}
            </th>
            <td className="num py-2.5 pr-4 text-right text-fg">{pct(r.supplyApr)}</td>
            <td className="num py-2.5 pr-4 text-right text-fg">{pct(r.borrowApr)}</td>
            {!compact ? (
              <td className="py-2.5 text-right">
                <span className="inline-flex items-center gap-2">
                  <span className="h-1 w-16 overflow-hidden rounded-full bg-line">
                    <span className="block h-full rounded-full bg-fg/55" style={{ width: `${Math.min(100, r.utilization * 100)}%` }} />
                  </span>
                  <span className="num w-14 text-right text-fg">{pct(r.utilization, 1)}</span>
                </span>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every rate Parry reads, live, each with where it came from: Rhea per asset, Hyperliquid funding, and the vault's yield split. */
export function RatesBoard() {
  const q = useRatesLive();
  const now = useNow();
  const d = q.data;
  if (q.isError && !d) return <QueryError title="The rates could not be read" error={q.error} onRetry={() => void q.refetch()} />;
  if (!d) return q.isPending ? <Skeleton height="24rem" shape="block" /> : <p className="text-sm text-muted">The API has no rates route.</p>;
  const hl = d.hyperliquid;
  const vault = d.vault;
  const staking = vault?.stakingApr ?? 0;
  const funding = vault?.fundingApr ?? 0;
  const total = Math.abs(staking) + Math.abs(funding);
  return (
    <div className="grid gap-6">
      <p className="text-[13px] text-muted">Read {now ? formatRelativeTime(d.readAt, now) : ""}, every two minutes.</p>
      <section className="surface p-6" aria-labelledby="rhea-title">
        <h2 id="rhea-title" className="text-[15px] text-fg">
          Rhea lending
        </h2>
        <div className="mt-4 overflow-x-auto">
          <RheaTable rows={d.rhea} />
        </div>
        {d.rhea[0] ? <Source>{d.rhea[0].source}</Source> : null}
      </section>
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <section className="surface p-6" aria-labelledby="hl-title">
          <h2 id="hl-title" className="text-[15px] text-fg">
            Hyperliquid funding, NEAR
          </h2>
          <dl className="ruled mt-4 grid-cols-2">
            <div className="p-4">
              <dt className="label">An hour, now</dt>
              <dd className={cn("num mt-1.5 text-2xl", (hl?.fundingHourly ?? 0) < 0 ? "text-critical" : "text-fg")}>{pct(hl?.fundingHourly, 4)}</dd>
            </div>
            <div className="p-4">
              <dt className="label">A year, from the last 24 h</dt>
              <dd className={cn("num mt-1.5 text-2xl", (hl?.funding24hApr ?? 0) < 0 ? "text-critical" : "text-fg")}>{pct(hl?.funding24hApr)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[13px] leading-5 text-muted">Positive funding is paid by longs to shorts: it is what the vault&apos;s short earns.</p>
          {hl ? <Source>{hl.source}</Source> : null}
        </section>
        <section className="surface p-6" aria-labelledby="vault-rates-title">
          <h2 id="vault-rates-title" className="text-[15px] text-fg">
            The vault&apos;s yield, split
          </h2>
          <div className="mt-4 flex items-end justify-between gap-4">
            <span className="label">Net, a year</span>
            <span className="num text-2xl text-fg">{pct(vault?.netApr)}</span>
          </div>
          <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`Staking ${pct(staking)}, funding ${pct(funding)}`}>
            {total > 0 ? (
              <>
                <span className="h-full bg-fg/70" style={{ width: `${(Math.abs(staking) / total) * 100}%` }} />
                <span className={cn("h-full", funding < 0 ? "bg-critical" : "bg-brass-fill")} style={{ width: `${(Math.abs(funding) / total) * 100}%` }} />
              </>
            ) : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="flex items-center gap-2 text-muted">
                <span className="size-2 rounded-full bg-fg/70" aria-hidden="true" />
                Staking
              </dt>
              <dd className="num mt-0.5 text-fg">{pct(staking)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-muted">
                <span className="size-2 rounded-full bg-brass-fill" aria-hidden="true" />
                Funding
              </dt>
              <dd className="num mt-0.5 text-fg">{pct(funding)}</dd>
            </div>
          </dl>
          {total === 0 ? <p className="mt-3 text-[13px] text-muted">No yield recorded yet over the vault&apos;s history on this network.</p> : null}
          {vault ? <Source>{vault.source}</Source> : null}
        </section>
      </div>
    </div>
  );
}

/** The rates that matter while opening a position: Rhea for the two assets, and the funding a hedge would pay or earn. */
export function RatesPanel({ className }: { className?: string }) {
  const q = useRatesLive();
  const d = q.data;
  return (
    <section className={cn("surface p-5", className)} aria-labelledby="rates-panel-title">
      <div className="flex items-end justify-between gap-3">
        <h2 id="rates-panel-title" className="text-[15px] text-fg">
          Rates now
        </h2>
        <Link href="/app/rates" className="text-[13px] text-brass hover:underline">
          All rates
        </Link>
      </div>
      {!d ? (
        <Skeleton height="6rem" shape="block" className="mt-3" />
      ) : (
        <>
          <div className="mt-3">
            <RheaTable rows={d.rhea} compact />
          </div>
          <div className="mt-3 flex items-end justify-between border-t border-line pt-3 text-sm">
            <span className="text-muted">NEAR funding on Hyperliquid, a year</span>
            <span className="num text-fg">{pct(d.hyperliquid?.funding24hApr)}</span>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-muted">Borrowing costs the borrow rate on the USDC debt; the wNEAR collateral earns the supply rate.</p>
        </>
      )}
    </section>
  );
}
