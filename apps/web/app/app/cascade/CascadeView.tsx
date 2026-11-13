"use client";

import { useState } from "react";
import type { Heatmap as HeatmapData } from "@parryguard/sdk";
import { QueryError, Segmented } from "@/components/app/bits";
import { Heatmap } from "@/components/instrument/Heatmap";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatUsdCompact, formatRelativeTime } from "@/lib/format";
import { useHeatmap } from "@/lib/live";
import { useMarket, usePositions } from "@/lib/queries";
import { useNow } from "@/lib/use-now";

type Full = HeatmapData & {
  lending?: string;
  pressure?: { atRiskUsd: number; pressure: number; to: number; accounts: number };
  sweep?: { totalAccounts: number; nextIndex: number; lastFullSweepAt: string | null };
};

const NETWORKS = [
  { value: "mainnet", label: "Mainnet" },
  { value: "testnet", label: "Testnet" },
] as const;

const DEPTHS = [
  { value: 0.7, label: "To -30%" },
  { value: 0.5, label: "To -50%" },
  { value: 0.3, label: "To -70%" },
] as const;

/**
 * Where Rhea positions would be liquidated by NEAR price, read from the lending contract itself on
 * mainnet or testnet, with the chains where one level's liquidations push the price into the next.
 */
export function CascadeView() {
  const [net, setNet] = useState<"mainnet" | "testnet">("mainnet");
  const [floor, setFloor] = useState<number>(0.5);
  const q = useHeatmap(net);
  const market = useMarket();
  const { account } = useParryAccount();
  const positions = usePositions(account);
  const now = useNow();
  const d = q.data as Full | null | undefined;
  const mine = net === "testnet" ? positions.data?.find((p) => p.venue === "rhea" && p.liqPrice) : undefined;
  const price = d?.price ?? market.data?.near.priceUsd ?? 0;
  const within = (f: number) => (d?.buckets ?? []).filter((b) => b.price >= price * f).reduce((s, b) => s + b.collateralUsd, 0);
  const biggest = [...(d?.cascades ?? [])].sort((a, b) => b.collateralUsd - a.collateralUsd)[0];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Network" options={NETWORKS} value={net} onChange={setNet} />
        <Segmented label="Price depth" options={DEPTHS} value={floor as 0.7 | 0.5 | 0.3} onChange={setFloor} />
      </div>
      {q.isError && !d ? (
        <QueryError title="The cascade map could not be read" error={q.error} onRetry={() => void q.refetch()} />
      ) : !d ? (
        q.isPending ? <Skeleton height="26rem" shape="block" /> : <p className="text-sm text-muted">The API has no heatmap route.</p>
      ) : (
        <>
          <section className="surface p-6" aria-labelledby="map-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="map-title" className="text-[15px] text-fg">
                Collateral liquidated as NEAR falls, {net}
              </h2>
              <span className="text-[13px] text-muted">
                {d.accounts.toLocaleString()} borrowing accounts
                {d.sweep ? ` of ${d.sweep.totalAccounts.toLocaleString()} read` : ""}
                {now ? `, ${formatRelativeTime(d.readAt, now)}` : ""}
              </span>
            </div>
            <Heatmap className="mt-5" buckets={d.buckets} cascades={d.cascades} price={d.price} floor={floor} height={360} mine={mine ? { liqPrice: mine.liqPrice } : undefined} />
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-muted">
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-[2px] bg-fg/60" aria-hidden="true" />
                Collateral liquidated at that price
              </span>
              <span className="flex items-center gap-2">
                <span className="h-0.5 w-4 bg-brass" aria-hidden="true" />
                Running total as the price falls
              </span>
              <span className="flex items-center gap-2">
                <span className="h-0.5 w-4 rounded-full bg-brass-fill" aria-hidden="true" />
                Cascade chain: liquidations there push the price further down
              </span>
              {mine ? (
                <span className="flex items-center gap-2">
                  <span className="h-3 w-0.5 bg-critical" aria-hidden="true" />
                  Your liquidation price
                </span>
              ) : null}
            </div>
          </section>

          <dl className="ruled grid-cols-2 lg:grid-cols-4">
            {[
              ["Within a 10% drop", formatUsdCompact(within(0.9))],
              ["Within a 30% drop", formatUsdCompact(within(0.7))],
              ["Cascade pressure now", d.pressure ? `${(d.pressure.pressure * 100).toFixed(3)}%` : "n/a"],
              ["Largest chain", biggest ? formatUsdCompact(biggest.collateralUsd) : "none"],
            ].map(([k, v]) => (
              <div key={k} className="p-5">
                <dt className="label">{k}</dt>
                <dd className="num mt-2 text-xl text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          {d.pressure ? (
            <p className="-mt-2 text-[13px] leading-5 text-muted">
              Cascade pressure is the price move the liquidations within reach would cause on their own, against the market depth in the source below. It feeds the risk score of every protected position.
            </p>
          ) : null}

          {d.cascades.length ? (
            <section className="surface p-6" aria-labelledby="chains-title">
              <h2 id="chains-title" className="text-[15px] text-fg">
                Cascade chains
              </h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[12.5px] text-muted">
                      <th scope="col" className="py-2 pr-4 font-normal">
                        Starts at
                      </th>
                      <th scope="col" className="py-2 pr-4 font-normal">
                        Ends at
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-normal">
                        Collateral
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-normal">
                        Accounts
                      </th>
                      <th scope="col" className="py-2 text-right font-normal">
                        Rounds
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {[...d.cascades]
                      .sort((a, b) => b.from - a.from)
                      .map((c, i) => (
                        <tr key={i}>
                          <td className="num py-2.5 pr-4 text-fg">
                            ${c.from.toFixed(3)} <span className="text-muted">({Math.round((c.from / d.price - 1) * 100)}%)</span>
                          </td>
                          <td className="num py-2.5 pr-4 text-fg">${c.to.toFixed(3)}</td>
                          <td className="num py-2.5 pr-4 text-right text-fg">{formatUsdCompact(c.collateralUsd)}</td>
                          <td className="num py-2.5 pr-4 text-right text-fg">{c.accounts ?? "n/a"}</td>
                          <td className="num py-2.5 text-right text-fg">{c.rounds ?? "n/a"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {d.source ? <p className="break-words text-[12px] leading-5 text-muted">Source: {d.source}. NEAR drives the map: wNEAR and the liquid staking tokens move with it.</p> : null}
        </>
      )}
    </div>
  );
}
