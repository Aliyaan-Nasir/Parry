"use client";

import type { RouteComparison as Routes } from "@parry/sdk";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Badge } from "@/components/ui/Badge";
import { formatNumber, formatPercent } from "@/lib/units";
import { network } from "@/lib/env";
import { cn } from "@/lib/cn";

/**
 * Where a rescue swap of collateral for USDC would go: Rhea's pool, executed on chain, against a
 * NEAR Intents 1Click quote. The better route is marked as chosen.
 */
export function RouteComparison({ routes, className }: { routes: Routes; className?: string }) {
  const { format } = useMoney();
  const intents = "unavailable" in routes.intents ? null : routes.intents;
  const rows = [
    {
      key: "rhea" as const,
      name: "Rhea pool",
      detail: routes.rhea ? `Pool ${routes.rhea.poolId}, price impact ${formatPercent(routes.rhea.priceImpact, 2)}` : "No pool quote",
      out: routes.rhea?.outUsd ?? null,
    },
    {
      key: "intents" as const,
      name: "NEAR Intents",
      detail: intents ? (intents.confidential ? "1Click quote, confidential" : "1Click quote") : "unavailable" in routes.intents ? routes.intents.unavailable : "",
      out: intents?.outUsd ?? null,
    },
  ];
  return (
    <div className={cn("grid gap-3", className)}>
      <p className="text-[13px] text-muted">
        Selling <span className="num text-fg">{formatNumber(routes.amountNear, 2)} NEAR</span> of collateral for USDC:
      </p>
      <ul className="grid gap-2">
        {rows.map((r) => {
          const chosen = routes.chosen === r.key;
          return (
            <li key={r.key} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border px-4 py-3", chosen ? "border-brass/50 bg-brass-soft" : "border-line")}>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-fg">{r.name}</span>
                  {chosen ? <Badge tone="brass">Chosen</Badge> : null}
                </span>
                <span className="mt-0.5 block text-[13px] text-muted">{r.detail}</span>
              </span>
              <span className="num text-sm font-medium text-fg">{r.out !== null ? format(r.out) : <span className="text-muted">No quote</span>}</span>
            </li>
          );
        })}
      </ul>
      {intents?.dry || network === "testnet" ? (
        <p className="text-[13px] leading-5 text-muted">
          {network === "testnet"
            ? "On testnet the NEAR Intents figure is a dry-run quote from the mainnet 1Click API: it shows what the route would pay, and nothing is swapped through it."
            : "The NEAR Intents figure is a dry-run quote: it shows what the route would pay without placing the swap."}
        </p>
      ) : null}
    </div>
  );
}
