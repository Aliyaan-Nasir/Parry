import { expect, type Page, type ConsoleMessage } from "@playwright/test";
import { ACCOUNT, POSITION_ID, POSITION_LABEL } from "./fixtures";

/** The protected account the fixtures describe. */
export const FIXTURE_ACCOUNT = ACCOUNT;

/** The fixture's critical Rhea position, as the app links to it. */
export const POSITION_PATH = `/app/positions/${encodeURIComponent(POSITION_ID)}`;

export const WIDTHS = [375, 768, 1440] as const;
export const THEMES = ["light", "dark"] as const;
export type ThemeName = (typeof THEMES)[number];

export const PAGES = [
  { path: "/", heading: "Liquidation, turned aside." },
  { path: "/legal/terms", heading: "Terms" },
  { path: "/legal/privacy", heading: "Privacy" },
  { path: "/legal/cookies", heading: "Cookies" },
  { path: "/legal/security", heading: "Security" },
  { path: "/check", heading: "Check any account." },
  { path: "/verify", heading: "Verify, don't trust." },
  { path: "/replay", heading: "Replayed through real crashes." },
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
  { path: "/app/watched", heading: "Watched accounts" },
  { path: "/app/certificates", heading: "Certificates" },
  { path: "/app/rates", heading: "Rates" },
  { path: "/app/cascade", heading: "Cascade map" },
  { path: POSITION_PATH, heading: POSITION_LABEL },
] as const;

/** App pages (under /app) render account data; the site pages do not. */
export const isAppPage = (path: string) => path === "/app" || path.startsWith("/app/");

/** A well formed /v1/stats response for tests; never shown outside the test browser. */
export const STATS_FIXTURE = {
  network: "testnet",
  positionsProtected: 128,
  positionsWatched: 3252,
  valueProtectedUsd: 184310.5,
  insuranceUsd: 7.73,
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

/**
 * Messages only `next dev` prints (a route compiled on demand renders without its server caches);
 * a production build never logs them, so a run against a dev server ignores them.
 */
const DEV_ONLY = [/cache-bypass-in-dev/];

/** Collects console errors and warnings plus uncaught page errors. */
export function watchConsole(page: Page, ignore: RegExp[] = []): () => string[] {
  const problems: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = `${msg.type()}: ${msg.text()}`;
    if ([...DEV_ONLY, ...ignore].some((r) => r.test(text))) return;
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
