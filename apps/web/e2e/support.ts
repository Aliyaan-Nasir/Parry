import { expect, type Page, type ConsoleMessage } from "@playwright/test";

export const WIDTHS = [375, 768, 1440] as const;
export const THEMES = ["light", "dark"] as const;
export type ThemeName = (typeof THEMES)[number];

export const PAGES = [
  { path: "/", heading: "Liquidation, turned aside." },
  { path: "/legal/terms", heading: "Terms" },
  { path: "/legal/privacy", heading: "Privacy" },
  { path: "/legal/cookies", heading: "Cookies" },
  { path: "/legal/security", heading: "Security" },
  { path: "/app", heading: "Dashboard" },
  { path: "/app/open", heading: "Open position" },
  { path: "/app/protect", heading: "Protect" },
  { path: "/app/vault", heading: "Vault" },
  { path: "/app/portfolio", heading: "Portfolio" },
  { path: "/app/guardian", heading: "Guardian log" },
  { path: "/app/alerts", heading: "Alerts" },
  { path: "/app/settings", heading: "Settings" },
  { path: "/app/status", heading: "Status" },
  { path: "/app/shock", heading: "Market shock" },
] as const;

/** A well formed /v1/stats response for tests; never shown outside the test browser. */
export const STATS_FIXTURE = {
  network: "testnet",
  positionsProtected: 128,
  rescues: 17,
  vaultTvlUsd: 48250,
  vaultRiskScore: 22,
  updatedAt: new Date().toISOString(),
};

/** Answers the stats API from the fixture, so pages render without a running API. */
export async function mockStats(page: Page, mode: "ok" | "down" = "ok"): Promise<void> {
  await page.route("**/v1/stats", (route) =>
    mode === "ok"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STATS_FIXTURE) })
      : route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
}

/** Collects console errors and warnings plus uncaught page errors. */
export function watchConsole(page: Page, ignore: RegExp[] = []): () => string[] {
  const problems: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = `${msg.type()}: ${msg.text()}`;
    if (ignore.some((r) => r.test(text))) return;
    problems.push(text);
  };
  page.on("console", onConsole);
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  return () => problems;
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  expect(overflow.scroll, `page is ${overflow.scroll}px wide in a ${overflow.client}px viewport`).toBeLessThanOrEqual(overflow.client);
}
