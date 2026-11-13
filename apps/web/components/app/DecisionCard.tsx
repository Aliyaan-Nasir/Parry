"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useLayoutEffect, type ReactNode } from "react";
import { verifyDecision, type Decision, type DecisionCheck, type DecisionVerification } from "@parryguard/sdk";
import { CopyButton, DataList, DataRow, Eyebrow, ExternalLink, QueryError } from "./bits";
import { TimeAgo } from "./Feeds";
import { ACTION_LABEL, OUTCOME } from "./labels";
import { VENUE_LABEL } from "./PositionsTable";
import { RouteComparison } from "./RouteComparison";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useMoney } from "@/components/providers/MoneyProvider";
import { TierBadge } from "@/components/ui/TierBadge";
import { explorerLabel, explorerUrl, type ExplorerKind } from "@/lib/explorer";
import { chain } from "@/lib/parry";
import { useConfig } from "@/lib/queries";
import { formatHealth, shortId } from "@/lib/units";
import { network } from "@/lib/env";
import { cn } from "@/lib/cn";

const NEAR_AI_VERIFY = "https://cloud.near.ai/verify";

const CHECK_LABEL: Record<DecisionCheck["name"], string> = {
  review_hash: "Review hash matches the review",
  signed_exchange: "The model's signature covers this exchange",
  model_signature: "Signed by the model's attested address",
  envelope_signature: "Envelope signed by the enclave key",
  envelope_review_hash: "Envelope carries this review",
  decision_id: "Decision id is the envelope's hash",
};

type Result = DecisionVerification & { keyNote: string | null };

/** Recomputes every check in this browser, with the enclave key read from the risk board on chain. */
async function verifyHere(decision: Decision): Promise<Result> {
  try {
    const c = await chain();
    return { ...(await c.verifyDecision(decision)), keyNote: null };
  } catch {
    return { ...verifyDecision(decision, { enclavePublicKey: null }), keyNote: "The enclave key could not be read from the risk board, so the envelope signature was not checked." };
  }
}

