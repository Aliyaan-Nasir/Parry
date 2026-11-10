"use client";

import { useMutation } from "@tanstack/react-query";
import { useId, useLayoutEffect, useState, type FormEvent } from "react";
import { DataList, DataRow, ExternalLink, QueryError } from "./bits";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { api } from "@/lib/parry";
import { shortId } from "@/lib/units";

const NEAR_AI_VERIFY = "https://cloud.near.ai/verify";

/**
 * The risk copilot: a NEAR AI Cloud verifiable model explains the position in plain words. The
 * model runs in a TEE and signs its answer; the API checks the signature covers this exchange.
 */
export function Copilot({ account, positionId }: { account: string; positionId: string }) {
  const [question, setQuestion] = useState("");
  const inputId = useId();
  const ask = useMutation({ mutationFn: (q: string) => api.copilot({ account, positionId, ...(q ? { question: q } : {}) }) });
  const { reset } = ask;
  useLayoutEffect(() => () => reset(), [reset]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask.mutate(question.trim());
  };

  const a = ask.data;
  return (
    <Card as="section" aria-labelledby="copilot-title" className="grid content-start gap-5">
      <CardHeader
        titleAs="h2"
        title={<span id="copilot-title">Risk copilot</span>}
        description="A verifiable model on NEAR AI Cloud explains this position's risk in plain words, from the numbers above. It is an explanation, not advice."
      />
      <form onSubmit={onSubmit} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <label htmlFor={inputId} className="text-sm font-semibold text-fg">
            Your question <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id={inputId}
            value={question}
            maxLength={300}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How at risk is this position?"
            className="h-10 min-w-0 rounded-lg border border-line-strong bg-raised px-3 text-sm text-fg placeholder:text-muted"
          />
        </div>
        <Button type="submit" loading={ask.isPending} loadingLabel="Asking the model">
          Explain
        </Button>
      </form>

      {ask.isError ? <QueryError title="The copilot could not answer" error={ask.error} /> : null}

      {a ? (
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5" aria-live="polite">
          <p className="whitespace-pre-line text-[15px] leading-7 text-fg">{a.answer}</p>
          <DataList className="border-t border-line">
            <DataRow label="Model">
              <span className="num text-[13px]">{a.model}</span>
            </DataRow>
            <DataRow label="Signature">
              {a.verified ? (
                <Badge tone="safe">
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                    <path d="M2.5 6.3 L4.9 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Verified
                </Badge>
              ) : (
                <Badge tone="caution">Not verified</Badge>
              )}
            </DataRow>
            {a.signingAddress ? (
              <DataRow label="Signing address">
                <span className="num text-[13px]" title={a.signingAddress}>
                  {shortId(a.signingAddress, 10, 8)}
                </span>
              </DataRow>
            ) : null}
            <DataRow label="Chat id">
              <span className="num text-[13px]" title={a.chatId}>
                {shortId(a.chatId, 10, 6)}
              </span>
            </DataRow>
          </DataList>
          <p className="text-[13px] leading-5 text-muted">
            {a.verified
              ? "The model's TEE signed this answer, and the signature covers exactly this question and answer. "
              : "The signature for this answer could not be checked yet, so treat it as unverified. "}
            <ExternalLink href={a.verifyUrl.startsWith("https://cloud.near.ai/") ? a.verifyUrl : NEAR_AI_VERIFY}>Check the model on NEAR AI</ExternalLink>
          </p>
        </div>
      ) : null}
    </Card>
  );
}
