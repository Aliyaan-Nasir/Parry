import { describe, expect, test } from "bun:test";
import live from "../fixtures/live-decisions.json";
import { isPublicPlan, publicPlan } from "../src/index";

// Plans in the exact formats enclave/src/modes.rs writes, and as stored by the live API.
const cases: { action: string; plan: string; public: string }[] = [
  {
    action: "repay",
    plan: "Repay 3.81 USDC from the reserve: health 1.122 to 1.450 (target 1.45). Chose repay: the first step in the order repay, add_collateral, deleverage, hl_reduce, evm_repay that the mandate allows and that moves health toward 1.45.",
    public: "Repay 3.81 USDC from the reserve.",
  },
  { action: "repay", plan: "Repay 0.63 USDC from the reserve: health 1.040 to 1.400 (target 1.40).", public: "Repay 0.63 USDC from the reserve." },
  {
    action: "add_collateral",
    plan: "Add 1.0000 wNEAR collateral from the reserve: health 1.036 to 1.382 (target 1.40). Chose add_collateral: the first step in the order add_collateral, repay, deleverage, hl_reduce, evm_repay that the mandate allows and that moves health toward 1.40.",
    public: "Add 1.0000 wNEAR collateral from the reserve.",
  },
  {
    action: "deleverage",
    plan: "Sell 0.3987 NEAR of collateral for at least 1.24 USDC and repay: health 1.170 to at least 1.291 (target 1.40). Chose deleverage: the first step in the order deleverage, hl_reduce, evm_repay that the mandate allows and that moves health toward 1.40. repay skipped: not granted by the mandate.",
    public: "Sell 0.3987 NEAR of collateral for at least 1.24 USDC and repay.",
  },
  {
    action: "hl_reduce",
    plan: "Reduce the Hyperliquid NEAR long by 3.5 (of 10.0), reduce-only, near the mark 2.4810 (sized to the target health): health 1.180, target 1.40. Chose hl_reduce: the first step in the order hl_reduce, deleverage that the mandate allows and that moves health toward 1.40.",
    public: "Reduce the Hyperliquid NEAR long by 3.5, reduce-only, near the mark 2.4810.",
  },
  {
    action: "hl_reduce",
    plan: "Reduce the Hyperliquid NEAR short by 1 (of 4.0), reduce-only, near the mark 2.5000 (the owner's fraction, as the venue gives no liquidation price to size from, capped by the guard): health 1.100, target 1.50.",
    public: "Reduce the Hyperliquid NEAR short by 1, reduce-only, near the mark 2.5000.",
  },
  {
    action: "evm_repay",
    plan: "Repay 0.81 of the Aave debt asset ($0.81) from the person's own address: health 1.151 to 1.400 (target 1.40).",
    public: "Repay 0.81 of the Aave debt asset ($0.81) from the person's own address.",
  },
  {
    action: "evm_approve",
    plan: "Approve the Aave pool to take up to 0.82 of the debt asset ($0.82) from the person's own address (the repay plus 1% for interest), so the next run can repay 0.81 ($0.81): health 1.151, target 1.40.",
    public: "Approve the Aave pool to take up to 0.82 of the debt asset ($0.82) from the person's own address, for the next repay.",
  },
  {
    action: "evm_approve",
    plan: "Approve the Aave pool to take up to 4.57 of the debt asset from the person's own address, so the next run can repay 0.81 (health 1.150, target 1.40).",
    public: "Approve the Aave pool to take up to 4.57 of the debt asset from the person's own address, for the next repay.",
  },
];

describe("public plans", () => {
  for (const c of cases) {
    test(`${c.action}: ${c.public}`, () => {
      const p = publicPlan(c.plan, c.action);
      expect(p).toBe(c.public);
      expect(p).not.toMatch(/target|trigger|order|health|Chose|skipped|1\.4[05]\b|1\.50\b/);
      expect(isPublicPlan(p)).toBe(true);
    });
  }

  test("a public plan the enclave wrote stays as it is", () => {
    for (const c of cases) expect(publicPlan(c.public, c.action)).toBe(c.public);
  });

  test("text that does not redact cleanly falls back to the action alone", () => {
    expect(publicPlan("Raise health to the owner's target of 1.45", "repay")).toBe("Repay debt from the reserve.");
    expect(publicPlan("", "unknown")).toBe("A guardian action within the owner's mandate.");
    expect(isPublicPlan("Repay 3.81 USDC from the reserve: health 1.122 to 1.450 (target 1.45).")).toBe(false);
  });
});

describe("public plans of the live decisions", () => {
  test("every stored plan redacts to its action alone", () => {
    for (const r of live.rows) {
      const p = publicPlan(r.plan, r.action);
      expect(isPublicPlan(p)).toBe(true);
      expect(r.plan.startsWith(p.replace(/, for the next repay\.$|\.$/, ""))).toBe(true);
    }
  });
});
