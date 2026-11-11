"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { errorMessage } from "@/components/app/bits";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Button } from "@/components/ui/Button";
import { parry } from "@/lib/parry";
import { formatProbability, shortId } from "@/lib/units";
import { DEFAULT_THRESHOLDS, useWatched, watchState, type Watched } from "@/lib/watched";
import { cn } from "@/lib/cn";

const ACCOUNT = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
type SortKey = "health" | "score" | "account";

function AddForm({ onAdd, initial }: { onAdd: (w: Watched) => void; initial: string }) {
  const [account, setAccount] = useState(initial);
  const [label, setLabel] = useState("");
  const [score, setScore] = useState<number>(DEFAULT_THRESHOLDS.score);
  const [health, setHealth] = useState<number>(DEFAULT_THRESHOLDS.health);
  const id = account.trim().toLowerCase();
  const valid = ACCOUNT.test(id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onAdd({ account: id, label: label.trim() || null, thresholds: { score, health } });
    setAccount("");
    setLabel("");
  };
  const field = "h-10 min-w-0 rounded-[10px] border border-line-strong bg-raised px-3 text-sm text-fg placeholder:text-muted";
  return (
    <form onSubmit={submit} className="surface grid gap-4 p-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_6rem_6rem_auto] sm:items-end" noValidate aria-label="Watch an account">
      <label className="grid gap-1.5">
        <span className="text-[13px] text-muted">NEAR account</span>
        <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="alice.near" autoComplete="off" spellCheck={false} className={cn(field, "num text-[13px]")} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-[13px] text-muted">Label (optional)</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Treasury" className={field} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-[13px] text-muted">Score at</span>
        <input type="number" min={1} max={100} value={score} onChange={(e) => setScore(Number(e.target.value))} className={cn(field, "num")} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-[13px] text-muted">Health at</span>
        <input type="number" min={1} max={3} step={0.05} value={health} onChange={(e) => setHealth(Number(e.target.value))} className={cn(field, "num")} />
      </label>
      <Button type="submit" disabled={!valid}>
        Watch
      </Button>
    </form>
  );
}

