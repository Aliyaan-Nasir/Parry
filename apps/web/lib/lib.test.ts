import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import tokens from "@parry/brand";
import { buildCsp, originOf } from "./csp";
import { explorerUrl, isTxHash } from "./explorer";
import { formatInteger, formatRelativeTime, formatUsdCompact } from "./format";
import { clampScore, tierFromScore } from "./risk";
import { parseStats } from "./stats";
import { parsePreference, resolveTheme, themeScript } from "./theme";
import { sparklinePath } from "@/components/ui/Sparkline";
import { withAlpha } from "@/components/ui/Chart";

describe("risk tiers", () => {
  it("maps scores to tiers at 25, 50 and 75", () => {
    expect(tierFromScore(0)).toBe("safe");
    expect(tierFromScore(24.9)).toBe("safe");
    expect(tierFromScore(25)).toBe("caution");
    expect(tierFromScore(49.9)).toBe("caution");
    expect(tierFromScore(50)).toBe("danger");
    expect(tierFromScore(75)).toBe("critical");
    expect(tierFromScore(100)).toBe("critical");
  });

  it("clamps out of range and non finite scores", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(140)).toBe(100);
    expect(clampScore(Number.NaN)).toBe(0);
    expect(tierFromScore(Number.POSITIVE_INFINITY)).toBe("safe");
  });
});

describe("explorer links", () => {
  it("builds testnet explorer URLs", () => {
    const near = "6xBqLzB8wqm2Z3UqfH1cX9tE4gD3sQy7rK5vN8pJ2aL1";
    expect(explorerUrl("nearblocks", near)).toBe(`https://testnet.nearblocks.io/txns/${near}`);
    const hl = "0x" + "ab".repeat(32);
    expect(explorerUrl("hyperliquid", hl)).toBe(`https://app.hyperliquid-testnet.xyz/explorer/tx/${hl}`);
    expect(explorerUrl("intents", near)).toBe(`https://explorer.near-intents.org/transactions/${near}`);
  });

  it("refuses anything that is not a transaction hash", () => {
    expect(isTxHash("javascript:alert(1)")).toBe(false);
    expect(explorerUrl("nearblocks", "../../evil")).toBeNull();
    expect(explorerUrl("nearblocks", "")).toBeNull();
  });
});

describe("stats parsing", () => {
  const good = {
    network: "testnet",
    positionsProtected: 3,
    rescues: 1,
    vaultTvlUsd: 1200.5,
    vaultRiskScore: 40,
    updatedAt: "2026-11-10T12:00:00Z",
  };

  it("accepts a well formed response", () => {
    expect(parseStats(good)).toEqual(good);
  });

  it("treats malformed responses as unavailable", () => {
    expect(parseStats(null)).toBeNull();
    expect(parseStats({ ...good, rescues: "1" })).toBeNull();
    expect(parseStats({ ...good, vaultRiskScore: 101 })).toBeNull();
    expect(parseStats({ ...good, vaultRiskScore: null })).toEqual({ ...good, vaultRiskScore: null });
    expect(parseStats({ ...good, positionsProtected: -1 })).toBeNull();
    expect(parseStats({ ...good, updatedAt: "yesterday" })).toBeNull();
  });
});

describe("formatting", () => {
  it("formats figures", () => {
    expect(formatInteger(1234.6)).toBe("1,235");
    expect(formatUsdCompact(950)).toBe("$950");
    expect(formatUsdCompact(12_400)).toBe("$12.4K");
    expect(formatUsdCompact(3_200_000)).toBe("$3.2M");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(formatRelativeTime("2026-11-10T11:59:40Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-11-10T11:56:00Z", now)).toBe("4 min ago");
    expect(formatRelativeTime("2026-11-10T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});

describe("theme", () => {
  it("resolves the preference against the system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(parsePreference("dark")).toBe("dark");
    expect(parsePreference("blue")).toBe("system");
    expect(parsePreference(null)).toBe("system");
  });

  it("ships an inline script that is valid JavaScript", () => {
    expect(() => new Function(themeScript)).not.toThrow();
  });

  it("mirrors every brand token in tokens.css", () => {
    const css = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8").toLowerCase();
    const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const mode of ["light", "dark"] as const) {
      for (const [key, value] of Object.entries(tokens[mode])) {
        expect(css, `${mode}.${key}`).toContain(`--parry-${kebab(key)}: ${String(value).toLowerCase()};`);
      }
    }
  });
});

describe("content security policy", () => {
  it("allows the API origin, NEAR RPC, Hyperliquid testnet and wallet frames", () => {
    const csp = buildCsp({ apiUrl: "https://api.example.org/base/" });
    expect(csp).toContain("connect-src 'self' https://api.example.org ");
    expect(csp).toContain("https://*.fastnear.com");
    expect(csp).toContain("https://rpc.testnet.near.org");
    expect(csp).toContain("https://api.hyperliquid-testnet.xyz");
    expect(csp).toContain("frame-src https://*.hot-labs.org https://*.herewallet.app");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("adds eval only in development and skips the upgrade for a plain http API", () => {
    expect(buildCsp({ dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp({ apiUrl: "http://localhost:4000" })).not.toContain("upgrade-insecure-requests");
  });

  it("ignores malformed API URLs", () => {
    expect(originOf("not a url")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("drawing helpers", () => {
  it("draws a sparkline only with two or more points", () => {
    expect(sparklinePath([], 100, 20, 1)).toBe("");
    expect(sparklinePath([5], 100, 20, 1)).toBe("");
    expect(sparklinePath([1, 2, 3], 100, 20, 1)).toMatch(/^M1\.00 19\.00 L50\.00 10\.00 L99\.00 1\.00$/);
  });

  it("adds alpha to hex colors", () => {
    expect(withAlpha("#D9B160", 0.5)).toBe("rgba(217, 177, 96, 0.5)");
    expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBe("rgb(1, 2, 3)");
  });
});
