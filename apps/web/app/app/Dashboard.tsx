"use client";

import { ParryApiError } from "@parry/sdk";
import { AccountAddress } from "@/components/app/AccountAddress";
import { AccountGate } from "@/components/app/AccountGate";
import { SIGNER_LABEL } from "@/components/app/AccountButton";
import { QueryError } from "@/components/app/bits";
import { AlertRow, DecisionRow, FeedLink, newestFirst } from "@/components/app/Feeds";
import { MarketStrip } from "@/components/app/MarketStrip";
import { mandateStatus } from "@/components/app/mandate";
import { PositionsTable } from "@/components/app/PositionsTable";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Mark } from "@/components/brand/Logo";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { RiskGauge } from "@/components/ui/RiskGauge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { useAccountSummary, useAlerts, useDecisions } from "@/lib/queries";
import { formatHealth } from "@/lib/units";
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

function AccountDashboard({ account, signer }: { account: string; signer: Signer }) {
  const acct = useParryAccount();
  const summary = useAccountSummary(account);
  const { format } = useMoney();
  const now = useNow();
  const s = summary.data;

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
  const worst = positions.reduce<number | null>((m, p) => (m === null || p.score > m ? p.score : m), null);
  const lowestHealth = positions.reduce<number | null>((m, p) => (p.health !== null && (m === null || p.health < m) ? p.health : m), null);
  const collateral = positions.reduce((t, p) => t + p.collateralUsd, 0);
  const debt = positions.reduce((t, p) => t + p.debtUsd, 0);
  const status = s && now ? mandateStatus(s.mandate, now / 1000) : null;

  return (
    <div className="grid gap-6" data-stagger>
      <Card as="section" aria-labelledby="account-title" className="grid content-start gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="account-title" className="text-[15px] font-semibold text-fg">
            Protected account
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={signer === "watch" ? "neutral" : "brass"}>{SIGNER_LABEL[signer]}</Badge>
            {status ? <Badge tone={status.tone}>{status.label}</Badge> : <Skeleton width="9ch" />}
          </div>
        </div>
        <AccountAddress id={account} label="protected account address" />
        {status ? <p className="text-[13px] text-muted">{status.detail}</p> : null}
      </Card>

      <Card as="section" aria-labelledby="risk-title" className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
        <h2 id="risk-title" className="sr-only">
          Risk overview
        </h2>
        <div className="flex justify-center md:justify-start">
          <RiskGauge score={s ? worst : null} label="Account risk score: the riskiest position's score" />
        </div>
        <StatGroup className="grid-cols-2 gap-y-5 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
          <Stat label="Collateral" value={format(collateral)} loading={!s} />
          <Stat label="Debt" value={format(debt)} loading={!s} />
          <Stat label="Lowest health" value={formatHealth(lowestHealth)} loading={!s} hint="Liquidation below 1.00" />
          <Stat label="Guardian actions" value={s ? String(s.stats.guardianActions) : ""} loading={!s} hint={s ? `${s.stats.deleverages} deleverages` : undefined} />
        </StatGroup>
      </Card>

      <Card as="section" padding="none" aria-labelledby="positions-title">
        <div className="px-5 pb-4 pt-5 sm:px-6">
          <CardHeader
            titleAs="h2"
            title={<span id="positions-title">Positions</span>}
            description="Refreshed every 10 seconds. Select one for its history and the risk copilot."
            actions={
              <ButtonLink href="/app/open" size="sm" variant="secondary">
                Open position
              </ButtonLink>
            }
          />
        </div>
        {!s ? (
          <div className="grid gap-3 border-t border-line px-5 py-5 sm:px-6" aria-busy="true">
            <Skeleton height="2.25rem" shape="block" />
            <Skeleton height="2.25rem" shape="block" />
          </div>
        ) : positions.length === 0 ? (
          <div className="border-t border-line p-5 sm:p-6">
            <EmptyState
              compact
              titleAs="h3"
              icon={<Mark size={22} />}
              title="No positions yet"
              description="Open a leveraged position from this account, and Parry starts scoring it within seconds."
              action={<ButtonLink href="/app/open">Open a protected position</ButtonLink>}
            />
          </div>
        ) : (
          <div className="border-t border-line">
            <PositionsTable positions={positions} caption="Positions of this account" />
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <AlertsCard account={account} />
        <GuardianCard account={account} />
      </div>
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
