"use client";

import { buildStrategy, plan, type PlanLimits, type StepKind } from "@parryguard/core";
import type { Position } from "@parryguard/sdk";
import { ACTION_LABEL, POWER_LABEL } from "@/components/app/labels";
import { formatHealth, formatNumber } from "@/lib/units";

const LENDING: readonly string[] = ["repay", "add_collateral", "deleverage"];

const WHY_SKIPPED: Record<string, string> = {
  repay: "no USDC left to spend in the reserve or today's cap",
  add_collateral: "no wNEAR left to add in the reserve or today's cap",
  deleverage: "no wNEAR left to sell today, or health is too low to withdraw",
};

/**
 * What the guardian would do with the draft policy, worked out in the browser with the same
 * planner the services run: now, or at the price where the trigger would fire. Every step is
 * sized to land on the target, and the preview says in plain words why each one was or was not
 * used. It only covers the Rhea position: Hyperliquid and Aave steps are planned in the enclave.
 */
export function GuardianPreview({
  position,
  price,
  triggerHealth,
  targetHealth,
  steps,
  limits,
}: {
  position: Position | null;
  price: number | null;
  triggerHealth: number;
  targetHealth: number;
  steps: string[];
  limits: Pick<PlanLimits, "repayBudget" | "collateralBudget" | "deleverageBudget" | "maxSlippage">;
}) {
  const kinds = steps.filter((s) => LENDING.includes(s)) as StepKind[];
  const other = steps.filter((s) => !LENDING.includes(s));

  if (!position || position.venue !== "rhea" || position.health === null || !price || position.collateralUsd <= 0) {
    return <p className="text-sm text-muted">Open a Rhea position to see what the guardian would do with this policy.</p>;
  }
  if (kinds.length === 0) {
    return <p className="text-sm text-muted">Turn on at least one of repay, add collateral or deleverage for the guardian to protect the Rhea position.</p>;
  }

  const health = position.health;
  // A single-collateral view: health = collateral × price × factor / debt, so the factor follows.
  const factor = (health * position.debtUsd) / position.collateralUsd;
  const acting = health <= triggerHealth;
  const atPrice = acting ? price : (price * triggerHealth) / health;
  const pos = { collateral: position.collateralUsd / price, debt: position.debtUsd, price: atPrice, collateralRatio: factor, debtRatio: 1 };
  const result = plan(buildStrategy("draft", kinds), pos, targetHealth, { ...limits, withdrawFloor: 1.01, maxSteps: 6 });
  const used = new Set(result.steps.map((s) => s.kind));
  const firstUsed = kinds.findIndex((k) => used.has(k));
  const skipped = kinds.slice(0, firstUsed < 0 ? kinds.length : firstUsed).filter((k) => !used.has(k));
  const drop = 1 - atPrice / price;

  return (
    <div className="grid gap-4" aria-live="polite">
      <p className="text-sm leading-6 text-fg">
        {acting ? (
          <>Health is {formatHealth(health)}, at or under the trigger: the guardian would act now.</>
        ) : (
          <>
            It waits. Health is {formatHealth(health)}; it would act if NEAR fell to <span className="num">${atPrice.toFixed(2)}</span>, {Math.round(drop * 100)}% below today.
          </>
        )}
      </p>
      {result.steps.length > 0 ? (
        <ol className="grid gap-2">
          {result.steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-t border-line pt-2 text-sm first:border-0 first:pt-0">
              <span className="text-fg">
                {ACTION_LABEL[s.kind]} <span className="num">{formatNumber(s.amount, s.kind === "repay" ? 2 : 4)}</span> {s.kind === "repay" ? "USDC" : "NEAR"}
              </span>
              <span className="num text-[13px] text-muted">
                {formatHealth(s.healthBefore)} to <span className="text-fg">{formatHealth(s.healthAfter)}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="text-[13px] leading-5 text-muted">
        {result.steps.length === 0
          ? `Nothing it may use would move health: ${kinds.map((k) => `${ACTION_LABEL[k]!.toLowerCase()} has ${WHY_SKIPPED[k]}`).join("; ")}.`
          : result.reached
            ? `It stops at ${formatHealth(result.healthAfter)}, on the ${formatHealth(targetHealth)} target, and checks the position again after each step.`
            : `The limits run out at ${formatHealth(result.healthAfter)}, short of the ${formatHealth(targetHealth)} target: raise the reserve or the daily caps to go further.`}
        {skipped.length ? ` Skipped first: ${skipped.map((k) => `${ACTION_LABEL[k]!.toLowerCase()} (${WHY_SKIPPED[k]})`).join(", ")}.` : ""}
        {other.length ? ` ${other.map((k) => POWER_LABEL[k]?.label ?? k).join(" and ")} apply to Hyperliquid and Aave positions.` : ""}
      </p>
    </div>
  );
}
