import { afterEach, describe, expect, it, vi } from "vitest";

async function navFor(network: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_PARRY_NETWORK", network);
  return import("./nav");
}

describe("app navigation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists every page, Market shock included, on testnet, each in a group", async () => {
    const { NAV, GROUPS } = await navFor("testnet");
    expect(NAV.map((i) => i.href)).toEqual([
      "/app",
      "/app/portfolio",
      "/app/watched",
      "/app/open",
      "/app/protect",
      "/app/guardian",
      "/app/certificates",
      "/app/alerts",
      "/app/vault",
      "/app/rates",
      "/app/cascade",
      "/app/shock",
      "/app/status",
      "/app/settings",
    ]);
    expect(NAV.every((i) => (GROUPS as readonly string[]).includes(i.group))).toBe(true);
    // Every page shortcut is unique.
    const keys = NAV.flatMap((i) => (i.key ? [i.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("drops Market shock on mainnet", async () => {
    const { NAV } = await navFor("mainnet");
    expect(NAV.some((i) => i.href === "/app/shock")).toBe(false);
  });

  it("marks the active page", async () => {
    const { isActive } = await navFor("testnet");
    expect(isActive("/app", "/app")).toBe(true);
    expect(isActive("/app/vault", "/app")).toBe(false);
    expect(isActive("/app/vault", "/app/vault")).toBe(true);
  });
});
