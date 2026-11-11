"use client";

import { useParryAccount } from "@/components/providers/AccountProvider";
import { usePrices } from "@/lib/live";
import { useWatchlist } from "@/lib/watchlist";
import { cn } from "@/lib/cn";

/**
 * A slim, quiet row of live NEAR-ecosystem prices: the tokens the viewer picked in Settings, each
 * with its 24 h change. It never grows taller than one line; it scrolls sideways on narrow screens.
 */
export function WatchlistBar({ className }: { className?: string }) {
  const { account } = useParryAccount();
  const [list] = useWatchlist(account);
  const { data } = usePrices();
  const all = data?.tokens ?? [];
  const tokens = list.flatMap((sym) => all.filter((t) => t.symbol.toUpperCase() === sym).slice(0, 1));
  if (!tokens.length) return <div className={cn("h-5", className)} />;
  return (
    <ul className={cn("flex min-w-0 items-center gap-5 overflow-x-auto whitespace-nowrap text-[12px] [mask-image:linear-gradient(90deg,#000_85%,transparent)] [scrollbar-width:none]", className)} aria-label="Watched token prices">
      {tokens.map((t) => (
        <li key={t.id} className="flex items-end gap-1.5" title={`Source: ${t.source}`}>
          <span className="text-muted">{t.symbol}</span>
          <span className="num text-fg">{t.priceUsd >= 100 ? t.priceUsd.toFixed(0) : t.priceUsd >= 1 ? t.priceUsd.toFixed(3) : t.priceUsd.toFixed(4)}</span>
          {t.change24h !== null ? (
            <span className={cn("num", t.change24h >= 0 ? "text-fg/60" : "text-muted")}>
              {t.change24h >= 0 ? "+" : "-"}
              {Math.abs(t.change24h * 100).toFixed(1)}%
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
