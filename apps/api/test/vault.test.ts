import { describe, expect, test } from "bun:test";
import { depositStatus, type VaultStateView } from "../src/views";

const NEAR = 10n ** 24n;
const NOW = 1_794_670_000;

/** A vault_state view as the contract returns it: 100 NEAR staked (as LiNEAR at rate 2), cap 1000 NEAR. */
const state = (over: Partial<VaultStateView> = {}): VaultStateView => ({
  network: "testnet",
  paused: false,
  manual_paused: false,
  risk_paused: false,
  risk_score: 3,
  report_at: NOW - 120,
  staked_linear: (50n * NEAR).toString(),
  linear_rate_e24: (2n * NEAR).toString(),
  near_price_e8: "318845000",
  nav_e6: "545126352",
  share_price_e6: "970447",
  total_shares: "0",
  queued_shares: "0",
  hedge: { mark_e8: "318845000" },
  reserves: null,
  deposit_cap: (1000n * NEAR).toString(),
  min_deposit: (1n * NEAR).toString(),
  pending_deposit_near: "0",
  queue_length: 0,
  ...over,
});

describe("vault deposit availability, as the contract checks it", () => {
  test("open with a fresh report, room under the cap and the oracle at the mark", () => {
    const s = depositStatus(state(), NOW, 318_900_000);
    expect(s).toMatchObject({ depositsOpen: true, depositsClosedReason: null, depositsClosedBy: null, reportAgeSeconds: 120 });
    expect(BigInt(s.depositRoomNear)).toBe(900n * NEAR);
  });

  test("a report older than 15 minutes closes deposits, and says how old it is", () => {
    const s = depositStatus(state({ report_at: NOW - 27 * 60 }), NOW, 318_845_000);
    expect(s.depositsOpen).toBe(false);
    expect(s.depositsClosedBy).toBe("stale_report");
    expect(s.depositsClosedReason).toBe("the vault's report is 27 min old (the contract takes deposits only within 15 min of one); deposits reopen with the next report");
    expect(depositStatus(state({ report_at: NOW - 900 }), NOW).depositsOpen).toBe(true);
    expect(depositStatus(state({ report_at: NOW - 901 }), NOW).depositsOpen).toBe(false);
  });

  test("the owner's pause and the risk pause close deposits whatever the report", () => {
    expect(depositStatus(state({ paused: true, manual_paused: true }), NOW).depositsClosedBy).toBe("paused");
    const risk = depositStatus(state({ paused: true, risk_paused: true, risk_score: 82 }), NOW);
    expect(risk.depositsClosedBy).toBe("risk");
    expect(risk.depositsClosedReason).toContain("(82)");
  });

  test("no report, a full cap, no fresh oracle price or a price over 2% from the mark close deposits", () => {
    expect(depositStatus(state({ report_at: 0 }), NOW).depositsClosedBy).toBe("no_report");
    // 100 NEAR staked plus 899.5 pending leaves less than the 1 NEAR minimum.
    expect(depositStatus(state({ pending_deposit_near: ((8995n * NEAR) / 10n).toString() }), NOW).depositsClosedBy).toBe("cap");
    expect(depositStatus(state(), NOW, null).depositsClosedBy).toBe("no_price");
    const off = depositStatus(state(), NOW, 330_000_000);
    expect(off.depositsClosedBy).toBe("price_off_mark");
    expect(off.depositsClosedReason).toContain("3.5% from the hedge mark");
    expect(depositStatus(state(), NOW, 324_000_000).depositsOpen).toBe(true);
  });
});
