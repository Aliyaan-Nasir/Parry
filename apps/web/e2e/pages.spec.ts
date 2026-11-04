import { expect, test } from "@playwright/test";
import { PAGES, THEMES, WIDTHS, expectNoHorizontalScroll, mockStats, watchConsole } from "./support";

// Every page, at phone, tablet and desktop widths, in both themes: it renders its title, the
// theme follows the system, nothing logs an error or warning, and nothing scrolls sideways.
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme });

      for (const { path, heading } of PAGES) {
        test(`${path}`, async ({ page }) => {
          const problems = watchConsole(page);
          await mockStats(page);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.waitForLoadState("networkidle");
          await expectNoHorizontalScroll(page);
          // Scroll through the page so lazy effects and reveals run, then check again.
          await page.evaluate(async () => {
            const step = Math.max(200, window.innerHeight * 0.8);
            for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 40));
            }
          });
          await expectNoHorizontalScroll(page);
          expect(problems()).toEqual([]);
        });
      }
    });
  }
}

test("unknown pages render the not found page", async ({ page }) => {
  const problems = watchConsole(page, [/Failed to load resource: the server responded with a status of 404/]);
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "This page was turned aside." })).toBeVisible();
  expect(problems()).toEqual([]);
});
