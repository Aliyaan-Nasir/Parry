"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ownerActions } from "@parryguard/sdk";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { Button } from "@/components/ui/Button";
import { chain } from "@/lib/parry";
import { useConfig } from "@/lib/queries";

/**
 * The factory creates every protected account on the code it was set up with; later releases are
 * published by hash and each owner moves their own account. When the selected account runs other
 * code than the published one, this offers the owner that move (one signature, nothing else changes).
 */
export function AccountUpdate() {
  const acct = useParryAccount();
  const config = useConfig();
  const target = config.data?.accountCode ?? null;
  const code = useQuery({
    queryKey: ["account-code", acct.account],
    queryFn: async () => (await chain()).accountCode(acct.account!),
    enabled: !!acct.account && !!target,
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  if (!acct.account || !target || !code.data || code.data === target) return null;
  const canAct = acct.signer === "wallet" || acct.signer === "passkey";

  const update = async () => {
    setBusy(true);
    try {
      await acct.runOwnerActions([ownerActions.upgrade(target)], { title: "Account updated" });
      await code.refetch();
    } catch {
      // runOwnerActions has already said what went wrong.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Account update" className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-brass/40 bg-brass-soft px-4 py-3.5">
      <div className="grid min-w-0 max-w-[68ch] gap-1">
        <p className="text-sm text-fg">An update for your protected account is ready.</p>
        <p className="text-[13px] leading-5 text-muted">
          It moves the account to the code Parry publishes now, including a fix that lets a rescue go ahead when the price moved while the guardian
          planned it. Your funds, positions and mandate stay exactly as they are.
        </p>
      </div>
      {canAct ? (
        <Button size="sm" loading={busy} loadingLabel="Updating" onClick={() => void update()}>
          Update account
        </Button>
      ) : (
        <span className="text-[13px] text-muted">The account&apos;s owner can update it.</span>
      )}
    </section>
  );
}
