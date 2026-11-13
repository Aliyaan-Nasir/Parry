"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { Certificate, CertificateBody } from "@parryguard/sdk";
import { AccountGate } from "@/components/app/AccountGate";
import { errorMessage, QueryError, Segmented } from "@/components/app/bits";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { Slider } from "@/components/ui/Slider";
import { explorerUrl } from "@/lib/explorer";
import { useCertificates } from "@/lib/live";
import { parry } from "@/lib/parry";
import { usePositions } from "@/lib/queries";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/cn";

const TTL = [
  { value: 3600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 604_800, label: "7 days" },
] as const;

const body = (c: Certificate): CertificateBody | null => {
  try {
    return JSON.parse(c.certificate) as CertificateBody;
  } catch {
    return null;
  }
};

function left(expires: number, now: number): string {
  const s = expires - now / 1000;
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86_400) return `${Math.round(s / 3600)} h left`;
  return `${Math.round(s / 86_400)} days left`;
}

function Issue({ account, signer, health }: { account: string; signer: Signer; health: number | null }) {
  const acct = useParryAccount();
  const qc = useQueryClient();
  const [reader, setReader] = useState("");
  const [threshold, setThreshold] = useState(1.3);
  const [ttl, setTtl] = useState<number>(86_400);
  const [anchor, setAnchor] = useState(true);
  const issue = useMutation({
    mutationFn: () => acct.withSignIn((token) => parry().issueCertificate(token, { account, reader: reader.trim(), threshold, ttlSecs: ttl, venue: "rhea", anchor })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["live", "certificates"] }),
  });
  const canAct = signer !== "watch";
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (reader.trim()) issue.mutate();
  };
  const below = health !== null && health < threshold;
  const unavailable = (issue.error as { status?: number } | null)?.status === 503;
  return (
    <section id="issue" className="surface scroll-mt-24 p-6" aria-labelledby="issue-title">
      <h2 id="issue-title" className="text-[15px] text-fg">
        Issue a certificate
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
        The guardian&apos;s enclave reads your Rhea position at the latest final block and signs one sentence for one reader: health is at least the threshold. It signs nothing when health is below it.
      </p>
      <form onSubmit={onSubmit} className="mt-6 grid gap-6 sm:grid-cols-2" noValidate>
        <label className="grid content-start gap-1.5">
          <span className="text-sm text-fg">For whom</span>
          <input
            value={reader}
            onChange={(e) => setReader(e.target.value)}
            placeholder="lender.near, or a name"
            disabled={!canAct}
            autoComplete="off"
            spellCheck={false}
            className="h-10 rounded-[10px] border border-line-strong bg-raised px-3 text-sm text-fg placeholder:text-muted disabled:opacity-55"
          />
          <span className="text-[12.5px] text-muted">Named in the signed text, so it cannot be passed on as if it were for someone else.</span>
        </label>
        <Slider label="Health at least" min={1.05} max={3} step={0.05} value={threshold} formatValue={(v) => v.toFixed(2)} onValueChange={(v) => setThreshold(Math.round(v * 100) / 100)} disabled={!canAct} description={health !== null ? `Your health now is ${health.toFixed(2)}.` : undefined} />
        <div className="grid content-start justify-items-start gap-2">
          <span className="text-sm text-fg">Valid for</span>
          <Segmented label="Valid for" options={TTL} value={ttl as 3600 | 86_400 | 604_800} onChange={setTtl} />
        </div>
        <label className="flex items-start gap-3 text-sm text-fg">
          <input type="checkbox" checked={anchor} onChange={(e) => setAnchor(e.target.checked)} disabled={!canAct} className="mt-0.5 size-4" />
          <span>
            Anchor it on the risk board
            <span className="block text-[12.5px] text-muted">Writes its hash on chain, so anyone can see when it was issued without the certificate itself.</span>
          </span>
        </label>
        <div className="grid gap-2 sm:col-span-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canAct || !reader.trim() || below} loading={issue.isPending} loadingLabel="Asking the enclave">
              Issue
            </Button>
            <span className="text-[13px] text-muted">{!canAct ? "Watching only: the owner issues certificates." : below ? "Health is below this threshold now, so the enclave would refuse." : "You sign in once; the enclave signs the certificate."}</span>
          </div>
          {issue.isError ? (
            <p role="alert" className="text-[13px] text-critical">
              {unavailable ? "Issuing opens once the enclave's certificate mode is deployed on this network." : errorMessage(issue.error)}
            </p>
          ) : null}
          {issue.data ? (
            <p className="text-[13px] text-fg" aria-live="polite">
              Issued.{" "}
              <Link href={`/verify?id=${issue.data.hash}`} className="text-brass hover:underline">
                Verify it
              </Link>{" "}
              or send that link to {reader.trim()}.
            </p>
          ) : null}
        </div>
      </form>
      <div className="mt-6 grid gap-4 border-t border-line pt-5 text-[13px] leading-5 sm:grid-cols-2">
        <div>
          <div className="text-fg">What it proves</div>
          <p className="mt-1 text-muted">That the attested guardian code read this account&apos;s Rhea position at the named block and found health at or above the threshold, for this reader, until it expires.</p>
        </div>
        <div>
          <div className="text-fg">What it does not</div>
          <p className="mt-1 text-muted">Health after that block, or any amount: collateral, debt and the actual health are never in it. A reader who needs it to hold over time should ask for a short expiry and a fresh one.</p>
        </div>
      </div>
    </section>
  );
}

