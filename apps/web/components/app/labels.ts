// Words and tones for the API's enums, in one place.

import type { Alert, Decision } from "@parry/sdk";
import type { BadgeTone } from "@/components/ui/Badge";

export const ACTION_LABEL: Record<string, string> = {
  repay: "Repay",
  add_collateral: "Add collateral",
  deleverage: "Deleverage",
  hl_reduce: "Reduce the position",
  hl_hedge: "Open a hedge",
  evm_approve: "Approve the repay",
  evm_repay: "Repay",
};

export const OUTCOME: Record<Decision["outcome"], { label: string; tone: BadgeTone }> = {
  executed: { label: "Executed", tone: "safe" },
  refused: { label: "Refused by the account", tone: "caution" },
  rolled_back: { label: "Rolled back", tone: "danger" },
  rejected_by_review: { label: "Rejected by review", tone: "critical" },
  pending: { label: "Pending", tone: "neutral" },
};

export const SEVERITY: Record<Alert["severity"], { label: string; tone: BadgeTone }> = {
  info: { label: "Info", tone: "brass" },
  warning: { label: "Warning", tone: "caution" },
  critical: { label: "Critical", tone: "critical" },
};

export const ALERT_STATUS: Record<Alert["status"], { label: string; tone: BadgeTone }> = {
  open: { label: "Open", tone: "neutral" },
  acknowledged: { label: "Acknowledged", tone: "brass" },
  resolved: { label: "Resolved", tone: "safe" },
};

export const ALERT_KIND: Record<Alert["kind"], string> = {
  risk: "Risk score",
  health: "Health",
  cascade: "Cascade",
  guardian: "Guardian",
  vault: "Vault",
};

export const POWER_LABEL: Record<string, { label: string; detail: string }> = {
  repay: { label: "Repay debt", detail: "Pay down USDC debt from the account's own balance, within the reserve." },
  add_collateral: { label: "Add collateral", detail: "Move wNEAR the account holds into the lending position." },
  deleverage: { label: "Deleverage", detail: "Sell some collateral for USDC and repay with it, atomically, in steps that keep health above 1." },
  hl_reduce: { label: "Reduce on Hyperliquid", detail: "Close part of a Hyperliquid perp position with a reduce-only order inside the price band." },
  hl_hedge: { label: "Hedge on Hyperliquid", detail: "Open a hedge on Hyperliquid within the size cap and the price band." },
  evm_repay: { label: "Repay on EVM", detail: "Repay an Aave loan from the account's EVM address, up to the cap per action." },
};

export const STRATEGY_LABEL: Record<string, { label: string; detail: string }> = {
  "repay-first": { label: "Repay first", detail: "Pay down debt from the reserve, then add collateral, and deleverage only if the reserve runs out." },
  "keep-exposure": { label: "Keep exposure", detail: "Add collateral first so the position keeps its size, then repay, then deleverage." },
  "deleverage-only": { label: "Deleverage only", detail: "Never spend the reserve: sell collateral to repay debt, in safe steps." },
};

export const STEP_UNIT: Record<string, string> = { repay: "USDC", add_collateral: "NEAR", deleverage: "NEAR", hl_reduce: "NEAR" };
