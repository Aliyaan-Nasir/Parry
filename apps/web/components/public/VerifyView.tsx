"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { getJson, type Check, type VerifyLive } from "@/lib/live";
import { cn } from "@/lib/cn";

/**
 * Re-checks a guardian decision, a health certificate or a NEAR transaction from its id: every
 * signature and the on-chain hash, with each check's evidence. The URL carries the id.
 */
async function verify(id: string): Promise<VerifyLive | null> {
  const general = await getJson<VerifyLive>(`/v1/verify/${encodeURIComponent(id)}`).catch(() => null);
  if (general) return general;
  // Decision ids also verify through the guardian log's own route.
  const decision = await getJson<{ ok: boolean; checks: Check[] }>(`/v1/guardian/decisions/${encodeURIComponent(id)}/verify`).catch(() => null);
  return decision ? { kind: "decision", ok: decision.ok, checks: decision.checks, subject: null } : null;
}

export function VerifyView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const [draft, setDraft] = useState(id ?? "");
  const q = useQuery({ queryKey: ["verify", id], queryFn: () => verify(id!), enabled: !!id, retry: 0 });
  const [shown, setShown] = useState(0);
  const checks = q.data?.checks ?? [];
  useEffect(() => {
    if (!checks.length) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let i = 0;
    let t = 0;
    const tick = () => {
      i += 1;
      setShown(i);
      if (i < checks.length) t = window.setTimeout(tick, reduced ? 0 : 320);
    };
    t = window.setTimeout(tick, 0);
    return () => window.clearTimeout(t);
  }, [checks.length, id]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (v) router.replace(`/verify?id=${encodeURIComponent(v)}`);
  };
  return (
    <div>
      <form onSubmit={submit} className="surface-glass flex flex-col gap-3 p-2 sm:flex-row sm:items-center sm:!rounded-full">
        <label htmlFor="verify-id" className="sr-only">
          Decision id, certificate hash or transaction hash
        </label>
        <input
          id="verify-id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="A decision id, a certificate hash or a transaction hash"
          autoComplete="off"
          spellCheck={false}
          className="num h-12 min-w-0 flex-1 rounded-full bg-transparent px-5 text-[15px] text-fg outline-none placeholder:text-muted/60"
        />
        <Button type="submit" size="lg" className="!rounded-full px-7" loading={q.isFetching}>
          Verify
        </Button>
      </form>
      {id && q.isFetched && !q.data ? <p className="mt-8 text-lg text-muted">Nothing found for that id. A decision id is 64 hex characters, as is a certificate hash; a NEAR transaction hash is base58.</p> : null}
      {q.data ? (
        <div className="surface mt-10 p-6 sm:p-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="label">{q.data.kind === "decision" ? "Guardian decision" : q.data.kind === "certificate" ? "Health certificate" : "Transaction"}</div>
              <div className="num mt-1 break-all text-sm text-fg">{id}</div>
            </div>
            <div className={cn("display-sm text-3xl", shown >= checks.length ? (q.data.ok ? "text-fg" : "text-critical") : "text-muted")}>
              {shown >= checks.length ? (q.data.ok ? "Verified" : "Does not verify") : "Checking"}
            </div>
          </div>
          <ol className="mt-8 divide-y divide-line border-t border-line">
            {checks.map((c, i) => (
              <li key={c.name} className={cn("grid gap-1 py-4 transition-opacity duration-300 sm:grid-cols-[1fr_auto] sm:gap-6", i < shown ? "opacity-100" : "opacity-0")}>
                <div>
                  <div className="text-fg">{c.name}</div>
                  <div className="num mt-1 break-all text-[12.5px] leading-5 text-muted">{c.detail}</div>
                </div>
                <div className={cn("num text-sm", c.ok ? "text-fg" : "text-critical")}>{c.ok ? "checks" : "fails"}</div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