function List({ account }: { account: string }) {
  const q = useCertificates(account);
  const now = useNow();
  const rows = q.data ?? [];
  return (
    <section className="surface p-6" aria-labelledby="list-title">
      <h2 id="list-title" className="text-[15px] text-fg">
        Issued
      </h2>
      {q.isError && !q.data ? (
        <QueryError title="The certificates could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="6rem" shape="block" className="mt-4" />
      ) : rows.length === 0 ? (
        <div className="mt-4 grid place-items-center border-y border-line py-10 text-center">
          <p className="max-w-sm text-sm text-muted">No certificates for this account yet. Issue one above and it appears here, with its expiry and a link anyone can verify.</p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[12.5px] text-muted">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Statement
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  For
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Block
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Expires
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  <span className="sr-only">Links</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                const b = body(c);
                const expired = !!b && now !== null && b.expires_at * 1000 <= now;
                return (
                  <tr key={c.hash} className={cn(expired && "text-muted")}>
                    <td className="py-3 pr-4 text-fg">{b?.statement ?? "unreadable"}</td>
                    <td className="num py-3 pr-4">{b?.reader}</td>
                    <td className="num py-3 pr-4">{b?.block_height.toLocaleString()}</td>
                    <td className="py-3 pr-4">{b && now ? left(b.expires_at, now) : ""}</td>
                    <td className="py-3 text-right">
                      <span className="inline-flex gap-4 text-[13px]">
                        <Link href={`/verify?id=${c.hash}`} className="text-brass hover:underline">
                          Verify
                        </Link>
                        {c.anchorTx ? (
                          <a href={explorerUrl("nearblocks", c.anchorTx) ?? undefined} target="_blank" rel="noreferrer" className="text-muted hover:text-fg">
                            Anchor
                          </a>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Body({ account, signer }: { account: string; signer: Signer }) {
  const positions = usePositions(account);
  const rhea = positions.data?.find((p) => p.venue === "rhea") ?? null;
  return (
    <div className="grid gap-6">
      <Issue account={account} signer={signer} health={rhea?.health ?? null} />
      <List account={account} />
    </div>
  );
}

export function CertificatesView() {
  return (
    <AccountGate title="Connect an account to issue certificates" description="A certificate tells one named reader that your position's health is at least a threshold, and nothing else.">
      {({ account, signer }) => <Body account={account} signer={signer} />}
    </AccountGate>
  );
}