function CheckIcon({ status }: { status: DecisionCheck["status"] }) {
  if (status === "pass") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0 text-safe">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4.8 8.3 L7 10.4 L11.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "fail") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0 text-critical">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0 text-muted">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.5 2" />
      <path d="M5 8 H11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const STATUS_WORD = { pass: "Pass", fail: "Fail", skip: "Skipped" } as const;

function Verification({ result }: { result: Result }) {
  const passed = result.checks.filter((c) => c.status === "pass").length;
  return (
    <div className="grid gap-3 rounded-xl border border-line bg-surface p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-fg">{result.ok ? "Verified in this browser" : "Verification failed"}</p>
        <Badge tone={result.ok ? "safe" : "critical"}>
          {passed} of {result.checks.length} checks pass
        </Badge>
      </div>
      <ul className="grid gap-2.5">
        {result.checks.map((c) => (
          <li key={c.name} className="flex gap-2.5">
            <CheckIcon status={c.status} />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-fg">
                <span className="sr-only">{STATUS_WORD[c.status]}: </span>
                {CHECK_LABEL[c.name] ?? c.name}
                <span className={cn("ml-2 text-xs font-semibold", c.status === "pass" ? "text-safe" : c.status === "fail" ? "text-critical" : "text-muted")} aria-hidden="true">
                  {STATUS_WORD[c.status]}
                </span>
              </p>
              <p className="break-all text-[12px] leading-5 text-muted">{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      {result.keyNote ? <p className="text-[13px] text-muted">{result.keyNote}</p> : null}
    </div>
  );
}

function TxLink({ kind, hash, label }: { kind: ExplorerKind; hash: string; label: string }) {
  const href = explorerUrl(kind, hash);
  if (!href) return <span className="num text-[13px] text-muted">{shortId(hash, 8, 6)}</span>;
  return (
    <ExternalLink href={href} className="text-[13px]">
      {label} on {explorerLabel(kind)}
    </ExternalLink>
  );
}

/** A bordered panel: the record's sections read as separate pieces, not one wall of text. */
function Panel({ title, aside, children, label }: { title: string; aside?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>{title}</Eyebrow>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The outcome's mark: a check, a cross, a turn back, a stop, or a dashed ring while pending. */
function OutcomeIcon({ outcome }: { outcome: Decision["outcome"] }) {
  const common = { viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": true as const, className: "shrink-0" };
  if (outcome === "executed")
    return (
      <svg {...common} className="shrink-0 text-safe">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4.8 8.3 L7 10.4 L11.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (outcome === "rejected_by_review")
    return (
      <svg {...common} className="shrink-0 text-critical">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  if (outcome === "rolled_back")
    return (
      <svg {...common} className="shrink-0 text-muted">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.6 10.2 A3.2 3.2 0 1 0 6.4 5.4 M6.4 5.4 H8.6 M6.4 5.4 V7.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (outcome === "refused")
    return (
      <svg {...common} className="shrink-0 text-muted">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5 11 L11 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common} className="shrink-0 text-muted">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.5 2" />
    </svg>
  );
}

function OutcomeLabel({ decision, className }: { decision: Decision; className?: string }) {
  const outcome = OUTCOME[decision.outcome] ?? { label: decision.outcome, tone: "neutral" as const };
  const tone = outcome.tone === "critical" ? "text-critical" : outcome.tone === "neutral" ? "text-muted" : "text-fg";
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", tone, className)}>
      <OutcomeIcon outcome={decision.outcome} />
      {outcome.label}
    </span>
  );
}

/** Health before the decision, from its own reading, else the trigger's (a decision may predate the reading). */
function healthBefore(decision: Decision): number | null {
  if (decision.healthBefore !== null && decision.healthBefore !== undefined) return decision.healthBefore;
  const bps = decision.trigger?.healthBps;
  return typeof bps === "number" && Number.isFinite(bps) ? bps / 10_000 : null;
}

/** "1.04 → 1.40", or "1.08 unchanged" when the decision did not move it. */
function HealthChange({ decision }: { decision: Decision }) {
  const before = healthBefore(decision);
  const after = decision.healthAfter;
  if (before === null) return <span className="text-muted">not measured</span>;
  const moved = after !== null && Math.abs(after - before) >= 0.005;
  return (
    <span className="num inline-flex items-center gap-1.5 whitespace-nowrap">
      {formatHealth(before)}
      {after === null ? (
        <span className="font-sans text-muted">, after not measured</span>
      ) : moved ? (
        <>
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <span className="sr-only"> to </span>
          {formatHealth(after)}
        </>
      ) : (
        <span className="font-sans text-muted">unchanged</span>
      )}
    </span>
  );
}

/** The route the rescue's swap took, or that it needed none. */
function RouteCell({ decision }: { decision: Decision }) {
  const { format } = useMoney();
  const routes = decision.routes;
  if (!routes) return <span className="text-muted">No swap</span>;
  const saving = routeSaving(routes);
  return (
    <span className="inline-flex flex-col items-end leading-5">
      <span className="text-fg">{routes.chosen === "rhea" ? "Rhea pool" : "NEAR Intents"}</span>
      {saving !== null && saving > 0 ? <span className="num text-[12px] text-muted">+{format(saving)} vs the other quote</span> : null}
    </span>
  );
}

/** The columns of the log's header and of every row, shared so values sit under their headings. */
export const DECISION_GRID = "sm:grid-cols-[6rem_minmax(0,1fr)_9.5rem_9rem_11rem_1rem]";

/** What the rescue route earned against the other quote, in dollars (null without both quotes). */
export function routeSaving(routes: Decision["routes"]): number | null {
  if (!routes || !routes.rhea || "unavailable" in routes.intents) return null;
  const chosen = routes.chosen === "rhea" ? routes.rhea.outUsd : routes.intents.outUsd;
  const other = routes.chosen === "rhea" ? routes.intents.outUsd : routes.rhea.outUsd;
  return chosen - other;
}

/** One guardian decision as a dense row that opens into its full record. */
export function DecisionRow({ decision, open, onToggle }: { decision: Decision; open: boolean; onToggle: () => void }) {
  return (
    <article
      id={`d-${decision.id}`}
      aria-labelledby={`decision-${decision.id}`}
      className={cn(
        "relative scroll-mt-24 border-b border-line last:border-0",
        // The open record is marked by a brass rule down its left edge.
        open && "bg-fg/[0.025] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brass",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "grid w-full grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left transition-colors duration-[var(--dur-1)] hover:bg-hover sm:px-5",
          DECISION_GRID,
        )}
      >
        <TimeAgo iso={decision.createdAt} className="text-[12.5px]" />
        <span className="min-w-0">
          <h2 id={`decision-${decision.id}`} className="truncate text-sm text-fg">
            {ACTION_LABEL[decision.action] ?? decision.action}
            <span className="text-muted"> on {VENUE_LABEL[decision.venue] ?? decision.venue}</span>
          </h2>
          <span className="num block truncate text-[12px] text-muted" title={decision.account}>
            {shortId(decision.account, 8, 6)}
          </span>
        </span>
        <span className="hidden text-[13px] text-fg sm:block">
          <HealthChange decision={decision} />
        </span>
        <span className="hidden text-right text-[13px] sm:block">
          <RouteCell decision={decision} />
        </span>
        <span className="flex justify-end text-[13px]">
          <OutcomeLabel decision={decision} />
        </span>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className={cn("hidden justify-self-end text-muted transition-transform duration-[var(--dur-1)] sm:block", open && "rotate-180")}>
          <path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="grid gap-4 px-4 pb-6 pt-1 sm:px-5">
          <DecisionDetail decision={decision} />
        </div>
      ) : null}
    </article>
  );
}

/** One guardian decision in full: trigger, plan, why this step, the AI review, transactions, the route and checks. */
export function DecisionDetail({ decision }: { decision: Decision }) {
  const config = useConfig();
  const verify = useMutation({ mutationFn: () => verifyHere(decision) });
  const { reset } = verify;
  useLayoutEffect(() => () => reset(), [reset]);
  const r = decision.review;
  const evmBase = config.data?.explorers.evm ?? (network === "testnet" ? "https://sepolia.basescan.org" : "https://basescan.org");
  const evmHref = decision.txs.evm && /^0x[0-9a-fA-F]{64}$/.test(decision.txs.evm) ? `${evmBase.replace(/\/+$/, "")}/tx/${decision.txs.evm}` : null;
  const evmChain = network === "testnet" ? "Base Sepolia" : "Base";
  const verifyHref = decision.txs.evmVerify ? explorerUrl("nearblocks", decision.txs.evmVerify) : null;
  const detail = (decision as Decision & { detail?: string | null }).detail;
  const { format } = useMoney();

  const reason = decision.outcome !== "executed" ? detail : null;
  // The guardian's plan ends with its reason, which "Why this step" already shows: say it once.
  const why = decision.explanation?.why.trim();
  const plan = why && decision.plan.trim().endsWith(why) && decision.plan.trim() !== why ? decision.plan.trim().slice(0, -why.length).trim() : decision.plan;
  const before = healthBefore(decision);
  const delta = before !== null && decision.healthAfter !== null ? decision.healthAfter - before : null;
  const hasTrigger = typeof decision.trigger?.score === "number" && !!decision.trigger.tier;
  const cell = "grid content-start gap-1.5 p-4";

  return (
    <>
      {/* The record at a glance: what set it off, what it did to health, how it ended, and its ids. */}
      <dl className="grid overflow-hidden rounded-xl border border-line bg-surface sm:grid-cols-2 sm:divide-x sm:divide-line lg:grid-cols-4 [&>div]:border-line max-sm:divide-y max-sm:divide-line lg:[&>div:nth-child(3)]:border-l sm:max-lg:[&>div:nth-child(n+3)]:border-t">
        <div className={cell}>
          <dt className="label">Trigger</dt>
          <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {hasTrigger ? (
              <>
                <TierBadge tier={decision.trigger.tier} score={decision.trigger.score} size="md" />
                {typeof decision.trigger.healthBps === "number" ? <span className="num text-muted">at health {formatHealth(decision.trigger.healthBps / 10_000)}</span> : null}
              </>
            ) : (
              <span className="text-muted">Not recorded with this decision</span>
            )}
          </dd>
        </div>
        <div className={cell}>
          <dt className="label">Health</dt>
          <dd className="grid gap-0.5">
            <span className="text-base text-fg">
              <HealthChange decision={decision} />
            </span>
            {delta !== null && Math.abs(delta) >= 0.005 ? (
              <span className={cn("num text-[12px]", delta > 0 ? "text-safe" : "text-critical")}>
                {delta > 0 ? "+" : ""}
                {delta.toFixed(2)}
              </span>
            ) : null}
          </dd>
        </div>
        <div className={cell}>
          <dt className="label">Outcome</dt>
          <dd className="grid gap-1 text-sm">
            <OutcomeLabel decision={decision} />
            {reason ? <span className="text-[12.5px] leading-5 text-muted">{reason}</span> : null}
          </dd>
        </div>
        <div className={cell}>
          <dt className="label">Decision</dt>
          <dd className="grid gap-1 text-[13px]">
            <Link href={`/verify?id=${decision.id}`} className="num w-fit text-brass hover:underline">
              {shortId(decision.id, 8, 6)}
            </Link>
            <span className="flex min-w-0 items-center gap-1">
              <span className="num truncate text-muted" title={decision.account}>
                {shortId(decision.account, 10, 6)}
              </span>
              <CopyButton value={decision.account} label="account id" className="-my-1" />
            </span>
          </dd>
        </div>
      </dl>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Panel title="Plan">
            <p className="max-w-[72ch] text-sm leading-6 text-fg">{plan}</p>
            {detail && !reason ? <p className="max-w-[72ch] text-[13px] leading-5 text-muted">{detail}</p> : null}
            {decision.explanation ? (
              <div className="grid gap-2 border-t border-line pt-3">
                <Eyebrow>Why this step</Eyebrow>
                <p className="max-w-[72ch] text-sm leading-6 text-fg">{decision.explanation.why}</p>
                {decision.explanation.skipped.length ? (
                  <ul className="grid max-w-[72ch] gap-1.5 text-[13px] leading-5 text-muted">
                    {decision.explanation.skipped.map((k) => (
                      <li key={k.step} className="flex gap-2">
                        <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted/60" />
                        <span>
                          Skipped {(ACTION_LABEL[k.step] ?? k.step).toLowerCase()}: {k.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Panel>

          {decision.txs.action || decision.txs.record || decision.txs.hyperliquid || evmHref || decision.txs.evmVerified ? (
            <Panel title="Transactions">
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {decision.txs.action ? (
                  <li>
                    <TxLink kind="nearblocks" hash={decision.txs.action} label="Action" />
                  </li>
                ) : null}
                {decision.txs.record ? (
                  <li>
                    <TxLink kind="nearblocks" hash={decision.txs.record} label="Record" />
                  </li>
                ) : null}
                {decision.txs.hyperliquid ? (
                  <li>
                    <TxLink kind="hyperliquid" hash={decision.txs.hyperliquid} label="Order" />
                  </li>
                ) : null}
                {evmHref ? (
                  <li>
                    <ExternalLink href={evmHref} className="text-[13px]">
                      {decision.action === "evm_approve" ? "Approval" : "Repay"} on {evmChain}
                    </ExternalLink>
                  </li>
                ) : null}
              </ul>
              {decision.txs.evmVerified ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  {decision.txs.evmVerified === "verified" ? (
                    <Badge tone="safe">
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                        <path d="M2.5 6.3 L4.9 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Verified by the NEAR MPC network
                    </Badge>
                  ) : (
                    <Badge tone="critical">MPC network verification failed</Badge>
                  )}
                  {verifyHref ? (
                    <ExternalLink href={verifyHref} className="text-[13px]">
                      Verification on NearBlocks
                    </ExternalLink>
                  ) : null}
                </div>
              ) : null}
            </Panel>
          ) : null}

          {decision.routes ? (
            <Panel title="Route comparison">
              <RouteComparison routes={decision.routes} />
              {routeSaving(decision.routes) !== null ? (
                <p className="max-w-[72ch] text-[13px] leading-5 text-muted">
                  {routeSaving(decision.routes)! > 0 ? (
                    <>
                      The chosen route paid <span className="num text-fg">{format(routeSaving(decision.routes)!)}</span> more than the other quote.
                    </>
                  ) : (
                    "The chosen route paid no more than the other quote: on testnet the account settles on the Rhea pool whatever the quotes say."
                  )}
                </p>
              ) : null}
            </Panel>
          ) : null}
        </div>

        <div className="grid content-start gap-4">
          <Panel title="AI review" aside={<Badge tone={r.verdict === "approve" ? "safe" : "critical"}>{r.verdict === "approve" ? "Approved" : "Rejected"}</Badge>}>
            <p className="max-w-[72ch] text-sm leading-6 text-fg">{r.reasoning}</p>
            <DataList className="border-t border-line">
              <DataRow label="Model">
                <span className="num text-[13px]">{r.model}</span>
              </DataRow>
              <DataRow label="Signing address">
                <span className="flex flex-wrap items-center justify-end gap-1">
                  <span className="num text-[13px]" title={r.signingAddress}>
                    {shortId(r.signingAddress, 10, 8)}
                  </span>
                  <CopyButton value={r.signingAddress} label="signing address" className="-my-1" />
                </span>
              </DataRow>
              <DataRow label="Review hash">
                <span className="num text-[13px]" title={r.reviewHash}>
                  {r.reviewHash ? shortId(r.reviewHash, 10, 8) : "none"}
                </span>
              </DataRow>
            </DataList>
            <p className="text-[13px] leading-5 text-muted">
              The model runs in a TEE on NEAR AI Cloud; its signing address is attested there.{" "}
              <ExternalLink href={NEAR_AI_VERIFY}>Attestation on NEAR AI</ExternalLink>
            </p>
          </Panel>

          <Panel title="Check it yourself">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" loading={verify.isPending} loadingLabel="Verifying" onClick={() => verify.mutate()}>
                {verify.data ? "Verify again" : "Verify"}
              </Button>
              <span className="text-[13px] leading-5 text-muted">Recomputes the hashes and signatures here, trusting nothing from the API.</span>
            </div>
            {verify.isError ? <QueryError title="Verification could not run" error={verify.error} /> : null}
            {verify.data ? <Verification result={verify.data} /> : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
