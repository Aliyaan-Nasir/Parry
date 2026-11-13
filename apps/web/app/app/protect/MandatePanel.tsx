"use client";

import { useLayoutEffect, useState } from "react";
import { ownerActions, type MandateView } from "@parryguard/sdk";
import { DataList, DataRow, errorMessage, Eyebrow, Note, QueryError, Segmented } from "@/components/app/bits";
import { POWER_LABEL } from "@/components/app/labels";
import { mandateStatus } from "@/components/app/mandate";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { useEnclave } from "@/lib/queries";
import { formatBps, formatDateTime, formatNumber, fromUnits, unitsToNumber } from "@/lib/units";
import { useNow } from "@/lib/use-now";

export type TokenInfo = { symbol: string; decimals: number };

const PAUSES = [
  { value: 3600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 604_800, label: "7 days" },
] as const;

function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const fill = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}>
      <div className={fill >= 0.9 ? "h-full rounded-full bg-critical" : "h-full rounded-full bg-brass-fill"} style={{ width: `${fill * 100}%` }} />
    </div>
  );
}

function amountOf(pairs: [string, string][], token: string): string {
  return pairs.find(([t]) => t === token)?.[1] ?? "0";
}

/** The mandate in force, with its live counters, and the owner's pause and revoke. */
export function MandatePanel({
  view,
  loading,
  error,
  onRetry,
  signer,
  tokens,
}: {
  view: MandateView | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  signer: Signer;
  tokens: Record<string, TokenInfo>;
}) {
  const acct = useParryAccount();
  const enclave = useEnclave();
  const now = useNow();
  const [pauseFor, setPauseFor] = useState<number>(86_400);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useLayoutEffect(
    () => () => {
      setConfirm(false);
      setActionError(null);
    },
    [],
  );
  const canAct = signer !== "watch";

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (error && view === undefined) return <QueryError title="The mandate could not be read from the account" error={error} onRetry={onRetry} />;
  if (loading || view === undefined || now === null) {
    return (
      <Card className="grid content-start gap-3" aria-busy="true">
        <span className="sr-only">Loading the mandate</span>
        <Skeleton width="30%" height="1.4rem" />
        <Skeleton width="60%" />
        <Skeleton height="5rem" shape="block" />
      </Card>
    );
  }
  const nowSec = now / 1000;
  // A new enclave build has a new key: a mandate naming an earlier one is skipped by the guardian.
  const status = mandateStatus(view, nowSec, enclave.data?.key.public_key);
  const m = view?.mandate;
  const paused = status.key === "paused";
  const staleKey = status.key === "stale";

  return (
    <Card as="section" aria-labelledby="mandate-title" className="grid content-start gap-5">
      <CardHeader titleAs="h2" title={<span id="mandate-title">Current mandate</span>} description={status.detail} actions={<Badge tone={status.tone}>{status.label}</Badge>} />
      {staleKey ? (
        <Note tone="caution">
          This mandate names the guardian key of an earlier enclave build, so the guardian does not act on it. Set it again below: the form starts from your current
          limits.
        </Note>
      ) : null}
      {m && view ? (
        <>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <Eyebrow>Powers</Eyebrow>
              <ul className="flex flex-wrap gap-1.5">
                {m.powers.map((p) => (
                  <li key={p}>
                    <Badge tone="brass">{POWER_LABEL[p]?.label ?? p}</Badge>
                  </li>
                ))}
              </ul>
              <DataList className="mt-1">
                <DataRow label="Actions today">
                  <span className="num">
                    {view.actions_today} <span className="text-muted">of {m.max_actions_per_day}</span>
                  </span>
                </DataRow>
                <DataRow label="Health after a deleverage">
                  <span className="num">at least {formatNumber(m.min_health_after_bps / 10_000, 2)}</span>
                </DataRow>
                <DataRow label="Swap slippage">
                  <span className="num">at most {formatBps(m.max_slippage_bps)}</span>
                </DataRow>
                <DataRow label="Set">
                  <span className="text-[13px]">{formatDateTime(view.set_at)}</span>
                </DataRow>
                <DataRow label="Expires">
                  <span className="text-[13px]">{formatDateTime(m.expires_at)}</span>
                </DataRow>
                <DataRow label="Sealed policy">
                  {m.sealed ? <Badge tone="safe">Sealed to the enclave</Badge> : <span className="text-[13px] text-muted">None, the guardian uses its defaults</span>}
                </DataRow>
              </DataList>
            </div>
            <div className="grid content-start gap-3">
              <Eyebrow>Limits and what is used</Eyebrow>
              {m.limits.length === 0 ? (
                <p className="text-sm text-muted">No token limits: the guardian can only act on Hyperliquid or EVM within their guards.</p>
              ) : (
                <ul className="grid gap-4">
                  {m.limits.map((l) => {
                    const t = tokens[l.token] ?? { symbol: l.token, decimals: 0 };
                    const spent = amountOf(view.spent, l.token);
                    const today = amountOf(view.moved_today, l.token);
                    return (
                      <li key={l.token} className="grid gap-2">
                        <p className="text-sm font-semibold text-fg">{t.symbol}</p>
                        <div className="grid gap-1">
                          <div className="flex flex-wrap justify-between gap-2 text-[13px]">
                            <span className="text-muted">Reserve spent</span>
                            <span className="num text-fg">
                              {fromUnits(spent, t.decimals, 2)} <span className="text-muted">/ {fromUnits(l.reserve, t.decimals, 2)}</span>
                            </span>
                          </div>
                          <Meter used={unitsToNumber(spent, t.decimals)} total={unitsToNumber(l.reserve, t.decimals)} label={`${t.symbol} reserve spent`} />
                        </div>
                        <div className="grid gap-1">
                          <div className="flex flex-wrap justify-between gap-2 text-[13px]">
                            <span className="text-muted">Moved today</span>
                            <span className="num text-fg">
                              {fromUnits(today, t.decimals, 2)} <span className="text-muted">/ {fromUnits(l.daily, t.decimals, 2)}</span>
                            </span>
                          </div>
                          <Meter used={unitsToNumber(today, t.decimals)} total={unitsToNumber(l.daily, t.decimals)} label={`${t.symbol} moved today`} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {m.hl ? (
                <p className="text-[13px] text-muted">
                  Hyperliquid guard: {m.hl.asset} (index {m.hl.asset_index}), at most {fromUnits(m.hl.max_size_e8, 8, 2)} per order, within {formatBps(m.hl.band_bps)} of the mark.
                </p>
              ) : null}
              {m.evm ? (
                <p className="text-[13px] text-muted">
                  EVM guard: chain {m.evm.chain_id}, pool {m.evm.pool.slice(0, 10)}..., at most {m.evm.max_amount} units per repay.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 border-t border-line pt-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              {paused ? (
                <Button
                  variant="secondary"
                  disabled={!canAct}
                  loading={busy === "resume"}
                  loadingLabel="Resuming the guardian"
                  onClick={() => void run("resume", () => acct.runOwnerActions([ownerActions.pauseGuardian(0)], { title: "Guardian resumed" }))}
                >
                  Resume the guardian
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented label="Pause for" options={PAUSES} value={pauseFor as 3600 | 86_400 | 604_800} onChange={setPauseFor} />
                  <Button
                    variant="secondary"
                    disabled={!canAct}
                    loading={busy === "pause"}
                    loadingLabel="Pausing the guardian"
                    onClick={() =>
                      void run("pause", () => acct.runOwnerActions([ownerActions.pauseGuardian(Math.floor(Date.now() / 1000) + pauseFor)], { title: "Guardian paused" }))
                    }
                  >
                    Pause
                  </Button>
                </div>
              )}
              <Button variant="ghost" disabled={!canAct} className="text-critical" onClick={() => setConfirm(true)}>
                Revoke the mandate
              </Button>
            </div>
            {!canAct ? <p className="text-[13px] text-muted">Watching only: pausing and revoking need the owner&apos;s wallet or passkey.</p> : null}
            {actionError ? (
              <p role="alert" className="text-[13px] font-medium text-critical">
                {actionError}
              </p>
            ) : null}
          </div>

          <Modal
            open={confirm}
            onOpenChange={setConfirm}
            title="Revoke the mandate?"
            description="The guardian loses every power on this account at once. Your position stays as it is, without protection, until you set a new mandate."
            size="sm"
            footer={
              <>
                <Button variant="secondary" onClick={() => setConfirm(false)}>
                  Keep it
                </Button>
                <Button
                  loading={busy === "revoke"}
                  loadingLabel="Revoking"
                  onClick={() =>
                    void run("revoke", async () => {
                      await acct.runOwnerActions([ownerActions.revokeMandate()], { title: "Mandate revoked" });
                      setConfirm(false);
                    })
                  }
                >
                  Revoke
                </Button>
              </>
            }
          >
            {actionError ? (
              <p role="alert" className="text-[13px] font-medium text-critical">
                {actionError}
              </p>
            ) : null}
          </Modal>
        </>
      ) : (
        <p className="text-sm text-muted">Set one below: choose what the guardian may do, its limits, and when it should act.</p>
      )}
    </Card>
  );
}
