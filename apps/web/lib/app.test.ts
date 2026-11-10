import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { compressedPasskey, toHex } from "@parry/sdk";
import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";
import { hyperliquidAddressUrl, nearAccountUrl } from "./explorer";
import { formatMoney } from "./money";
import { recoverCandidates } from "./passkey";
import { formatDuration, formatHealth, formatProbability, fromUnits, shortId, toUnits, unitsToNumber } from "./units";

describe("units", () => {
  it("formats health, never rounding a liquidatable position up to 1.00", () => {
    expect(formatHealth(1.0454)).toBe("1.05");
    expect(formatHealth(0.9999)).toBe("0.99");
    expect(formatHealth(null)).toBe("No debt");
    expect(formatHealth(Number.POSITIVE_INFINITY)).toBe("No debt");
  });

  it("formats durations and probabilities at their edges", () => {
    expect(formatDuration(0.0076)).toBe("under 1 min");
    expect(formatDuration(0.5)).toBe("30 min");
    expect(formatDuration(3.4)).toBe("3.4 h");
    expect(formatDuration(72)).toBe("3 days");
    expect(formatDuration(null)).toBe("more than 30 days");
    expect(formatDuration(1000)).toBe("more than 30 days");
    expect(formatProbability(0.9999999)).toBe("over 99.9%");
    expect(formatProbability(0.0004)).toBe("under 0.1%");
    expect(formatProbability(0.209)).toBe("20.9%");
  });

  it("converts token amounts exactly", () => {
    expect(toUnits("12.5", 24)).toBe(12_500_000_000_000_000_000_000_000n);
    expect(toUnits("0.000001", 6)).toBe(1n);
    expect(toUnits("1.0000001", 6)).toBeNull();
    expect(toUnits("-1", 6)).toBeNull();
    expect(toUnits("1e3", 6)).toBeNull();
    expect(fromUnits("1500000000000000000000000000", 24)).toBe("1,500");
    expect(fromUnits("54404724", 6, 2)).toBe("54.4");
    expect(unitsToNumber("2500000", 6)).toBe(2.5);
    expect(shortId("0uwgjhgwzd2k6j8qht2ywwzqn2f8p90h5qzyp5zfd85cgjswa1cnj0")).toBe("0uwgjhgw...a1cnj0");
  });
});

describe("money", () => {
  it("converts USD at the rate and falls back to USD without one", () => {
    expect(formatMoney(2.8612, "USD", null)).toBe("$2.86");
    expect(formatMoney(2.8612, "EUR", 0.9)).toBe("€2.58");
    expect(formatMoney(2.8612, "EUR", null)).toBe("$2.86");
    expect(formatMoney(1000, "JPY", 158)).toBe("¥158,000");
    expect(formatMoney(48_250, "USD", null, { compact: true })).toBe("$48.3K");
    expect(formatMoney(182.4, "USD", null, { signed: true })).toBe("+$182.40");
    expect(formatMoney(-61.2, "USD", null, { signed: true })).toBe("-$61.20");
    expect(formatMoney(Number.NaN, "USD", null)).toBe("n/a");
  });
});

describe("explorer links", () => {
  it("links accounts and Hyperliquid addresses, refusing anything else", () => {
    expect(nearAccountUrl("alice.testnet")).toBe("https://testnet.nearblocks.io/address/alice.testnet");
    expect(nearAccountUrl("javascript:alert(1)")).toBeNull();
    const a = `0x${"ab".repeat(20)}`;
    expect(hyperliquidAddressUrl(a)).toBe(`https://app.hyperliquid-testnet.xyz/explorer/address/${a}`);
    expect(hyperliquidAddressUrl("0x12")).toBeNull();
  });
});

describe("content security policy", () => {
  it("allows a local RPC only when configured, and keeps upgrading https", () => {
    const local = buildCsp({ apiUrl: "http://localhost:4000", rpcUrl: "http://127.0.0.1:3030" });
    expect(local).toContain("http://127.0.0.1:3030");
    expect(local).not.toContain("upgrade-insecure-requests");
    const prod = buildCsp({ apiUrl: "https://api.parry.example" });
    expect(prod).not.toContain("127.0.0.1");
    expect(prod).toContain("upgrade-insecure-requests");
    expect(prod).toContain("https://wallet.intear.tech");
  });
});

describe("passkey recovery", () => {
  it("one of the two candidate keys of a P-256 signature is the signer's", () => {
    const secret = sha256(new TextEncoder().encode("parry-unit:passkey"));
    const digest = sha256(new TextEncoder().encode("a WebAuthn signed message"));
    const der = p256.sign(digest, secret, { prehash: false, format: "der" });
    const candidates = recoverCandidates(digest, der);
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain(compressedPasskey(toHex(p256.getPublicKey(secret, true))));
  });
});
