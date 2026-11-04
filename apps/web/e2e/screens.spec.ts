import { test } from "@playwright/test";
import { PAGES, THEMES, WIDTHS, mockStats } from "./support";

// Full page screenshots of every page, width and theme for a visual review:
//   SCREENS=1 pnpm e2e screens
// Images land in test-results/screens/.
test.skip(process.env.SCREENS !== "1", "set SCREENS=1 to capture screenshots");

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} ${width}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
      for (const { path } of PAGES) {
        test(path, async ({ page }) => {
          await mockStats(page);
          await page.goto(path);
          await page.waitForLoadState("networkidle");
          await page.waitForTimeout(400);
          const name = path === "/" ? "home" : path.slice(1).replaceAll("/", "-");
          await page.screenshot({ path: `test-results/screens/${name}-${width}-${theme}.png`, fullPage: true });
        });
      }
    });
  }
}