/** Accounts anyone can keep an eye on, with live risk, thresholds that raise alerts, and a sortable table. */
export function WatchedView() {
  const params = useSearchParams();
  const { list, save } = useWatched();
  const acct = useParryAccount();
  const { format } = useMoney();
  const [sort, setSort] = useState<SortKey>("health");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const owner = acct.signer === "wallet" || acct.signer === "passkey";
  const add = params.get("add") ?? "";

  const checks = useQueries({
    queries: list.map((w) => ({ queryKey: ["risk-check", w.account], queryFn: () => parry().riskCheck(w.account), refetchInterval: 60_000, retry: 1 })),
  });

  const mirror = async (fn: (token: string) => Promise<unknown>) => {
    if (!owner) return;
    setSyncError(null);
    try {
      await acct.withSignIn(fn);
      setSynced(true);
    } catch (e) {
      setSyncError(errorMessage(e));
    }
  };

  const onAdd = (w: Watched) => {
    save([...list.filter((x) => x.account !== w.account), w]);
    if (synced) void mirror((t) => parry().watch(t, w.account, { thresholds: w.thresholds, ...(w.label ? { label: w.label } : {}) }));
  };
  const remove = (account: string) => {
    save(list.filter((x) => x.account !== account));
    if (synced) void mirror((t) => parry().unwatch(t, account));
  };
  const syncAll = () => void mirror(async (t) => Promise.all(list.map((w) => parry().watch(t, w.account, { thresholds: w.thresholds, ...(w.label ? { label: w.label } : {}) }))));

  // A link from a public check (/check) lands here with ?add=: put it in the form.
  useEffect(() => {
    if (add) document.getElementById("watch-add")?.scrollIntoView({ block: "center" });
  }, [add]);

  const rows = useMemo(() => {
    const out = list.map((w, i) => ({ w, check: checks[i] }));
    const health = (r: (typeof out)[number]) => r.check?.data?.position?.health ?? Infinity;
    const score = (r: (typeof out)[number]) => r.check?.data?.position?.score ?? -1;
    return out.sort((a, b) => (sort === "account" ? a.w.account.localeCompare(b.w.account) : sort === "score" ? score(b) - score(a) : health(a) - health(b)));
  }, [list, checks, sort]);

  const th = (key: SortKey, label: string, cls = "") => (
    <th scope="col" className={cn("py-2 pr-4 font-normal", cls)} aria-sort={sort === key ? (key === "score" ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => setSort(key)} className={cn("hover:text-fg", sort === key && "text-fg")}>
        {label}
      </button>
    </th>
  );

  return (
    <div className="grid gap-6">
      <div id="watch-add">
        <AddForm key={add} onAdd={onAdd} initial={add} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
        <span>
          {list.length} {list.length === 1 ? "account" : "accounts"}, kept in this browser, read every minute.
        </span>
        {owner ? (
          synced ? (
            <span className="text-fg">Alerts on: the API watches this list for {shortId(acct.account ?? "", 10, 6)}.</span>
          ) : (
            <Button size="sm" variant="secondary" onClick={syncAll} disabled={!list.length}>
              Turn on alerts for this list
            </Button>
          )
        ) : (
          <span>Connect your account to get alerts when one crosses its thresholds.</span>
        )}
      </div>
      {syncError ? <p className="text-[13px] text-critical">{syncError}</p> : null}
      {list.length === 0 ? (
        <div className="surface grid place-items-center px-6 py-16 text-center">
          <p className="max-w-md text-sm leading-6 text-muted">
            No accounts watched yet. Add any NEAR account with a Rhea position, yours or not: Parry reads its risk every minute and marks it when the score or the health crosses your thresholds. You can also start from{" "}
            <Link href="/check" className="text-brass hover:underline">
              a public check
            </Link>
            .
          </p>
        </div>
      ) : (
        <section className="surface overflow-x-auto p-2 sm:p-4" aria-label="Watched accounts">
          <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[12.5px] text-muted">
                {th("account", "Account", "pl-3")}
                {th("health", "Health", "w-[30%]")}
                {th("score", "Score", "text-right")}
                <th scope="col" className="py-2 pr-4 text-right font-normal">
                  Liquidation price
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-normal">
                  In 24 h
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  State
                </th>
                <th scope="col" className="py-2 pr-3">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(({ w, check }) => {
                const p = check?.data?.position ?? null;
                const state = watchState(p, w.thresholds);
                return (
                  <tr key={w.account}>
                    <td className="py-3 pl-3 pr-4">
                      <Link href={`/check?account=${encodeURIComponent(w.account)}`} className="num text-[13px] text-fg hover:underline" title={w.account}>
                        {shortId(w.account, 14, 6)}
                      </Link>
                      <span className="block text-[12px] text-muted">
                        {w.label ? `${w.label}, ` : ""}alerts at score {w.thresholds.score} or health {w.thresholds.health.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      {check?.isPending ? <span className="text-muted">reading</span> : p ? <RiskInstrument variant="compact" health={p.health} tier={p.tier} trigger={w.thresholds.health} /> : <span className="text-muted">{check?.isError ? "could not read" : "no lending position"}</span>}
                    </td>
                    <td className="num py-3 pr-4 text-right text-fg">{p ? p.score : ""}</td>
                    <td className="num py-3 pr-4 text-right text-fg">{p?.liqPrice ? format(p.liqPrice) : ""}</td>
                    <td className="num py-3 pr-4 text-right text-fg">{p ? formatProbability(p.probability24h) : ""}</td>
                    <td className={cn("py-3 pr-4", state === "alert" ? "text-critical" : "text-muted")}>{state === "alert" ? "Over threshold" : state === "ok" ? "Within" : ""}</td>
                    <td className="py-3 pr-3 text-right">
                      <button type="button" onClick={() => remove(w.account)} className="text-[13px] text-muted hover:text-fg" aria-label={`Stop watching ${w.account}`}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
