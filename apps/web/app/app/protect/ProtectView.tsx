"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AccountGate } from "@/components/app/AccountGate";
import { AmountField } from "@/components/app/AmountField";
import { Eyebrow, Note, QueryError } from "@/components/app/bits";
import { ACTION_LABEL, STEP_UNIT } from "@/components/app/labels";
import { RouteComparison } from "@/components/app/RouteComparison";
import { type Signer } from "@/components/providers/AccountProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { chain } from "@/lib/parry";
import { useAccountSummary, useMandate, useRescueQuote, useSimulation } from "@/lib/queries";
import { formatHealth, formatNumber } from "@/lib/units";
import { MandateBuilder } from "./MandateBuilder";
import { MandatePanel, type TokenInfo } from "./MandatePanel";

function useContracts() {
  return useQuery({ queryKey: ["contracts"], queryFn: async () => (await chain()).contracts, staleTime: Infinity });
}

function Simulation({ account }: { account: string }) {
  const q = useSimulation(account);
  const s = q.data;
  return (
    <Card as="section" aria-labelledby="sim-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="sim-title">If the guardian looked now</span>}
        description="A dry run of the planner on your position right now, with the default target of 1.45 and repay first. Nothing is signed or sent."
        actions={
          <Button size="sm" variant="ghost" loading={q.isFetching && !q.isPending} loadingLabel="Running the simulation" onClick={() => void q.refetch()}>
            Run again
          </Button>
        }
      />
      {q.isError && !s ? (
        <QueryError title="The simulation could not run" error={q.error} onRetry={() => void q.refetch()} />
      ) : !s ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton />
          <Skeleton width="70%" />
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.triggered ? "caution" : "safe"}>{s.triggered ? "Would act" : "Would wait"}</Badge>
            <span className="text-sm text-fg">{s.reason}</span>
          </div>
          {s.steps.length > 0 ? (
            <ol className="grid gap-2">
              {s.steps.map((step, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-line px-4 py-3">
                  <span className="text-sm font-semibold text-fg">
                    <span className="num mr-2 text-muted">{i + 1}.</span>
                    {ACTION_LABEL[step.kind] ?? step.kind}{" "}
                    <span className="num font-normal">
                      {formatNumber(Number(step.amount), step.kind === "repay" ? 2 : 4)} {STEP_UNIT[step.kind] ?? ""}
                    </span>
                  </span>
                  <span className="num text-[13px] text-muted">
                    health {formatHealth(step.healthBefore)} <span aria-hidden="true">→</span>
                    <span className="sr-only">to</span> <span className="text-fg">{formatHealth(step.healthAfter)}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {s.mandate === false ? <Note tone="caution">This account has no mandate, so the guardian could not act on this plan.</Note> : null}
          {s.routes ? (
            <div className="grid gap-2">
              <Eyebrow>Rescue swap route</Eyebrow>
              <RouteComparison routes={s.routes} />
            </div>
          ) : null}
          <p className="text-[13px] text-muted">The real guardian plans with your sealed thresholds and strategy, which only the enclave can read.</p>
        </div>
      )}
    </Card>
  );
}

function RouteQuote() {
  const [amount, setAmount] = useState("10");
  const n = Number(amount);
  const q = useRescueQuote(Number.isFinite(n) && n > 0 ? n : null);
  return (
    <Card as="section" aria-labelledby="route-title" className="grid content-start gap-4">
      <CardHeader titleAs="h2" title={<span id="route-title">Rescue route</span>} description="Where a deleverage would sell collateral: Rhea's pool on chain, or NEAR Intents. The better quote is marked." />
      <AmountField label="Collateral to sell" unit="NEAR" value={amount} onChange={setAmount} error={amount !== "" && !(n > 0) ? "Enter an amount of NEAR." : null} />
      {q.isError && !q.data ? (
        <QueryError title="No quote right now" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <RouteComparison routes={q.data} />
      ) : (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton height="3.5rem" shape="block" />
          <Skeleton height="3.5rem" shape="block" />
        </div>
      )}
    </Card>
  );
}

function AccountProtect({ account, signer }: { account: string; signer: Signer }) {
  const mandate = useMandate(account);
  const summary = useAccountSummary(account);
  const contracts = useContracts();
  const tokens: Record<string, TokenInfo> = contracts.data
    ? { [contracts.data.usdc]: { symbol: "USDC", decimals: 6 }, [contracts.data.wnear]: { symbol: "wNEAR", decimals: 24 } }
    : {};
  return (
    <div className="grid gap-6" data-stagger>
      <MandatePanel view={mandate.data} loading={mandate.isPending} error={mandate.error} onRetry={() => void mandate.refetch()} signer={signer} tokens={tokens} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Simulation account={account} />
        <RouteQuote />
      </div>
      {contracts.isError ? (
        <QueryError title="The contract ids could not be loaded" error={contracts.error} onRetry={() => void contracts.refetch()} />
      ) : contracts.data && mandate.data !== undefined && !summary.isPending ? (
        <MandateBuilder
          key={`${account}-${mandate.data?.set_at ?? 0}`}
          account={account}
          signer={signer}
          current={mandate.data?.mandate ?? null}
          contracts={contracts.data}
          evmAddress={summary.data?.evmAddress ?? null}
        />
      ) : mandate.isError ? null : (
        <Skeleton height="20rem" shape="block" />
      )}
    </div>
  );
}

export function ProtectView() {
  return (
    <AccountGate title="Connect an account to protect it" description="A mandate tells the guardian what it may do for your position, within limits your account enforces.">
      {({ account, signer }) => <AccountProtect account={account} signer={signer} />}
    </AccountGate>
  );
}
