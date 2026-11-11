"use client";

import { StepOrder, type OrderItem } from "@/components/app/StepOrder";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { usePrices } from "@/lib/live";
import { DEFAULT_WATCHLIST, useWatchlist } from "@/lib/watchlist";

/** Picks and orders the tokens in the top bar's watchlist, for the connected account. */
export function WatchlistManager() {
  const { account } = useParryAccount();
  const [list, setList] = useWatchlist(account);
  const prices = usePrices();
  const tokens = prices.data?.tokens ?? [];
  const symbols = [...new Set(tokens.map((t) => t.symbol.toUpperCase()))];
  // Picked tokens first, in the viewer's order, then the rest.
  const items: OrderItem[] = [...list.filter((s) => symbols.includes(s)), ...symbols.filter((s) => !list.includes(s))].map((s) => {
    const t = tokens.find((x) => x.symbol.toUpperCase() === s)!;
    return { id: s, label: s, detail: `$${t.priceUsd >= 1 ? t.priceUsd.toFixed(3) : t.priceUsd.toFixed(4)}, from ${t.source}`, on: list.includes(s) };
  });
  return (
    <Card as="section" aria-labelledby="watchlist-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="watchlist-title">Watchlist</span>}
        description={`The token prices in the top bar, in this order. ${account ? "Kept for this account in this browser." : "Kept in this browser."}`}
        actions={
          <button type="button" onClick={() => setList([...DEFAULT_WATCHLIST])} className="text-[13px] text-muted hover:text-fg">
            Reset
          </button>
        }
      />
      {prices.isPending ? (
        <Skeleton height="10rem" shape="block" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No token prices are available from the API right now.</p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto pr-1">
          <StepOrder items={items} onChange={(next) => setList(next.filter((i) => i.on).map((i) => i.id))} />
        </div>
      )}
    </Card>
  );
}
