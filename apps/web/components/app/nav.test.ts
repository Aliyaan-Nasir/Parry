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

  it("lists Market shock, tagged Testnet, on testnet", async () => {
    const { NAV } = await navFor("testnet");
    const shock = NAV.find((i) => i.href === "/app/shock");
    expect(shock?.tag).toBe("Testnet");
    expect(NAV.map((i) => i.href)).toEqual([
      "/app",
      "/app/open",
      "/app/protect",
      "/app/vault",
      "/app/portfolio",
      "/app/guardian",
      "/app/alerts",
      "/app/settings",
      "/app/status",
      "/app/shock",
    ]);
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
