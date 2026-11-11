import { expect, test } from "@playwright/test";
import { STATS_FIXTURE, mockStats, watchConsole } from "./support";

test.describe("theme", () => {
  test.use({ colorScheme: "light" });

  test("follows the system, toggles, and keeps the choice across reloads without a flash", async ({ page }) => {
    await mockStats(page);
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");

    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("parry-theme"))).toBe("dark");

    // The inline script sets the theme while the document is parsed, before first paint.
    await page.addInitScript(() => {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          (window as unknown as { __themeAtParse: string | undefined }).__themeAtParse = document.documentElement.dataset.theme;
        },
        { once: true },
      );
    });
    await page.reload();
    expect(await page.evaluate(() => (window as unknown as { __themeAtParse?: string }).__themeAtParse)).toBe("dark");
    await expect(html).toHaveAttribute("data-theme", "dark");

    await page.getByRole("radio", { name: "System" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("parry-theme"))).toBeNull();
  });
});

test.describe("live stats", () => {
  test("shows the API's figures", async ({ page }) => {
    await mockStats(page);
    await page.goto("/");
    const strip = page.getByRole("region", { name: /live/ });
    await expect(strip.getByText("$48.3K", { exact: true })).toBeAttached();
    await expect(strip.getByText("Vault size")).toBeAttached();
  });

  test("says so quietly when the API is unreachable, and shows no numbers", async ({ page }) => {
    const problems = watchConsole(page, [/Failed to load resource/]);
    await mockStats(page, "down");
    await page.goto("/");
    const strip = page.getByRole("region", { name: /live/ });
    await expect(strip.getByText("Live data unavailable right now.")).toBeVisible({ timeout: 15_000 });
    await expect(strip.locator("dl")).not.toContainText(/\d/);
    expect(problems()).toEqual([]);
  });
});

test.describe("motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the hero shows its full still frame under reduced motion", async ({ page }) => {
    await mockStats(page);
    await page.goto("/");
    const svg = page.locator("svg.hero-deflection");
    await expect(svg).toHaveAttribute("data-anim", "still");
    const opacity = await svg.locator('[data-part="recovery"]').evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe("1");
  });
});

test.describe("keyboard", () => {
  test("skip link, FAQ disclosure and focus ring", async ({ page }) => {
    await mockStats(page);
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    const outline = await skip.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe("solid");

    const question = page.getByRole("button", { name: "Can Parry move my money out?" });
    await question.focus();
    await expect(question).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(question).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("region", { name: "Can Parry move my money out?" })).toContainText("The guardian can only repay");
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test("the app menu opens as a sheet and closes with Escape", async ({ page }) => {
      await page.goto("/app");
      await page.getByRole("button", { name: "More", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "All pages" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("link", { name: /Market shock/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });
  });
});

test("security headers are sent", async ({ request }) => {
  const res = await request.get("/");
  const headers = res.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toContain("https://*.hot-labs.org");
  expect(headers["x-powered-by"]).toBeUndefined();
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

test("the testnet build lists Market shock with its Testnet tag", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  const link = page.getByRole("navigation", { name: "App" }).getByRole("link", { name: /Market shock/ });
  await expect(link).toBeVisible();
  await expect(link).toContainText("Testnet");
});
