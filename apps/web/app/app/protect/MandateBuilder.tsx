"use client";

import { useId, useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { MAX_TRIGGER_HEALTH } from "@parry/core";
import { buildMandate, MANDATE_LIMITS, ownerActions, POLICY_STEPS, POWERS, sealPolicy, STRATEGIES, STRATEGY_STEPS, toBase64, type ContractIds, type Mandate, type PolicyStep, type Position, type Power, type Strategy } from "@parry/sdk";
import { AmountField } from "@/components/app/AmountField";
import { GuardianPreview } from "@/components/app/GuardianPreview";
import { StepOrder, type OrderItem } from "@/components/app/StepOrder";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { errorMessage, Note, Segmented } from "@/components/app/bits";
import { POWER_LABEL, STRATEGY_LABEL } from "@/components/app/labels";
import { DEFAULT_POLICY } from "@/components/app/mandate";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { chain } from "@/lib/parry";
import { useEnclave, useHedgeMarket } from "@/lib/queries";
import { formatBps, fromUnits, toUnits } from "@/lib/units";
import { network } from "@/lib/env";
import { cn } from "@/lib/cn";
import { readPolicy, rememberPolicy } from "@/lib/policy-memory";

/**
 * The Aave market EVM rescues run on: Base Sepolia on testnet (the MPC network verifies Base),
 * Base on mainnet. The guard repays USDC to this pool only.
 */
const AAVE =
  network === "mainnet"
    ? { chainId: 8453, name: "Base", pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
    : { chainId: 84532, name: "Base Sepolia", pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" };

const DURATIONS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
] as const;


type Draft = {
  powers: Power[];
  usdcReserve: string;
  usdcDaily: string;
  wnearReserve: string;
  wnearDaily: string;
  maxActions: number;
  minHealthAfter: number;
  slippageBps: number;
  days: number;
  hlAsset: string;
  hlIndex: string;
  hlMaxSize: string;
  hlBand: number;
  hlHedgeIsBuy: boolean;
  evmChainId: string;
  evmPool: string;
  evmAsset: string;
  evmAddress: string;
  evmMax: string;
  evmDecimals: string;
  triggerScore: number;
  triggerHealth: number;
  targetHealth: number;
  strategy: Strategy;
  steps: OrderItem[];
};

/** The five protective steps, in `order` first (switched on), then the rest (switched off). */
function stepItems(order: readonly string[]): OrderItem[] {
  const rest = POLICY_STEPS.filter((s) => !order.includes(s));
  return [...order, ...rest].map((id) => ({ id, label: POWER_LABEL[id]?.label ?? id, detail: POWER_LABEL[id]?.detail ?? "", on: order.includes(id) }));
}

/**
 * The order the owner chose among the steps the mandate's powers allow, or undefined when it is
 * just the strategy's own order (the sealed policy then carries no `steps`).
 */
function chosenSteps(d: Draft): PolicyStep[] | undefined {
  const allowed = (s: string) => d.powers.includes(s as Power);
  const on = d.steps.filter((s) => s.on && allowed(s.id)).map((s) => s.id as PolicyStep);
  const base = STRATEGY_STEPS[d.strategy].filter(allowed);
  return on.length === base.length && on.every((s, i) => s === base[i]) ? undefined : on;
}

function draftFrom(current: Mandate | null, contracts: ContractIds, evmAddress: string | null): Draft {
  const limit = (token: string) => current?.limits.find((l) => l.token === token);
  const usdc = limit(contracts.usdc);
  const wnear = limit(contracts.wnear);
  const days = current ? Math.max(7, Math.min(180, Math.round((current.expires_at * 1000 - Date.now()) / 86_400_000))) : 90;
  return {
    powers: current?.powers ?? ["repay", "add_collateral", "deleverage"],
    usdcReserve: usdc ? fromUnits(usdc.reserve, 6, 6).replace(/,/g, "") : "",
    usdcDaily: usdc ? fromUnits(usdc.daily, 6, 6).replace(/,/g, "") : "",
    wnearReserve: wnear ? fromUnits(wnear.reserve, 24, 6).replace(/,/g, "") : "",
    wnearDaily: wnear ? fromUnits(wnear.daily, 24, 6).replace(/,/g, "") : "",
    maxActions: current?.max_actions_per_day ?? 10,
    minHealthAfter: (current?.min_health_after_bps ?? 12_000) / 10_000,
    slippageBps: current?.max_slippage_bps ?? 200,
    days: DURATIONS.reduce((best, d) => (Math.abs(d.value - days) < Math.abs(best - days) ? d.value : best), 90 as number),
    hlAsset: current?.hl?.asset ?? "NEAR",
    hlIndex: current?.hl ? String(current.hl.asset_index) : "",
    hlMaxSize: current?.hl ? fromUnits(current.hl.max_size_e8, 8, 8).replace(/,/g, "") : "",
    hlBand: current?.hl?.band_bps ?? 100,
    hlHedgeIsBuy: current?.hl?.hedge_is_buy ?? false,
    evmChainId: current?.evm ? String(current.evm.chain_id) : String(AAVE.chainId),
    evmPool: current?.evm?.pool ?? AAVE.pool,
    evmAsset: current?.evm?.asset ?? AAVE.usdc,
    evmAddress: current?.evm?.address ?? evmAddress ?? "",
    evmMax: current?.evm ? current.evm.max_amount : "",
    evmDecimals: "6",
    ...DEFAULT_POLICY,
    steps: stepItems(STRATEGY_STEPS[DEFAULT_POLICY.strategy]),
  };
}

function Fieldset({ legend, description, children, className }: { legend: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn("grid gap-4 border-t border-line pt-6", className)}>
      <legend className="float-left w-full">
        <span className="block text-[15px] font-semibold text-fg">{legend}</span>
        {description ? <span className="mt-1 block text-[13px] leading-5 text-muted">{description}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

function TextField({ label, value, onChange, placeholder, hint, mono = true, disabled }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; mono?: boolean; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-fg">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={cn("h-10 min-w-0 rounded-lg border border-line-strong bg-raised px-3 text-sm text-fg placeholder:text-muted disabled:opacity-55", mono && "num text-[13px]")}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Units of a decimal token amount, or an error message. */
function units(value: string, decimals: number, what: string): bigint {
  if (value.trim() === "") return 0n;
  const u = toUnits(value, decimals);
  if (u === null) throw new Error(`${what} must be a plain decimal number with at most ${decimals} decimals.`);
  return u;
}

/** The mandate form: public hard limits on chain, and a policy sealed to the enclave. */
export function MandateBuilder({
  account,
  signer,
  current,
  contracts,
  evmAddress,
  position,
  price,
  annualVol,
}: {
  account: string;
  signer: Signer;
  current: Mandate | null;
  contracts: ContractIds;
  evmAddress: string | null;
  position: Position | null;
  price: number | null;
  annualVol: number | null;
}) {
  const acct = useParryAccount();
  const enclave = useEnclave();
  const hedgeMarket = useHedgeMarket();
  const [d, setD] = useState<Draft>(() => {
    const draft = draftFrom(current, contracts, evmAddress);
    // The owner's own copy of the sealed policy, when this browser set it.
    const own = current && typeof window !== "undefined" ? readPolicy(account) : null;
    if (!own || !(STRATEGIES as readonly string[]).includes(own.strategy)) return draft;
    const strategy = own.strategy as Strategy;
    return { ...draft, triggerScore: own.triggerScore, triggerHealth: own.triggerHealth, targetHealth: own.targetHealth, strategy, steps: stepItems(own.steps ?? STRATEGY_STEPS[strategy]) };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((x) => ({ ...x, [key]: value }));
  const has = (p: Power) => d.powers.includes(p);
  const hlOn = has("hl_reduce") || has("hl_hedge");
  const evmOn = has("evm_repay");
  const sealingKey = enclave.data?.sealingKey?.public_key ?? null;
  const canAct = signer !== "watch";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (d.targetHealth <= d.triggerHealth) return setError("The target health must be above the trigger health, or a rescue would end where it starts.");
    setBusy(true);
    try {
      const info = enclave.data ?? (await (await chain()).enclave());
      const limits: { token: string; reserve: bigint; daily: bigint }[] = [];
      const usdcReserve = units(d.usdcReserve, 6, "The USDC reserve");
      const usdcDaily = units(d.usdcDaily, 6, "The USDC daily cap");
      const wnearReserve = units(d.wnearReserve, 24, "The wNEAR reserve");
      const wnearDaily = units(d.wnearDaily, 24, "The wNEAR daily cap");
      if (usdcReserve > 0n || usdcDaily > 0n) limits.push({ token: contracts.usdc, reserve: usdcReserve, daily: usdcDaily });
      if (wnearReserve > 0n || wnearDaily > 0n) limits.push({ token: contracts.wnear, reserve: wnearReserve, daily: wnearDaily });
      if ((has("repay") || has("add_collateral") || has("deleverage")) && limits.length === 0) {
        throw new Error("Repay, add collateral and deleverage spend from a reserve: set a USDC or wNEAR reserve and daily cap.");
      }
      const index = Number(d.hlIndex);
      const mandate = buildMandate({
        account,
        guardianKey: info.key.public_key,
        powers: d.powers,
        limits,
        maxActionsPerDay: d.maxActions,
        minHealthAfterBps: Math.round(d.minHealthAfter * 10_000),
        maxSlippageBps: d.slippageBps,
        hl: hlOn ? { asset: d.hlAsset || "NEAR", assetIndex: Number.isInteger(index) ? index : -1, maxSizeE8: units(d.hlMaxSize, 8, "The Hyperliquid size cap"), bandBps: d.hlBand, hedgeIsBuy: d.hlHedgeIsBuy } : null,
        evm: evmOn
          ? {
              chainId: Number(d.evmChainId),
              pool: d.evmPool,
              asset: d.evmAsset,
              address: d.evmAddress,
              maxAmount: units(d.evmMax, Math.max(0, Math.min(30, Number(d.evmDecimals) || 0)), "The EVM repay cap"),
            }
          : null,
        expiresAt: Math.floor(Date.now() / 1000) + d.days * 86_400,
      });
      const sealingPublicKey = info.sealingKey?.public_key ?? null;
      const steps = chosenSteps(d);
      if (steps && steps.length === 0) throw new Error("Switch on at least one step for the guardian to try.");
      const sealed = sealingPublicKey
        ? sealPolicy({ triggerScore: d.triggerScore, triggerHealth: d.triggerHealth, targetHealth: d.targetHealth, strategy: d.strategy, ...(steps ? { steps } : {}) }, { account, sealingPublicKey })
        : null;
      const final: Mandate = { ...mandate, sealed: sealed ? toBase64(sealed) : null };
      await acct.runOwnerActions([ownerActions.setMandate(final)], { title: sealed ? "Mandate set, policy sealed" : "Mandate set" });
      rememberPolicy(account, { triggerScore: d.triggerScore, triggerHealth: d.triggerHealth, targetHealth: d.targetHealth, strategy: d.strategy, ...(steps ? { steps } : {}) });
    } catch (e2) {
      setError(errorMessage(e2).replace(/^mandate: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const custom = chosenSteps(d) !== undefined;
  const orderItems = d.steps.map((s) => ({ ...s, blocked: has(s.id as Power) ? null : `Needs the ${(POWER_LABEL[s.id]?.label ?? s.id).toLowerCase()} power, under Powers.` }));
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const previewSteps = orderItems.filter((s) => s.on && !s.blocked).map((s) => s.id);

  return (
    <section aria-labelledby="builder-title" className="grid gap-6">
      <div>
        <h2 id="builder-title" className="text-[17px] text-fg">
          {current ? "Change the mandate" : "Set a mandate"}
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          Two halves: hard limits that live on chain in the open, which your account enforces whatever happens, and a policy for when to act, sealed so only the guardian&apos;s enclave can read it.
        </p>
      </div>
      <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start" noValidate>
        <aside className="grid gap-4 lg:sticky lg:top-20 lg:order-2" aria-label="Preview">
          <div className="surface p-5">
            <div className="flex items-end justify-between gap-3">
              <span className="label">Trigger and target</span>
              {position?.health ? (
                <span className="text-[13px] text-muted">
                  now <span className="num text-fg">{position.health.toFixed(2)}</span>
                </span>
              ) : null}
            </div>
            <RiskInstrument
              className="mt-4"
              hideValue
              health={position?.health ?? null}
              tier={position?.tier}
              annualVol={annualVol}
              trigger={d.triggerHealth}
              target={d.targetHealth}
              onTriggerChange={canAct ? (v) => set("triggerHealth", Math.round(Math.min(MAX_TRIGGER_HEALTH, Math.max(1.05, v)) * 100) / 100) : undefined}
              onTargetChange={canAct ? (v) => set("targetHealth", Math.round(Math.min(3, Math.max(1.1, v)) * 100) / 100) : undefined}
              label={position ? `${position.label} health` : "Health"}
            />
            <p className="mt-3 text-[12.5px] leading-5 text-muted">Drag the trigger and target handles, or use the sliders under Sealed policy.</p>
          </div>
          <div className="surface p-5">
            <div className="label">What the guardian would do</div>
            <div className="mt-3">
              <GuardianPreview
                position={position}
                price={price}
                triggerHealth={d.triggerHealth}
                targetHealth={d.targetHealth}
                steps={previewSteps}
                limits={{
                  repayBudget: Math.min(num(d.usdcReserve), num(d.usdcDaily)),
                  collateralBudget: Math.min(num(d.wnearReserve), num(d.wnearDaily)),
                  deleverageBudget: num(d.wnearDaily),
                  maxSlippage: d.slippageBps / 10_000,
                }}
              />
            </div>
          </div>
        </aside>
        <div className="surface grid content-start gap-6 p-6 lg:order-1">
        <Fieldset
          className="border-t-0 pt-0"
          legend="Sealed policy"
          description="When the guardian acts and how. Your browser encrypts these to the enclave's key before they go on chain: nobody else, Parry's operators included, can read them, so nobody can see when Parry will step in and trade ahead of it."
        >
          {enclave.data && !sealingKey ? (
            <Note tone="caution">The enclave has not published a sealing key yet, so this policy cannot be sealed. The mandate goes on chain without it, and the guardian uses its defaults: act at score 60 or health 1.15, aim for 1.45, repay first.</Note>
          ) : null}
          <div className="grid gap-6 sm:grid-cols-3">
            <Slider label="Act at score" description="Or above." min={25} max={95} step={5} value={d.triggerScore} onValueChange={(v) => set("triggerScore", v)} disabled={!canAct} />
            <Slider
              label="Act at health"
              description="Or below, whatever the score."
              min={1.05}
              max={MAX_TRIGGER_HEALTH}
              step={0.05}
              value={d.triggerHealth}
              formatValue={(v) => v.toFixed(2)}
              onValueChange={(v) => set("triggerHealth", Math.round(v * 100) / 100)}
              disabled={!canAct}
            />
            <Slider
              label="Aim for health"
              description="Where a rescue stops."
              min={1.1}
              max={3}
              step={0.05}
              value={d.targetHealth}
              formatValue={(v) => v.toFixed(2)}
              onValueChange={(v) => set("targetHealth", Math.round(v * 100) / 100)}
              disabled={!canAct}
            />
          </div>
          <div role="radiogroup" aria-label="Strategy" className="grid gap-2 sm:grid-cols-3">
            {STRATEGIES.map((s) => (
              <label key={s} className={cn("flex cursor-pointer gap-3 rounded-[10px] border p-3 transition-colors", d.strategy === s ? "border-brass-fill/60 bg-brass-fill/5" : "border-line hover:bg-hover")}>
                <input type="radio" name="strategy" value={s} checked={d.strategy === s} onChange={() => setD((x) => ({ ...x, strategy: s, steps: stepItems(STRATEGY_STEPS[s]) }))} disabled={!canAct} className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm text-fg">{STRATEGY_LABEL[s]?.label ?? s}</span>
                  <span className="mt-0.5 block text-[12.5px] leading-5 text-muted">{STRATEGY_LABEL[s]?.detail}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <span className="text-sm text-fg">The order it tries steps in</span>
              <span className="text-[12.5px] text-muted">{custom ? `Your own order, starting from ${STRATEGY_LABEL[d.strategy]?.label.toLowerCase()}` : `${STRATEGY_LABEL[d.strategy]?.label}'s order`}</span>
            </div>
            <p className="text-[12.5px] leading-5 text-muted">Drag a step by its grip, or focus the grip and use the arrow keys. The guardian takes the first step that is switched on, allowed by the mandate and able to move health, sizes it to land on the target, and checks the position again before the next.</p>
            <StepOrder items={orderItems} onChange={(next) => set("steps", next.map(({ id, label, detail, on }) => ({ id, label, detail, on })))} disabled={!canAct} />
          </div>
        </Fieldset>

        <Fieldset legend="Powers" description="What the guardian may do. No power can move money out of your account: the contract has no such action for it.">
          <div className="grid gap-2 sm:grid-cols-2">
            {POWERS.map((p) => (
              <label key={p} className={cn("flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors", has(p) ? "border-brass/50 bg-brass-soft" : "border-line hover:bg-hover")}>
                <input
                  type="checkbox"
                  checked={has(p)}
                  disabled={!canAct}
                  onChange={(e) => set("powers", e.target.checked ? [...d.powers, p] : d.powers.filter((x) => x !== p))}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-fg">{POWER_LABEL[p]?.label ?? p}</span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-muted">{POWER_LABEL[p]?.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </Fieldset>

        <Fieldset legend="Hard limits" description="Public on chain. The account refuses any guardian action beyond them.">
          <div className="grid gap-4 sm:grid-cols-2">
            <AmountField label="USDC reserve" unit="USDC" value={d.usdcReserve} onChange={(v) => set("usdcReserve", v)} hint="The most it may spend over the mandate's life" disabled={!canAct} />
            <AmountField label="USDC per day" unit="USDC" value={d.usdcDaily} onChange={(v) => set("usdcDaily", v)} hint="The most it may spend in one UTC day" disabled={!canAct} />
            <AmountField label="wNEAR reserve" unit="wNEAR" value={d.wnearReserve} onChange={(v) => set("wnearReserve", v)} hint="Collateral it may add or sell, in total" disabled={!canAct} />
            <AmountField label="wNEAR per day" unit="wNEAR" value={d.wnearDaily} onChange={(v) => set("wnearDaily", v)} hint="Collateral it may add or sell in one day" disabled={!canAct} />
          </div>
          <div className="grid gap-6 pt-2 sm:grid-cols-2">
            <Slider label="Actions per day" min={1} max={MANDATE_LIMITS.maxActionsPerDay} value={d.maxActions} onValueChange={(v) => set("maxActions", v)} disabled={!canAct} />
            <Slider
              label="Health after a deleverage"
              description="Each sale must leave at least this health."
              min={MANDATE_LIMITS.minHealthAfterBps / 10_000}
              max={2}
              step={0.05}
              value={d.minHealthAfter}
              formatValue={(v) => v.toFixed(2)}
              onValueChange={(v) => set("minHealthAfter", Math.round(v * 100) / 100)}
              disabled={!canAct}
            />
            <Slider
              label="Largest swap slippage"
              description="Against the mark, for a rescue swap."
              min={0}
              max={MANDATE_LIMITS.maxSlippageBps}
              step={10}
              value={d.slippageBps}
              formatValue={formatBps}
              onValueChange={(v) => set("slippageBps", v)}
              disabled={!canAct}
            />
            <div className="grid content-start gap-2">
              <span className="text-sm font-semibold text-fg">Lasts for</span>
              <Segmented label="Lasts for" options={DURATIONS} value={d.days as 7 | 30 | 90 | 180} onChange={(v) => set("days", v)} />
            </div>
          </div>
        </Fieldset>

        {hlOn ? (
          <Fieldset legend="Hyperliquid guard" description="Orders the guardian signs through Chain Signatures stay inside these bounds.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Asset" value={d.hlAsset} onChange={(v) => set("hlAsset", v)} placeholder="NEAR" disabled={!canAct} />
              <TextField
                label="Asset index"
                value={d.hlIndex}
                onChange={(v) => set("hlIndex", v.replace(/\D/g, ""))}
                placeholder={hedgeMarket.data ? String(hedgeMarket.data.asset_index) : "Index"}
                hint={hedgeMarket.data ? `The vault hedges ${hedgeMarket.data.asset} at index ${hedgeMarket.data.asset_index}.` : "Hyperliquid's index for the market."}
                disabled={!canAct}
              />
              <AmountField label="Largest order" unit={d.hlAsset || "NEAR"} value={d.hlMaxSize} onChange={(v) => set("hlMaxSize", v)} disabled={!canAct} />
              <Slider label="Price band" description="Limit price distance from the enclave's mark." min={10} max={MANDATE_LIMITS.maxBandBps} step={10} value={d.hlBand} formatValue={formatBps} onValueChange={(v) => set("hlBand", v)} disabled={!canAct} />
            </div>
            {hedgeMarket.data && d.hlIndex === "" ? (
              <div>
                <Button size="sm" variant="ghost" onClick={() => setD((x) => ({ ...x, hlAsset: hedgeMarket.data!.asset, hlIndex: String(hedgeMarket.data!.asset_index) }))}>
                  Use {hedgeMarket.data.asset} at index {hedgeMarket.data.asset_index}
                </Button>
              </div>
            ) : null}
            <label className="flex items-start gap-3 text-sm text-fg">
              <input type="checkbox" checked={d.hlHedgeIsBuy} onChange={(e) => set("hlHedgeIsBuy", e.target.checked)} disabled={!canAct} className="mt-0.5 size-4" />
              <span>
                A hedge buys
                <span className="block text-[13px] text-muted">Leave off when your collateral is NEAR: the hedge is then a short.</span>
              </span>
            </label>
          </Fieldset>
        ) : null}

        {evmOn ? (
          <Fieldset legend="EVM guard" description={`The guardian may repay only this Aave pool on ${AAVE.name}, in this asset, from your account's own EVM address.`}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Chain id" value={d.evmChainId} onChange={(v) => set("evmChainId", v.replace(/\D/g, ""))} disabled={!canAct} />
              <TextField label="Your EVM address" value={d.evmAddress} onChange={(v) => set("evmAddress", v)} placeholder="0x..." hint="Derived for this account by Chain Signatures." disabled={!canAct} />
              <TextField label="Aave pool" value={d.evmPool} onChange={(v) => set("evmPool", v)} placeholder="0x..." disabled={!canAct} />
              <TextField label="Debt asset" value={d.evmAsset} onChange={(v) => set("evmAsset", v)} placeholder="0x..." hint={d.evmAsset.toLowerCase() === AAVE.usdc.toLowerCase() ? "USDC" : undefined} disabled={!canAct} />
              <AmountField label="Largest repay" unit="tokens" value={d.evmMax} onChange={(v) => set("evmMax", v)} disabled={!canAct} />
              <TextField label="Asset decimals" value={d.evmDecimals} onChange={(v) => set("evmDecimals", v.replace(/\D/g, ""))} disabled={!canAct} />
            </div>
          </Fieldset>
        ) : null}

        <div className="grid gap-3 border-t border-line pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canAct || d.powers.length === 0} loading={busy} loadingLabel="Setting the mandate">
              {current ? "Replace the mandate" : "Set the mandate"}
            </Button>
            <span className="text-[13px] text-muted">
              {canAct ? (signer === "wallet" ? "Your wallet signs one transaction." : "Your passkey signs; the relayer pays the gas.") : "Watching only: the owner sets the mandate."}
            </span>
          </div>
          {d.powers.length === 0 ? <p className="text-[13px] text-muted">Choose at least one power.</p> : null}
          {error ? (
            <p role="alert" className="text-[13px] font-medium text-critical">
              {error}
            </p>
          ) : null}
        </div>
        </div>
      </form>
    </section>
  );
}
