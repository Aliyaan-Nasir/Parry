"use client";

import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { healthFactor, liquidationPrice, type LendingPosition } from "@parryguard/core";
import { buildMandate, ownerActions, sealPolicy, toBase64, type Mandate } from "@parryguard/sdk";
import { AccountGate } from "@/components/app/AccountGate";
import { AmountField } from "@/components/app/AmountField";
import { DataList, DataRow, errorMessage, Note, QueryError } from "@/components/app/bits";
import { DEFAULT_POLICY } from "@/components/app/mandate";
import { positionHref } from "@/components/app/PositionsTable";
import { StepList, type Step } from "@/components/app/StepList";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { RatesPanel } from "@/components/app/Rates";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { useRatesLive } from "@/lib/live";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { shortfallYocto } from "@/lib/funding";
import { chain } from "@/lib/parry";
import { useAccountSummary, useLendingRatios, useMarket, useNearBalance } from "@/lib/queries";
import { formatHealth, formatNumber, formatPercent, fromUnits, toUnits } from "@/lib/units";

/** A figure that cannot be computed yet. */
function Dash() {
  return (
    <span className="text-muted" aria-label="not yet">
      –
    </span>
  );
}

/** The health range a new position may open at. */
const MIN_HEALTH = 1.15;
const MAX_HEALTH = 3;

type Preview = { borrow: number; health: number; liqPrice: number | null; distance: number | null; leverage: number; collateralUsd: number };

function preview(depositNear: number, leverage: number, price: number, ratios: { collateral: number; debt: number }, existing: { near: number; debt: number }): Preview {
  const newValue = depositNear * price;
  const borrow = Math.floor(newValue * (1 - 1 / leverage) * 1e6) / 1e6;
  const position: LendingPosition = {
    collateral: [{ symbol: "wNEAR", amount: depositNear + existing.near, priceUsd: price, volatilityRatio: ratios.collateral, driver: true }],
    debt: [{ symbol: "USDC", amount: borrow + existing.debt, priceUsd: 1, volatilityRatio: ratios.debt, driver: false }],
  };
  const liq = liquidationPrice(position, price);
  return { borrow, health: healthFactor(position), liqPrice: liq, distance: liq !== null ? 1 - liq / price : null, leverage, collateralUsd: (depositNear + existing.near) * price };
}

/** Leverage on the new deposit that gives `health` on it alone: B = C P (1 − 1/L), H = C P a / B. */
function leverageAt(health: number, ratios: { collateral: number; debt: number }) {
  return 1 / (1 - (ratios.collateral * ratios.debt) / health);
}

function defaultMandate(account: string, guardianKey: string, sealingKey: string | null, contracts: { usdc: string; wnear: string }, borrowUnits: bigint, depositYocto: bigint): Mandate {
  const mandate = buildMandate({
    account,
    guardianKey,
    powers: ["repay", "add_collateral", "deleverage"],
    limits: [
      { token: contracts.usdc, reserve: borrowUnits, daily: borrowUnits },
      { token: contracts.wnear, reserve: depositYocto, daily: depositYocto },
    ],
    maxActionsPerDay: 10,
    minHealthAfterBps: 12_000,
    maxSlippageBps: 200,
    expiresAt: Math.floor(Date.now() / 1000) + 90 * 86_400,
  });
  return { ...mandate, sealed: sealingKey ? toBase64(sealPolicy(DEFAULT_POLICY, { account, sealingPublicKey: sealingKey })) : null };
}

