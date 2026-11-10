"use client";

import { AccountGate } from "@/components/app/AccountGate";
import { QueryError } from "@/components/app/bits";
import { PositionsTable } from "@/components/app/PositionsTable";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Mark } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { usePortfolio } from "@/lib/queries";
import { formatPercent, fromUnits } from "@/lib/units";

function AccountPortfolio({ account }: { account: string }) {
  const q = usePortfolio(account);
  const { format } = useMoney();
  const p = q.data;
  if (q.isError && !p) return <QueryError title="The portfolio could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;

  const pnl = p?.pnl24hUsd ?? null;
  const base = p ? p.equityUsd - (pnl ?? 0) : 0;
  const leverage = p && p.collateralUsd - p.debtUsd > 0 ? p.collateralUsd / (p.collateralUsd - p.debtUsd) : null;
  const debtShare = p && p.collateralUsd > 0 ? Math.min(1, p.debtUsd / p.collateralUsd) : 0;

  return (
    <div className="grid gap-6" data-stagger>
      <Card as="section" aria-labelledby="totals-title" className="grid content-start gap-6">
        <h2 id="totals-title" className="sr-only">
          Totals
        </h2>
        <StatGroup className="grid-cols-1 gap-y-6 sm:grid-cols-3">
          <Stat
            label="Equity"
            size="lg"
            loading={!p}
            value={p ? format(p.equityUsd) : ""}
            delta={
              p && pnl !== null
                ? {
                    value: `${format(pnl, { signed: true })}${base > 0 ? ` (${formatPercent(pnl / base, 2)})` : ""}`,
                    trend: pnl > 0 ? "up" : pnl < 0 ? "down" : "flat",
                    tone: pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral",
                    period: "24 h",
                  }
                : undefined
            }
            hint={p && pnl === null ? "24 h change appears once a day of prices is stored" : "Collateral less debt, plus vault shares"}
          />
          <Stat label="Collateral" size="lg" loading={!p} value={p ? format(p.collateralUsd) : ""} hint={leverage !== null ? `${leverage.toFixed(2)}x leverage` : "No leverage"} />
          <Stat label="Debt" size="lg" loading={!p} value={p ? format(p.debtUsd) : ""} hint={p && p.collateralUsd > 0 ? `${formatPercent(debtShare, 0)} of collateral` : undefined} />
        </StatGroup>
        {p && p.collateralUsd > 0 ? (
          <div className="grid gap-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div className="h-full bg-critical/70" style={{ width: `${debtShare * 100}%` }} />
              <div className="h-full bg-safe/70" style={{ width: `${(1 - debtShare) * 100}%` }} />
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2 rounded-full bg-critical/70" />
                Debt
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2 rounded-full bg-safe/70" />
                Your share of the collateral
              </span>
            </div>
          </div>
        ) : null}
      </Card>

      <Card as="section" aria-labelledby="vault-title" className="grid content-start gap-4">
        <CardHeader
          titleAs="h2"
          title={<span id="vault-title">Vault</span>}
          description="Shares of the delta-neutral vault held by this account."
          actions={
            <ButtonLink href="/app/vault" size="sm" variant="secondary">
              Open the vault
            </ButtonLink>
          }
        />
        <StatGroup className="grid-cols-2">
          <Stat label="Value" loading={!p} value={p ? format(p.vault.valueUsd) : ""} />
          <Stat label="Shares" loading={!p} value={p ? `${fromUnits(p.vault.shares, 24, 4)} EARN` : ""} />
        </StatGroup>
      </Card>

      <Card as="section" padding="none" aria-labelledby="positions-title">
        <div className="px-5 pb-4 pt-5 sm:px-6">
          <CardHeader titleAs="h2" title={<span id="positions-title">Positions</span>} description="Every leveraged position of this account." />
        </div>
        {!p ? (
          <div className="grid gap-3 border-t border-line px-5 py-5 sm:px-6" aria-busy="true">
            <Skeleton height="2.25rem" shape="block" />
          </div>
        ) : p.positions.length === 0 ? (
          <div className="border-t border-line p-5 sm:p-6">
            <EmptyState
              compact
              titleAs="h3"
              icon={<Mark size={22} />}
              title="No positions yet"
              description="A position opened from this account shows up here with its share of the totals."
              action={<ButtonLink href="/app/open">Open a protected position</ButtonLink>}
            />
          </div>
        ) : (
          <div className="border-t border-line">
            <PositionsTable positions={p.positions} caption="Positions in this portfolio" />
          </div>
        )}
      </Card>
    </div>
  );
}

export function PortfolioView() {
  return (
    <AccountGate title="Connect an account to see its portfolio" description="Collateral, debt, equity and vault shares, with the change over the last day.">
      {({ account }) => <AccountPortfolio account={account} />}
    </AccountGate>
  );
}
