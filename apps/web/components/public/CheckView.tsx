"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Heatmap } from "@/components/instrument/Heatmap";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { Button } from "@/components/ui/Button";
import { useHeatmap } from "@/lib/live";
import { parry } from "@/lib/parry";
import { formatDuration, formatProbability } from "@/lib/units";
import { formatUsdCompact } from "@/lib/format";

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;

/** Risk for any NEAR account's lending position, without signing in. The URL carries the account. */
export function CheckView() {
  const params = useSearchParams();
  const router = useRouter();
  const account = params.get("account");
  const [draft, setDraft] = useState(account ?? "");
  const [error, setError] = useState<string | null>(null);
  const check = useQuery({ queryKey: ["check", account], queryFn: () => parry().riskCheck(account!), enabled: !!account && ACCOUNT.test(account), retry: 0 });
  const map = useHeatmap("testnet");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = draft.trim().toLowerCase();
    if (!ACCOUNT.test(id)) return setError("Enter a NEAR account id, for example alice.near or a 64 character implicit id.");
    setError(null);
    router.replace(`/check?account=${encodeURIComponent(id)}`);
  };
  const p = check.data?.position ?? null;
  const market = check.data?.market as { tremor?: { annual?: number; regime?: string } } | null | undefined;
  return (
    <div>
      <form onSubmit={submit} className="surface-glass flex flex-col gap-3 p-2 sm:flex-row sm:items-center sm:!rounded-full">
        <label htmlFor="check-account" className="sr-only">
          NEAR account
        </label>
        <input
          id="check-account"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="alice.near"
          autoComplete="off"
          spellCheck={false}
          className="num h-12 min-w-0 flex-1 rounded-full bg-transparent px-5 text-lg text-fg outline-none placeholder:text-muted/60"
        />
        <Button type="submit" size="lg" className="!rounded-full px-7" loading={check.isFetching}>
          Check risk
        </Button>
      </form>
      {error ? <p className="mt-3 text-sm text-critical">{error}</p> : null}
      {check.isError ? <p className="mt-6 text-sm text-critical">{(check.error as Error).message}</p> : null}
      {account && check.data && !p ? <p className="mt-10 text-lg text-muted">{account} has no lending position on Rhea, so there is nothing to liquidate.</p> : null}
      {p ? (
        <div className="mt-10 grid gap-6">
          <div className="surface p-6 sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="num text-lg text-fg">{account}</h2>
              <span className="text-sm text-muted">{p.label}</span>
            </div>
            <div className="mt-6">
              <RiskInstrument health={p.health} tier={p.tier} variant="hero" annualVol={market?.tremor?.annual ?? null} />
            </div>
          </div>
          <dl className="ruled grid-cols-2 sm:grid-cols-4">
            {[
              ["Liquidation price", p.liqPrice ? `$${p.liqPrice.toFixed(3)}` : "none"],
              ["Liquidation in 24 h", formatProbability(p.probability24h)],
              ["Median time to it", formatDuration(p.ttlHours)],
              ["Score", `${p.score} of 100`],
              ["Collateral", formatUsdCompact(p.collateralUsd)],
              ["Debt", formatUsdCompact(p.debtUsd)],
              ["Value at risk, 99 %", formatUsdCompact(p.valueAtRisk99)],
              ["Volatility", market?.tremor?.regime ?? "measured live"],
            ].map(([k, v]) => (
              <div key={k} className="p-5">
                <dt className="label">{k}</dt>
                <dd className="num mt-2 text-xl text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          {map.data ? (
            <div className="surface p-6">
              <div className="label">Where this position sits among every Rhea borrower on {map.data.network}</div>
              <Heatmap className="mt-4" buckets={map.data.buckets} cascades={map.data.cascades} price={map.data.price} mine={{ liqPrice: p.liqPrice }} height={240} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
            <span className="text-muted">The model behind these numbers is written down in full.</span>
            <span className="flex gap-5">
              <Link href={`/app/watched?add=${account}`} className="text-brass underline-offset-4 hover:underline">
                Watch this account
              </Link>
              <Link href="/app" className="text-brass underline-offset-4 hover:underline">
                Protect a position
              </Link>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
