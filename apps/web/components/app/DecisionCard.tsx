"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useLayoutEffect, type ReactNode } from "react";
import { verifyDecision, type Decision, type DecisionCheck, type DecisionVerification } from "@parry/sdk";
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

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </div>
  );
}

/** What the rescue route earned against the other quote, in dollars (null without both quotes). */
export function routeSaving(routes: Decision["routes"]): number | null {
  if (!routes || !routes.rhea || "unavailable" in routes.intents) return null;
  const chosen = routes.chosen === "rhea" ? routes.rhea.outUsd : routes.intents.outUsd;
  const other = routes.chosen === "rhea" ? routes.intents.outUsd : routes.rhea.outUsd;
  return chosen - other;
}

/** One guardian decision as a dense row that opens into its full record. */
export function DecisionRow({ decision, open, onToggle }: { decision: Decision; open: boolean; onToggle: () => void }) {
  const { format } = useMoney();
  const outcome = OUTCOME[decision.outcome] ?? { label: decision.outcome, tone: "neutral" as const };
  const before = decision.healthBefore ?? decision.trigger.healthBps / 10_000;
  const saving = routeSaving(decision.routes);
  const tone = outcome.tone === "safe" ? "text-fg" : outcome.tone === "neutral" ? "text-muted" : "text-critical";
  return (
    <article id={`d-${decision.id}`} aria-labelledby={`decision-${decision.id}`} className={cn("scroll-mt-24 border-b border-line last:border-0", open && "bg-fg/[0.02]")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="grid w-full grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors duration-[var(--dur-1)] hover:bg-hover sm:grid-cols-[5.5rem_minmax(0,1fr)_7rem_8rem_7rem]">
        <span className="text-[12.5px] text-muted">
          <TimeAgo iso={decision.createdAt} />
        </span>
        <span className="min-w-0">
          <h2 id={`decision-${decision.id}`} className="truncate text-sm text-fg">
            {ACTION_LABEL[decision.action] ?? decision.action}
            <span className="text-muted"> on {VENUE_LABEL[decision.venue] ?? decision.venue}</span>
          </h2>
          <span className="num block truncate text-[12px] text-muted" title={decision.account}>
            {shortId(decision.account, 8, 6)}
          </span>
        </span>
        <span className="num hidden text-[13px] text-fg sm:block">
          {formatHealth(before)}
          <span className="text-muted"> to </span>
          {decision.healthAfter !== null ? formatHealth(decision.healthAfter) : <span className="text-muted">n/a</span>}
        </span>
        <span className="num hidden text-right text-[13px] text-muted sm:block">{saving !== null && saving > 0 ? <span className="text-fg">+{format(saving)} route</span> : ""}</span>
        <span className={cn("text-right text-[13px]", tone)}>{outcome.label}</span>
      </button>
      {open ? (
        <div className="grid gap-5 px-4 pb-6 pt-2">
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
  const outcome = OUTCOME[decision.outcome] ?? { label: decision.outcome, tone: "neutral" as const };
  const r = decision.review;
  const evmBase = config.data?.explorers.evm ?? (network === "testnet" ? "https://sepolia.basescan.org" : "https://basescan.org");
  const evmHref = decision.txs.evm && /^0x[0-9a-fA-F]{64}$/.test(decision.txs.evm) ? `${evmBase.replace(/\/+$/, "")}/tx/${decision.txs.evm}` : null;
  const evmChain = network === "testnet" ? "Base Sepolia" : "Base";
  const verifyHref = decision.txs.evmVerify ? explorerUrl("nearblocks", decision.txs.evmVerify) : null;
  const detail = (decision as Decision & { detail?: string | null }).detail;
  const { format } = useMoney();

  return (
    <>
      <div className="grid gap-5 md:grid-cols-2">
        <Block title="Trigger">
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={decision.trigger.tier} score={decision.trigger.score} />
            <span className="num text-[13px] text-muted">health {formatHealth(decision.trigger.healthBps / 10_000)}</span>
          </div>
        </Block>
        <Block title="Health">
          <p className="num text-sm text-fg">
            {/* Unmeasured is not "no debt": a decision may predate the reading. The trigger's health stands in. */}
            {decision.healthBefore !== null ? formatHealth(decision.healthBefore) : formatHealth(decision.trigger.healthBps / 10_000)}
            <span aria-hidden="true" className="text-muted">
              {" "}
              →{" "}
            </span>
            <span className="sr-only"> before, </span>
            {decision.healthAfter !== null ? formatHealth(decision.healthAfter) : <span className="text-muted">not measured</span>}
            <span className="sr-only"> after</span>
          </p>
        </Block>
        <div className="md:col-span-2">
          <Block title="Plan">
            <p className="text-sm leading-6 text-fg">{decision.plan}</p>
            {detail ? <p className="text-[13px] leading-5 text-muted">{detail}</p> : null}
          </Block>
        </div>
        {decision.explanation ? (
          <div className="md:col-span-2">
            <Block title="Why this step">
              <p className="text-sm leading-6 text-fg">{decision.explanation.why}</p>
              {decision.explanation.skipped.length ? (
                <ul className="grid gap-1 text-[13px] leading-5 text-muted">
                  {decision.explanation.skipped.map((k) => (
                    <li key={k.step}>
                      Skipped {(ACTION_LABEL[k.step] ?? k.step).toLowerCase()}: {k.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Block>
          </div>
        ) : null}
      </div>
      <p className="text-[13px] text-muted">
        <span className="num" title={decision.account}>
          {decision.account}
        </span>
        , <span className="text-fg">{outcome.label.toLowerCase()}</span>, decision{" "}
        <Link href={`/verify?id=${decision.id}`} className="num text-brass hover:underline">
          {shortId(decision.id, 8, 6)}
        </Link>
      </p>

      <section aria-label="AI review" className="grid gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Eyebrow>AI review</Eyebrow>
          <Badge tone={r.verdict === "approve" ? "safe" : "critical"}>{r.verdict === "approve" ? "Approved" : "Rejected"}</Badge>
        </div>
        <p className="text-sm leading-6 text-fg">{r.reasoning}</p>
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
        <p className="text-[13px] text-muted">
          The model runs in a TEE on NEAR AI Cloud; its signing address is attested there.{" "}
          <ExternalLink href={NEAR_AI_VERIFY}>Attestation on NEAR AI</ExternalLink>
        </p>
      </section>

      {decision.txs.action || decision.txs.record || decision.txs.hyperliquid || evmHref || decision.txs.evmVerified ? (
        <Block title="Transactions">
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
            <div className="flex flex-wrap items-center gap-2 pt-1">
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
        </Block>
      ) : null}

      {decision.routes ? (
        <Block title="Route comparison">
          <RouteComparison routes={decision.routes} />
          {routeSaving(decision.routes) !== null ? (
            <p className="text-[13px] text-muted">
              {routeSaving(decision.routes)! > 0 ? (
                <>
                  The chosen route paid <span className="num text-fg">{format(routeSaving(decision.routes)!)}</span> more than the other quote.
                </>
              ) : (
                "The chosen route paid no more than the other quote: on testnet the account settles on the Rhea pool whatever the quotes say."
              )}
            </p>
          ) : null}
        </Block>
      ) : null}

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" loading={verify.isPending} loadingLabel="Verifying" onClick={() => verify.mutate()}>
            {verify.data ? "Verify again" : "Verify"}
          </Button>
          <span className="text-[13px] text-muted">Recomputes the hashes and signatures here, trusting nothing from the API.</span>
        </div>
        {verify.isError ? <QueryError title="Verification could not run" error={verify.error} /> : null}
        {verify.data ? <Verification result={verify.data} /> : null}
      </div>
    </>
  );
}
