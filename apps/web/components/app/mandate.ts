// The guardian's standing on an account, from the contract's `mandate()` view.

import type { MandateView, Strategy } from "@parry/sdk";
import type { BadgeTone } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/units";

export type MandateStatus = { key: "none" | "expired" | "paused" | "active"; label: string; tone: BadgeTone; detail: string };

export function mandateStatus(view: MandateView | null | undefined, nowSeconds: number): MandateStatus {
  if (!view) return { key: "none", label: "No mandate", tone: "neutral", detail: "The guardian cannot act on this account until a mandate is set." };
  if (view.expired || view.mandate.expires_at <= nowSeconds) {
    return { key: "expired", label: "Mandate expired", tone: "caution", detail: `Expired ${formatDateTime(view.mandate.expires_at)}. Set a new one to keep protection.` };
  }
  if (view.paused_until > nowSeconds) {
    return { key: "paused", label: "Guardian paused", tone: "caution", detail: `Paused until ${formatDateTime(view.paused_until)}.` };
  }
  return { key: "active", label: "Protected", tone: "safe", detail: `The mandate runs until ${formatDateTime(view.mandate.expires_at)}.` };
}

/** The guardian's default policy (docs/risk-model.md, section 9), used until the person picks their own. */
export const DEFAULT_POLICY: { triggerScore: number; triggerHealth: number; targetHealth: number; strategy: Strategy } = {
  triggerScore: 60,
  triggerHealth: 1.15,
  targetHealth: 1.45,
  strategy: "repay-first",
};
