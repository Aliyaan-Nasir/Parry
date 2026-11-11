"use client";

import { closeFromWalletActions, closePerpAction, closeRheaAction, unwindAction, type AccountSummary, type Position } from "@parry/sdk";
import { useState } from "react";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useConfig, useMarket } from "@/lib/queries";
import { cn } from "@/lib/cn";

const HL_API = process.env.NEXT_PUBLIC_HYPERLIQUID_API ?? "https://api.hyperliquid-testnet.xyz";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reads the account's perp position on Hyperliquid (size and mark) for the close order. */
async function hlPosition(address: string, coin: string): Promise<{ size: number; mark: number; assetIndex: number; szDecimals: number } | null> {
  const post = (body: unknown) => fetch(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const [state, meta, mids] = (await Promise.all([post({ type: "clearinghouseState", user: address }), post({ type: "meta" }), post({ type: "allMids" })])) as [
    { assetPositions?: { position: { coin: string; szi: string } }[] },
    { universe: { name: string; szDecimals: number }[] },
    Record<string, string>,
  ];
  const p = state.assetPositions?.find((a) => a.position.coin === coin)?.position;
  const assetIndex = meta.universe.findIndex((u) => u.name === coin);
  if (!p || assetIndex < 0) return null;
  return { size: Number(p.szi), mark: Number(mids[coin]), assetIndex, szDecimals: meta.universe[assetIndex]!.szDecimals };
}

/**
 * Closing a position in one flow, and unwinding the whole protected account. Rhea closes all or
 * nothing: either the account sells just enough collateral through the exchange to repay the
 * whole debt, or the owner sends the debt token from the wallet and the account repays and
 * withdraws. The Hyperliquid perp closes with a reduce-only order signed through Chain Signatures.
 */
export function CloseFlow({ summary, position, open, onOpenChange, mode }: { summary: AccountSummary; position: Position | null; open: boolean; onOpenChange: (v: boolean) => void; mode: "close" | "unwind" }) {
  const acct = useParryAccount();
  const config = useConfig();
  const market = useMarket();
  const [how, setHow] = useState<"sell" | "wallet">("sell");
  const [slippage, setSlippage] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ids = config.data?.contracts as Record<string, string> | undefined;
  const isWallet = acct.signer === "wallet";
  const rhea = position?.venue === "rhea";

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setDone(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const closeRhea = () =>
    run(async () => {
      if (how === "sell") {
        const poolId = (config.data as { dexPool?: number | null } | undefined)?.dexPool;
        if (!poolId) throw new Error("The exchange pool is still loading.");
        return acct.runOwnerActions([closeRheaAction({ slippageBps: slippage, poolId })], { title: "Closing round sent" });
      }
      if (!ids?.usdc || !ids.wnear || !position) throw new Error("The contract ids are still loading.");
      // The debt in USDC units (6 decimals), with a small margin for interest that accrues meanwhile.
      const debt = BigInt(Math.ceil(position.debtUsd * 1.002 * 1e6));
      const price = market.data?.near.priceUsd;
      if (!price) throw new Error("The NEAR price is still loading.");
      // All the collateral in wNEAR units (24 decimals), less a hair so the withdraw never asks for more than there is.
      const collateral = BigInt(Math.floor((position.collateralUsd / price) * 0.999 * 1e6)) * 10n ** 18n;
      const flow = closeFromWalletActions({ account: summary.account, debtToken: ids.usdc, debtAmount: debt, collateralToken: ids.wnear, collateralAmount: collateral });
      await acct.sendFromWallet(flow.transfer);
      return acct.runOwnerActions(flow.actions, { title: "Debt repaid, collateral withdrawn" });
    });

  const closePerp = () =>
    run(async () => {
      const p = await hlPosition(summary.hyperliquidAddress, "NEAR");
      if (!p || p.size === 0) throw new Error("There is no NEAR perp position to close on Hyperliquid.");
      return acct.runOwnerActions([closePerpAction({ assetIndex: p.assetIndex, size: p.size, markPrice: p.mark, szDecimals: p.szDecimals, slippageBps: slippage })], { title: "Close order signed" });
    });

  const unwind = () =>
    run(async () => {
      if (!ids) throw new Error("The contract ids are still loading.");
      const tokens = [ids.usdc, ids.wnear].filter(Boolean) as string[];
      const to = summary.owner.kind === "near" ? undefined : acct.wallet?.accountId;
      if (summary.owner.kind !== "near" && !to) throw new Error("A passkey account needs a NEAR account to send everything to: connect a wallet first.");
      return acct.runOwnerActions([unwindAction(tokens, to)], { title: "Account unwound" });
    });

  const title = mode === "unwind" ? "Unwind the protected account" : position ? `Close ${position.label}` : "Close a position";
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={
        mode === "unwind"
          ? "Revokes the guardian's mandate, withdraws every position from lending, and sends the rescue reserve, the collateral and the spare NEAR back to you. Whatever cannot move stays in the account and is listed."
          : "All or nothing: if any step fails, every step before it is undone and nothing changes."
      }
      footer={
        done ? (
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={busy} loadingLabel="Signing" onClick={mode === "unwind" ? unwind : rhea ? closeRhea : closePerp} disabled={acct.signer === "watch"}>
              {mode === "unwind" ? "Unwind everything" : rhea ? "Close the position" : "Close the perp"}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm text-fg">
          Sent in transaction <span className="num break-all text-muted">{done}</span>.
        </p>
      ) : (
        <div className="grid gap-5">
          {mode === "close" && rhea ? (
            <fieldset className="grid gap-2">
              <legend className="label mb-2">How to repay the debt</legend>
              {(
                [
                  ["sell", "Sell collateral to repay", "The account withdraws just enough collateral, swaps it on the Rhea exchange, repays all the debt and withdraws the rest, in one atomic step."],
                  ["wallet", "Repay from my wallet", "Your wallet sends the debt in USDC to the account, which repays it and withdraws all the collateral."],
                ] as const
              ).map(([v, label, body]) => (
                <label key={v} className={cn("flex cursor-pointer gap-3 rounded-[10px] border p-3.5 transition-colors", how === v ? "border-brass-fill/60 bg-brass-fill/5" : "border-line hover:bg-hover", v === "wallet" && !isWallet && "pointer-events-none opacity-50")}>
                  <input type="radio" name="how" value={v} checked={how === v} onChange={() => setHow(v)} disabled={v === "wallet" && !isWallet} className="mt-1" />
                  <span>
                    <span className="block text-sm text-fg">{label}</span>
                    <span className="mt-0.5 block text-[13px] leading-5 text-muted">{v === "wallet" && !isWallet ? "Connect the owner's NEAR wallet to repay from it." : body}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {mode === "close" && (how === "sell" || !rhea) ? (
            <label className="grid gap-1.5 text-sm">
              <span className="flex justify-between">
                <span className="text-muted">Slippage allowed</span>
                <span className="num text-fg">{(slippage / 100).toFixed(2)}%</span>
              </span>
              <input type="range" min={10} max={300} step={10} value={slippage} onChange={(e) => setSlippage(Number(e.target.value))} className="parry-range" />
            </label>
          ) : null}
          {acct.signer === "watch" ? <p className="text-sm text-muted">You are watching this account. Connect its owner to close or unwind it.</p> : null}
          {error ? <p className="text-sm text-critical">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
