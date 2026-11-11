"use client";

import { ParryApiError } from "@parry/sdk";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { CloseFlow } from "@/components/app/CloseFlow";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { parry } from "@/lib/parry";
import { shortId } from "@/lib/units";
import { useWatched, watchState } from "@/lib/watched";
import { cn } from "@/lib/cn";
import { AccountAddress } from "@/components/app/AccountAddress";
import { AccountGate } from "@/components/app/AccountGate";
import { SIGNER_LABEL } from "@/components/app/AccountButton";
import { QueryError } from "@/components/app/bits";
import { AlertRow, DecisionRow, FeedLink, newestFirst } from "@/components/app/Feeds";
import { MarketStrip } from "@/components/app/MarketStrip";
import { mandateStatus } from "@/components/app/mandate";
import { PositionCard } from "@/components/app/PositionCard";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Mark } from "@/components/brand/Logo";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAccountSummary, useAlerts, useDecisions } from "@/lib/queries";
import { useNow } from "@/lib/use-now";

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="grid gap-4" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="grid gap-1.5">
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </li>
      ))}
    </ul>
  );
}

function AlertsCard({ account }: { account: string }) {
  const q = useAlerts(account);
  const latest = newestFirst(q.data ?? []).slice(0, 5);
  return (
    <Card as="section" aria-labelledby="alerts-title" className="grid content-start gap-5">
      <CardHeader titleAs="h2" title={<span id="alerts-title">Alerts</span>} description="The latest five, newest first." actions={<FeedLink href="/app/alerts">All alerts</FeedLink>} />
      {q.isPending ? (
        <ListSkeleton />
      ) : q.isError ? (
        <QueryError title="Alerts could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : latest.length === 0 ? (
        <p className="text-sm text-muted">No alerts. Parry raises one when a position crosses your thresholds.</p>
      ) : (
        <ul className="grid divide-y divide-line">
          {latest.map((a) => (
            <li key={a.id} className="py-3.5 first:pt-0 last:pb-0">
              <AlertRow alert={a} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GuardianCard({ account }: { account: string }) {
  const q = useDecisions(account, 5);
  const latest = q.data?.pages[0]?.items.slice(0, 5) ?? [];
  return (
    <Card as="section" aria-labelledby="guardian-title" className="grid content-start gap-5">
      <CardHeader
        titleAs="h2"
        title={<span id="guardian-title">Guardian actions</span>}
        description="What the guardian did on this account, latest five."
        actions={<FeedLink href="/app/guardian">Guardian log</FeedLink>}
      />
      {q.isPending ? (
        <ListSkeleton />
      ) : q.isError ? (
        <QueryError title="Guardian actions could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : latest.length === 0 ? (
        <p className="text-sm text-muted">No guardian actions yet. Each one appears here with its AI review and its transaction.</p>
      ) : (
        <ul className="grid divide-y divide-line">
          {latest.map((d) => (
            <li key={d.id} className="py-3.5 first:pt-0 last:pb-0">
              <DecisionRow decision={d} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The accounts this browser watches, at a glance, with the full table one click away. */
function WatchedCard() {
  const { list } = useWatched();
  const shown = list.slice(0, 5);
  const checks = useQueries({ queries: shown.map((w) => ({ queryKey: ["risk-check", w.account], queryFn: () => parry().riskCheck(w.account), refetchInterval: 60_000, retry: 1 })) });
  if (!list.length) return null;
  return (
    <Card as="section" aria-labelledby="watched-title" className="grid content-start gap-4">
      <CardHeader titleAs="h2" title={<span id="watched-title">Watched accounts</span>} actions={<FeedLink href="/app/watched">All {list.length}</FeedLink>} />
      <ul className="grid divide-y divide-line">
        {shown.map((w, i) => {
          const p = checks[i]?.data?.position ?? null;
          const over = watchState(p, w.thresholds) === "alert";
          return (
            <li key={w.account} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6rem] items-center gap-4 py-2.5 first:pt-0 last:pb-0">
              <Link href={`/check?account=${encodeURIComponent(w.account)}`} className="num truncate text-[13px] text-fg hover:underline" title={w.account}>
                {w.label ?? shortId(w.account, 10, 4)}
              </Link>
              {p ? <RiskInstrument variant="compact" health={p.health} tier={p.tier} trigger={w.thresholds.health} /> : <span className="text-[13px] text-muted">{checks[i]?.isPending ? "reading" : "no position"}</span>}
              <span className={cn("text-right text-[13px]", over ? "text-critical" : "text-muted")}>{p ? (over ? "Over threshold" : "Within") : ""}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function AccountDashboard({ account, signer }: { account: string; signer: Signer }) {
  const acct = useParryAccount();
  const summary = useAccountSummary(account);
  const decisions = useDecisions(account, 10);
  const { format } = useMoney();
  const now = useNow();
  const s = summary.data;
  // The command palette opens the close and unwind flows here (?action=close|unwind).
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  if (summary.isError && !s) {
    const missing = summary.error instanceof ParryApiError && summary.error.status === 404;
    return (
      <div className="grid gap-4">
        <QueryError
          title={missing ? "This is not a Parry protected account" : "Your account could not be loaded"}
          error={summary.error}
          onRetry={missing ? undefined : () => void summary.refetch()}
        />
        {missing && signer === "watch" ? (
          <div>
            <Button variant="secondary" onClick={acct.stopWatching}>
              Stop watching it
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const positions = s?.positions ?? [];
  const collateral = positions.reduce((t, p) => t + p.collateralUsd, 0);
  const debt = positions.reduce((t, p) => t + p.debtUsd, 0);
  const status = s && now ? mandateStatus(s.mandate, now / 1000) : null;
  const recent = decisions.data?.pages[0]?.items ?? [];
  const lastFor = (venue: string) => recent.find((d) => d.venue === venue || (venue === "aave" && (d.venue as string) === "evm")) ?? null;
  const action = params.get("action");
  const flow = action === "close" || action === "unwind" ? action : null;
  const closing = positions.find((p) => p.debtUsd > 0) ?? positions[0] ?? null;

  return (
    <div className="grid gap-8" data-stagger>
      <section aria-labelledby="account-title" className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h2 id="account-title" className="label">
            {SIGNER_LABEL[signer]} protected account
          </h2>
          <div className="mt-1">
            <AccountAddress id={account} label="protected account address" />
          </div>
          <p className="mt-2 text-sm text-fg/80">{status ? `${status.label}. ${status.detail}` : <Skeleton width="30ch" />}</p>
        </div>
        <dl className="grid w-full grid-cols-[1fr_1fr_auto] gap-x-4 gap-y-1 sm:flex sm:w-auto sm:gap-10">
          <div>
            <dt className="label">Collateral</dt>
            <dd className="num mt-1 text-lg text-fg sm:text-2xl">{s ? format(collateral) : <Skeleton width="7ch" />}</dd>
          </div>
          <div>
            <dt className="label">Debt</dt>
            <dd className="num mt-1 text-lg text-fg sm:text-2xl">{s ? format(debt) : <Skeleton width="7ch" />}</dd>
          </div>
          <div>
            <dt className="label">
              Guardian <span className="sr-only sm:not-sr-only">actions</span>
            </dt>
            <dd className="num mt-1 text-lg text-fg sm:text-2xl">{s ? s.stats.guardianActions : <Skeleton width="3ch" />}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="positions-title">
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 id="positions-title" className="text-[15px] text-fg">
            Positions
          </h2>
          <ButtonLink href="/app/open" size="sm" variant="secondary">
            Open position
          </ButtonLink>
        </div>
        {!s ? (
          <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
            <Skeleton height="13rem" shape="block" />
            <Skeleton height="13rem" shape="block" />
          </div>
        ) : positions.length === 0 ? (
          <EmptyState
            compact
            titleAs="h3"
            icon={<Mark size={22} />}
            title="No positions yet"
            description="Open a leveraged position from this account, and Parry starts scoring it within seconds."
            action={<ButtonLink href="/app/open">Open a protected position</ButtonLink>}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {positions.map((p) => (
              <PositionCard key={p.id} position={p} mandate={s.mandate} lastDecision={lastFor(p.venue)} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <GuardianCard account={account} />
        <AlertsCard account={account} />
      </div>
      <WatchedCard />
      {s && flow && (flow === "unwind" || closing) ? <CloseFlow summary={s} position={closing} mode={flow} open onOpenChange={(v) => !v && router.replace(pathname)} /> : null}
    </div>
  );
}

export function Dashboard() {
  return (
    <div className="grid gap-6">
      <MarketStrip />
      <AccountGate title="Connect an account to see your positions" description="Each position appears here with its risk score, time to liquidation and protection status.">
        {({ account, signer }) => <AccountDashboard account={account} signer={signer} />}
      </AccountGate>
    </div>
  );
}