function Opener({ account, signer }: { account: string; signer: Signer }) {
  const acct = useParryAccount();
  const { format } = useMoney();
  const market = useMarket();
  const ratios = useLendingRatios();
  const summary = useAccountSummary(account);
  const accountBalance = useNearBalance(account);
  const walletBalance = useQuery({
    queryKey: ["balance", acct.wallet?.accountId ?? ""],
    queryFn: async () => (await chain()).near.getBalance(acct.wallet!.accountId),
    enabled: signer === "wallet" && !!acct.wallet,
  });
  const [amount, setAmount] = useState("");
  const [leverage, setLeverage] = useState(1.6);
  const [protect, setProtect] = useState(true);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Coming back to this page starts a fresh form, unless a run is still going.
  useLayoutEffect(
    () => () => {
      if (!inFlight.current) setSteps(null);
      setError(null);
    },
    [],
  );

  const price = market.data?.near.priceUsd ?? null;
  const r = ratios.data ?? null;
  const rhea = summary.data?.positions.find((p) => p.venue === "rhea") ?? null;
  const existing = useMemo(() => (rhea && price ? { near: rhea.collateralUsd / price, debt: rhea.debtUsd } : { near: 0, debt: 0 }), [rhea, price]);
  const minLev = r ? Math.ceil(leverageAt(MAX_HEALTH, r) * 100) / 100 : 1.3;
  const maxLev = r ? Math.floor(leverageAt(MIN_HEALTH, r) * 100) / 100 : 2.6;
  const lev = Math.min(maxLev, Math.max(minLev, leverage));
  const depositYocto = toUnits(amount, 24);
  const deposit = depositYocto !== null ? Number(amount) : 0;
  const p = price && r && deposit > 0 ? preview(deposit, lev, price, r, existing) : null;
  const available = signer === "wallet" ? walletBalance.data : accountBalance.data;
  const hasMandate = !!summary.data?.mandate;
  // The leverage alone sets the new deposit's health: H = a / (1 - 1/L).
  const levHealth = r ? (r.collateral * r.debt) / (1 - 1 / lev) : null;
  const shownHealth = p?.health ?? levHealth;
  const rates = useRatesLive();
  const borrowApr = rates.data?.rhea.find((x) => x.asset === "USDC")?.borrowApr ?? null;
  const supplyApr = rates.data?.rhea.find((x) => x.asset === "wNEAR")?.supplyApr ?? null;

  const update = (key: string, patch: Partial<Step>) => setSteps((all) => (all ? all.map((s) => (s.key === key ? { ...s, ...patch } : s)) : all));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!depositYocto || depositYocto <= 0n) return setError("Enter how much NEAR to deposit.");
    if (!p || !price || !r) return setError("The price and the lending ratios are still loading.");
    if (p.health < MIN_HEALTH) return setError(`Health would be ${formatHealth(p.health)}: lower the leverage to stay above ${MIN_HEALTH}.`);
    setError(null);
    const borrowUnits = toUnits(p.borrow.toFixed(6), 6) ?? 0n;
    const plan: Step[] = [
      ...(signer === "wallet" ? [{ key: "fund", label: "Send NEAR to your protected account", status: "waiting" as const }] : []),
      { key: "wrap", label: `Wrap ${amount} NEAR into wNEAR`, status: "waiting" },
      { key: "supply", label: "Supply the wNEAR as collateral on Rhea", status: "waiting" },
      { key: "borrow", label: `Borrow ${formatNumber(p.borrow, 2)} USDC`, status: "waiting" },
      ...(protect ? [{ key: "mandate", label: "Set the default mandate", status: "waiting" as const }] : []),
    ];
    setSteps(plan);
    setRunning(true);
    inFlight.current = true;
    let current = plan[0]!.key;
    try {
      const c = await chain();
      if (signer === "wallet") {
        current = "fund";
        update("fund", { status: "active", detail: "Checking the account's balance" });
        const missing = await shortfallYocto(account, depositYocto);
        if (missing === 0n) update("fund", { status: "skipped", detail: "The account already holds enough NEAR." });
        else {
          update("fund", { detail: `Your wallet sends ${fromUnits(missing, 24)} NEAR` });
          const hash = await acct.fundFromWallet(missing);
          update("fund", { status: "done", detail: `${fromUnits(missing, 24)} NEAR sent`, txHash: hash });
        }
      } else {
        const missing = await shortfallYocto(account, depositYocto);
        if (missing > 0n) throw Object.assign(new Error(`Your account needs ${fromUnits(missing, 24)} more NEAR. Send it to the account address, then try again.`), { step: "wrap" });
      }
      current = "wrap";
      update("wrap", { status: "active", detail: undefined });
      const wrapHash = await acct.runOwnerActions([ownerActions.call({ receiverId: c.contracts.wnear, methodName: "near_deposit", args: {}, deposit: depositYocto, tgas: 10 })], {
        title: "NEAR wrapped",
        quiet: true,
      });
      update("wrap", { status: "done", txHash: wrapHash });
      current = "supply";
      update("supply", { status: "active" });
      const supplyHash = await acct.runOwnerActions([ownerActions.supply(c.contracts.wnear, depositYocto)], { title: "Collateral supplied", quiet: true });
      update("supply", { status: "done", txHash: supplyHash });
      current = "borrow";
      update("borrow", { status: "active" });
      const borrowHash = await acct.runOwnerActions([ownerActions.borrow(c.contracts.usdc, borrowUnits)], { title: "Position opened" });
      update("borrow", { status: "done", txHash: borrowHash });
      if (protect) {
        current = "mandate";
        if (hasMandate) update("mandate", { status: "skipped", detail: "A mandate is already set; change it on the Protect page." });
        else {
          update("mandate", { status: "active" });
          const info = await c.enclave();
          const mandate = defaultMandate(account, info.key.public_key, info.sealingKey?.public_key ?? null, c.contracts, borrowUnits, depositYocto);
          const hash = await acct.runOwnerActions([ownerActions.setMandate(mandate)], { title: "Protection on" });
          update("mandate", { status: "done", txHash: hash, detail: mandate.sealed ? "Default thresholds sealed to the enclave." : "The enclave has no sealing key yet: the guardian uses its defaults." });
        }
      }
      setAmount("");
    } catch (e2) {
      const step = (e2 as { step?: string }).step ?? current;
      update(step, { status: "failed", detail: errorMessage(e2) });
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  if (market.isError && !market.data) return <QueryError title="The NEAR price is unavailable" error={market.error} onRetry={() => void market.refetch()} />;
  if (ratios.isError && !ratios.data) return <QueryError title="The lending ratios could not be read" error={ratios.error} onRetry={() => void ratios.refetch()} />;

  const done = steps?.every((s) => s.status === "done" || s.status === "skipped");
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
      <Card as="section" aria-labelledby="open-title" className="grid content-start gap-6">
        <CardHeader
          titleAs="h2"
          title={<span id="open-title">Deposit and borrow</span>}
          description="Your protected account wraps the NEAR, supplies it on Rhea as collateral, and borrows USDC against it."
        />
        <form onSubmit={onSubmit} className="grid gap-6" noValidate>
          <AmountField
            label="NEAR to deposit"
            unit="NEAR"
            value={amount}
            onChange={setAmount}
            disabled={signer === "watch" || running}
            error={amount !== "" && (depositYocto === null || depositYocto <= 0n) ? "Enter a positive amount, with at most 24 decimals." : null}
            hint={
              available !== undefined
                ? `${signer === "wallet" ? "Your wallet" : "The account"} holds ${formatNumber(Number(available), 2)} NEAR${signer === "wallet" ? "; it sends what the account lacks" : ""}.`
                : signer === "passkey"
                  ? "Paid from the account's own NEAR."
                  : undefined
            }
          />
          <Slider
            label="Leverage"
            description={`Borrowing keeps health between ${MIN_HEALTH} and ${MAX_HEALTH}.`}
            min={minLev}
            max={maxLev}
            step={0.01}
            value={lev}
            formatValue={(v) => `${v.toFixed(2)}x`}
            onValueChange={setLeverage}
            disabled={signer === "watch" || running || !r}
          />
          <Toggle
            label="Protect it right away"
            description={
              hasMandate
                ? "A mandate is already set on this account; it covers the new position too."
                : "Sets a default mandate after opening: repay, add collateral and deleverage, with this position's USDC and wNEAR as the reserve, for 90 days."
            }
            checked={protect && !hasMandate}
            onCheckedChange={setProtect}
            disabled={signer === "watch" || running || hasMandate}
          />
          {signer === "watch" ? <Note>You are watching this account. Opening a position needs its owner&apos;s wallet or passkey.</Note> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={signer === "watch" || !p} loading={running} loadingLabel="Opening the position">
              Open position
            </Button>
            <span className="text-[13px] text-muted">{signer === "wallet" ? "Your wallet confirms each step." : signer === "passkey" ? "Your passkey confirms each step; the relayer pays the gas." : ""}</span>
          </div>
          {error ? (
            <p role="alert" className="text-[13px] font-medium text-critical">
              {error}
            </p>
          ) : null}
        </form>
        {steps ? (
          <div className="grid gap-4 border-t border-line pt-6" aria-live="polite">
            <StepList steps={steps} label="Opening steps" />
            {done ? (
              <div className="flex flex-wrap gap-2">
                <ButtonLink href={rhea ? positionHref(rhea.id) : "/app"} variant="secondary">
                  {rhea ? "See the position" : "Back to the dashboard"}
                </ButtonLink>
                <ButtonLink href="/app/protect" variant="ghost">
                  Review protection
                </ButtonLink>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:sticky lg:top-20">
      <Card as="aside" aria-labelledby="preview-title" className="grid gap-4">
        <h2 id="preview-title" className="text-[15px] text-fg">
          Preview
        </h2>
        <RiskInstrument health={shownHealth} annualVol={market.data?.tremor.annual ?? null} trigger={DEFAULT_POLICY.triggerHealth} target={DEFAULT_POLICY.targetHealth} label="Health after opening" />
        <p className="-mt-1 text-[12.5px] leading-5 text-muted">Moves with the leverage. The marks are the guardian&apos;s default trigger and target.</p>
        {!price || !r ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton />
            <Skeleton />
            <Skeleton width="60%" />
          </div>
        ) : (
          <DataList>
            <DataRow label="NEAR price">
              <span className="num">{format(price)}</span>
            </DataRow>
            <DataRow label="You borrow">
              <span className="num">{p ? `${formatNumber(p.borrow, 2)} USDC` : <Dash />}</span>
            </DataRow>
            <DataRow label="Health">
              <span className="num">{p ? formatHealth(p.health) : <Dash />}</span>
            </DataRow>
            <DataRow label="Liquidation price">
              <span className="num">{p && p.liqPrice !== null ? format(p.liqPrice) : <Dash />}</span>
            </DataRow>
            <DataRow label="Price can fall">
              <span className="num">{p && p.distance !== null ? formatPercent(p.distance, 1) : <Dash />}</span>
            </DataRow>
            <DataRow label="Collateral" hint={rhea ? "Including your current position" : undefined}>
              <span className="num">{p ? format(p.collateralUsd) : <Dash />}</span>
            </DataRow>
            <DataRow label="Net interest, a year" hint="What the collateral earns, less the borrow cost">
              <span className="num">{p && borrowApr !== null && supplyApr !== null ? format((p.collateralUsd - existing.near * price) * supplyApr - p.borrow * borrowApr, { signed: true }) : <Dash />}</span>
            </DataRow>
          </DataList>
        )}
        {!p && price && r ? <p className="text-[13px] text-muted">Enter an amount of NEAR to see the position before you open it.</p> : null}
        <p className="text-[12px] leading-5 text-muted">
          Computed here with Parry&apos;s risk model and Rhea&apos;s ratios
          {r ? ` (wNEAR counts at ${formatPercent(r.collateral, 0)}, USDC debt at 1/${formatNumber(r.debt, 2)})` : ""}. Liquidation starts below health 1.
        </p>
      </Card>
      <RatesPanel />
      </div>
    </div>
  );
}

export function OpenView() {
  return (
    <AccountGate title="Connect an account to open a protected position" description="Deposit NEAR, borrow USDC against it, and let the guardian watch it from the first block.">
      {({ account, signer }) => <Opener account={account} signer={signer} />}
    </AccountGate>
  );
}
