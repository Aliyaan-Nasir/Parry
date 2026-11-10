import { test } from "@playwright/test";
import { mockApi, seedAccount } from "./mock";
import { PAGES, THEMES, WIDTHS, isAppPage } from "./support";

// Full page screenshots of every page, width and theme for a visual review:
//   SCREENS=1 pnpm e2e screens
// Images land in test-results/screens/. App pages are captured twice: without an account, and
// with the fixture account watched (file names ending in "-account").
test.skip(process.env.SCREENS !== "1", "set SCREENS=1 to capture screenshots");

const fileName = (path: string) => (path === "/" ? "home" : path.startsWith("/app/positions/") ? "app-position" : path.slice(1).replaceAll("/", "-"));

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} ${width}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
      for (const { path } of PAGES) {
        const states = isAppPage(path) ? ([false, true] as const) : ([false] as const);
        for (const withAccount of states) {
          test(`${path}${withAccount ? " with an account" : ""}`, async ({ page }) => {
            await mockApi(page);
            if (withAccount) await seedAccount(page, "watch");
            await page.goto(path);
            await page.waitForLoadState("networkidle");
            await page.waitForTimeout(600);
            await page.screenshot({ path: `test-results/screens/${fileName(path)}-${width}-${theme}${withAccount ? "-account" : ""}.png`, fullPage: true });
          });
        }
      }
    });
  }
}
