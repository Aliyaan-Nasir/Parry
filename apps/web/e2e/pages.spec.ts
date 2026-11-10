import { expect, test, type Page } from "@playwright/test";
import { mockApi, seedAccount } from "./mock";
import { PAGES, THEMES, WIDTHS, expectNoHorizontalScroll, isAppPage, watchConsole } from "./support";

// Every page, at phone, tablet and desktop widths, in both themes, with the API answered from the
// fixtures: it renders its title, the theme follows the system, nothing logs an error or warning,
// and nothing scrolls sideways. App pages run twice: with no account, and with a watched one.

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
  });
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme });

      for (const { path, heading } of PAGES) {
        const states = isAppPage(path) ? (["no account", "an account"] as const) : (["no account"] as const);
        for (const state of states) {
          test(`${path} with ${state}`, async ({ page }) => {
            const problems = watchConsole(page);
            const api = await mockApi(page);
            if (state === "an account") await seedAccount(page, "watch");
            await page.goto(path);
            await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
            await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
            await page.waitForLoadState("networkidle");
            await expectNoHorizontalScroll(page);
            await scrollThrough(page);
            await expectNoHorizontalScroll(page);
            expect(api.unmatched, "API routes the mock does not know").toEqual([]);
            expect(problems()).toEqual([]);
          });
        }
      }
    });
  }
}

test("unknown pages render the not found page", async ({ page }) => {
  const problems = watchConsole(page, [/Failed to load resource: the server responded with a status of 404/]);
  await mockApi(page);
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "This page was turned aside." })).toBeVisible();
  expect(problems()).toEqual([]);
});
