/**
 * What of a guardian decision is public. The owner's sealed policy (trigger, target health and
 * step order) shapes every plan the enclave writes, so the full plan, the planner's reasons and
 * the review's reasoning are the owner's alone. Everyone else sees the action and its amounts.
 *
 * The enclave writes the public plan itself (`public_plan`); decisions stored before it did are
 * redacted here from their full plan text.
 */

/** A plain sentence per action, for a plan whose text does not redact cleanly. */
const GENERIC: Record<string, string> = {
  repay: "Repay debt from the reserve.",
  add_collateral: "Add collateral from the reserve.",
  deleverage: "Sell collateral and repay debt.",
  hl_reduce: "Reduce the Hyperliquid position, reduce-only.",
  hl_hedge: "Open a Hyperliquid hedge.",
  evm_approve: "Approve the Aave pool to take the next repay from the person's own address.",
  evm_repay: "Repay Aave debt from the person's own address.",
};

/** Words that name the owner's policy or a projected health: none may reach a public plan. */
const PRIVATE = /\b(target|trigger|order|health|chose|skipped|threshold)\b/i;

/**
 * The public plan of a decision: the action alone, without the owner's target or trigger, the
 * projected health, the step order or why this step was chosen.
 *
 * "Repay 3.81 USDC from the reserve: health 1.122 to 1.450 (target 1.45). Chose repay: ..." is
 * "Repay 3.81 USDC from the reserve."
 */
export function publicPlan(plan: string, action = ""): string {
  let s = plan.trim();
  // Everything from the first colon on is the projected health, the target and the reasons.
  const cuts = [": ", " (target", " (health", " Chose ", " (the repay", ", so the next run"].map((m) => s.indexOf(m)).filter((i) => i >= 0);
  if (cuts.length) s = s.slice(0, Math.min(...cuts));
  // A Hyperliquid reduce names the position's size and how it was sized: the size stays public
  // on the venue, the sizing rule is the owner's.
  s = s.replace(/ \(of [0-9.]+\)/, "").replace(/ \([^()]*\)$/, "");
  s = s.replace(/[\s.,;]+$/, "");
  if ((action === "evm_approve" || /^Approve the Aave pool/.test(s)) && !s.endsWith(", for the next repay")) s += ", for the next repay";
  s = `${s}.`;
  if (s.length < 8 || PRIVATE.test(s)) return GENERIC[action] ?? "A guardian action within the owner's mandate.";
  return s;
}

/** Whether a stored public plan is safe to serve as is (it names nothing private). */
export const isPublicPlan = (text: string | null | undefined): text is string => typeof text === "string" && text.length > 0 && !PRIVATE.test(text);
