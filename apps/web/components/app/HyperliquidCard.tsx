"use client";

import { marginAmount, ownerActions } from "@parryguard/sdk";
import { useState } from "react";
import { DataList, DataRow, errorMessage, ExternalLink, Note } from "@/components/app/bits";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { hyperliquidAddressUrl } from "@/lib/explorer";
import { sendToHyperliquid, useHyperliquidBalances } from "@/lib/hyperliquid";
import { shortId } from "@/lib/units";

/**
 * The protected account's own Hyperliquid address, once it holds USDC. Orders trade from Perps
 * margin only, and USDC sent from a Unified Hyperliquid account lands in Spot, so the owner can
 * move it across: the account signs a Spot-to-Perps transfer that names no destination.
 */
export function HyperliquidCard({ account, address }: { account: string; address: string }) {
  const acct = useParryAccount();
  const { toast } = useToast();
  const { format } = useMoney();
  const q = useHyperliquidBalances(account, address);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const b = q.data;
  if (!b || (b.perps <= 0 && b.spotUsdc <= 0)) return null;
  const amount = marginAmount(b.spotUsdc);
  const url = hyperliquidAddressUrl(address);

  const move = async () => {
    if (!amount) return;
    setBusy(true);
    setError(null);
    try {
      const action = ownerActions.hlMarginToPerp(amount, Date.now());
      const { txHash, value } = await acct.runOwnerActionsForValue([action]);
      try {
        await sendToHyperliquid(action, value);
      } catch (e) {
        throw new Error(`The account signed the transfer (transaction ${txHash}), but ${errorMessage(e)}`);
      }
      toast({ title: `${amount} USDC moved to Perps`, tone: "success", explorer: { kind: "nearblocks", hash: txHash } });
      await q.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" aria-labelledby="hyperliquid-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="hyperliquid-title">Hyperliquid</span>}
        description="The account's own Hyperliquid address. Only this account can sign for it, through Chain Signatures."
        actions={url ? <ExternalLink href={url}>Explorer</ExternalLink> : null}
      />
      <DataList>
        <DataRow label="Address">
          <span className="num" title={address}>
            {shortId(address)}
          </span>
        </DataRow>
        <DataRow label="Perps margin" hint="What orders and the guardian trade with">
          <span className="num">{format(b.perps)}</span>
        </DataRow>
        <DataRow label="Spot USDC" hint="Not usable for orders until it moves to Perps">
          <span className="num">{format(b.spotUsdc)}</span>
        </DataRow>
      </DataList>
      {amount ? (
        <div className="grid gap-3">
          <Note tone="brass">USDC sent from a Unified Hyperliquid account lands in Spot. Moving it to Perps signs a transfer between the two balances of this one address, so it cannot send funds anywhere else.</Note>
          <div className="flex flex-wrap items-center gap-3">
            <Button loading={busy} loadingLabel="Signing" onClick={() => void move()} disabled={acct.signer === "watch"}>
              Move {amount} USDC to Perps
            </Button>
            {acct.signer === "watch" ? <span className="text-[13px] text-muted">Connect the owner to move it.</span> : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-critical">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
