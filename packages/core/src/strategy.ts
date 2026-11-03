/**
 * Recovery strategies: what the guardian should do to bring a lending position back to a target
 * health, within the person's mandate. A strategy is an ordered list of protective step kinds;
 * the planner fills each step with the amount it needs, stopping when the target is reached.
 *
 * Steps run one after another (multi-step coordination). On chain each step is all-or-nothing:
 * repay and add-collateral are one transfer each, and a deleverage is a promise chain that
 * restores the position if any leg fails. A deleverage can only withdraw collateral while health
 * stays at or above 1 (the lending contract refuses otherwise), so a deep deleverage becomes
 * several steps, each re-planned from the position the previous one left.
 */

export type StepKind = "repay" | "add_collateral" | "deleverage";

export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  steps: StepKind[];
}

export const STRATEGIES: StrategyDefinition[] = [
  {
    id: "repay-first",
    name: "Repay first",
    description: "Pay down debt from the rescue reserve, then add collateral, and deleverage only if the reserve runs out.",
    steps: ["repay", "add_collateral", "deleverage"],
  },
  {
    id: "keep-exposure",
    name: "Keep exposure",
    description: "Add collateral from the reserve first so the position keeps its size, then repay, then deleverage.",
    steps: ["add_collateral", "repay", "deleverage"],
  },
  {
    id: "deleverage-only",
    name: "Deleverage only",
    description: "Never spend the reserve: sell collateral to repay debt, in steps that each keep the position safe.",
    steps: ["deleverage"],
  },
];

/** A single-collateral, single-debt view of the position (the driver asset against a stablecoin). */
export interface SimplePosition {
  /** Collateral in driver units (NEAR). */
  collateral: number;
  /** Debt in USD (stablecoin units). */
  debt: number;
  price: number;
  collateralRatio: number;
  debtRatio: number;
}

export interface PlanLimits {
  /** Stablecoin the guardian may still spend from the reserve today (min of reserve left and daily cap left). */
  repayBudget: number;
  /** Driver tokens the guardian may still add from the reserve. */
  collateralBudget: number;
  /** Driver tokens the guardian may still sell today. */
  deleverageBudget: number;
  /** Largest slippage accepted against the mark (fraction, at most 0.03). */
  maxSlippage: number;
  /** Health each withdrawal must leave before its repay lands. */
  withdrawFloor: number;
  /** Most steps in one plan. */
  maxSteps: number;
}

export const DEFAULT_LIMITS: PlanLimits = {
  repayBudget: 0,
  collateralBudget: 0,
  deleverageBudget: 0,
  maxSlippage: 0.02,
  withdrawFloor: 1.01,
  maxSteps: 4,
};

export interface PlannedStep {
  kind: StepKind;
  /** USD for repay; driver units for add_collateral and deleverage. */
  amount: number;
  /** For a deleverage: the least stablecoin the swap must return (mark × amount × (1 − slippage)). */
  minOut?: number;
  healthBefore: number;
  healthAfter: number;
}

export interface Plan {
  strategy: string;
  target: number;
  steps: PlannedStep[];
  reached: boolean;
  healthAfter: number;
}

export function simpleHealth(p: SimplePosition): number {
  return p.debt <= 0 ? Infinity : (p.collateral * p.price * p.collateralRatio * p.debtRatio) / p.debt;
}

/** Repay needed to reach `target`: debt' = collateral × P × a / target. */
export function repayNeeded(p: SimplePosition, target: number): number {
  return Math.max(0, p.debt - (p.collateral * p.price * p.collateralRatio * p.debtRatio) / target);
}

/** Collateral to add to reach `target`. */
export function collateralNeeded(p: SimplePosition, target: number): number {
  return Math.max(0, (target * p.debt) / (p.price * p.collateralRatio * p.debtRatio) - p.collateral);
}

/**
 * Collateral to sell to reach `target` when the swap returns P × (1 − s) per unit:
 * (c − w) P a = target (b − w P (1 − s))  ⇒  w = (target b − c P a) / (P (target (1 − s) − a)).
 */
export function deleverageNeeded(p: SimplePosition, target: number, slippage: number): number {
  const a = p.collateralRatio * p.debtRatio;
  const denom = p.price * (target * (1 - slippage) - a);
  if (denom <= 0) return Infinity;
  return Math.max(0, (target * p.debt - p.collateral * p.price * a) / denom);
}

/** The most collateral a withdrawal can take while health stays at `floor` before the repay. */
export function maxWithdrawal(p: SimplePosition, floor: number): number {
  return Math.max(0, p.collateral - (floor * p.debt) / (p.price * p.collateralRatio * p.debtRatio));
}

const down = (x: number, dp: number) => Math.floor(x * 10 ** dp) / 10 ** dp;
/** Needed amounts round up, so a step never stops a hair short of its target. */
const up = (x: number, dp: number) => Math.ceil(x * 10 ** dp - 1e-9) / 10 ** dp;

/** Plans `strategy` until `target` health or the limits run out. */
export function plan(strategy: StrategyDefinition, position: SimplePosition, target: number, limits: PlanLimits): Plan {
  let p = { ...position };
  const steps: PlannedStep[] = [];
  let repayBudget = limits.repayBudget;
  let collateralBudget = limits.collateralBudget;
  let deleverageBudget = limits.deleverageBudget;
  for (const kind of strategy.steps) {
    while (simpleHealth(p) < target && steps.length < limits.maxSteps) {
      const before = simpleHealth(p);
      let amount = 0;
      let minOut: number | undefined;
      if (kind === "repay") {
        amount = Math.min(up(repayNeeded(p, target), 6), down(repayBudget, 6), p.debt);
        if (amount <= 0) break;
        repayBudget -= amount;
        p = { ...p, debt: p.debt - amount };
      } else if (kind === "add_collateral") {
        amount = Math.min(up(collateralNeeded(p, target), 4), down(collateralBudget, 4));
        if (amount <= 0) break;
        collateralBudget -= amount;
        p = { ...p, collateral: p.collateral + amount };
      } else {
        const need = deleverageNeeded(p, target, limits.maxSlippage);
        // The withdrawal cap and the budget are hard limits: round them down.
        amount = Math.min(up(need, 4), down(maxWithdrawal(p, limits.withdrawFloor), 4), down(deleverageBudget, 4));
        if (amount <= 0) break;
        deleverageBudget -= amount;
        minOut = down(amount * p.price * (1 - limits.maxSlippage), 6);
        p = { ...p, collateral: p.collateral - amount, debt: Math.max(0, p.debt - minOut) };
      }
      steps.push({ kind, amount, minOut, healthBefore: before, healthAfter: simpleHealth(p) });
      if (kind !== "deleverage") break;
    }
  }
  const healthAfter = simpleHealth(p);
  return { strategy: strategy.id, target, steps, reached: healthAfter >= target - 1e-9, healthAfter };
}

/** Builds a custom strategy from an ordered list of step kinds (each at most once). */
export function buildStrategy(name: string, steps: StepKind[]): StrategyDefinition {
  const unique = [...new Set(steps)];
  if (unique.length === 0) throw new Error("a strategy needs at least one step");
  return { id: `custom:${unique.join("+")}`, name, description: `Custom: ${unique.join(", then ")}.`, steps: unique };
}
