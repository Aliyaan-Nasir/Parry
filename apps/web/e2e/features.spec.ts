import { expect, test } from "@playwright/test";
import * as fx from "./fixtures";
import { asPasskeyOwner, mockApi, relayedActions, seedAccount } from "./mock";
import { watchConsole } from "./support";

// The features the redesign added: public check and verify, crash replay, watched accounts,
// certificates, close and unwind, the cascade map, rates, the command palette and live updates.

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("public pages", () => {
  test("check reads any account's risk, and offers to watch it", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await page.goto("/check");
    await page.getByLabel(/NEAR account/).fill(fx.ACCOUNT);
    await page.getByRole("button", { name: /Check/ }).click();
    await expect(page).toHaveURL(new RegExp(`/check\\?account=${fx.ACCOUNT}`));
    await expect(page.getByRole("img", { name: /Health 1\.05, critical/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Watch/ })).toHaveAttribute("href", new RegExp(`/app/watched\\?add=${fx.ACCOUNT}`));
    expect(problems()).toEqual([]);
  });

  test("verify re-checks a health certificate by its hash", async ({ page }) => {
    await mockApi(page);
    const cert = fx.certificate(Date.now());
    await page.goto(`/verify?id=${cert.hash}`);
    await expect(page.getByText(/health is at least 1\.3/).first()).toBeVisible();
    await expect(page.getByText(/signed by ed25519:/).first()).toBeVisible();
  });

  test("verify re-checks a guardian decision through the log's own route", async ({ page }) => {
    const api = await mockApi(page);
    const id = fx.decisions(Date.now())[0]!.id;
    await page.goto(`/verify?id=${id}`);
    await expect.poll(() => api.requests.some((r) => r.path === `/v1/guardian/decisions/${id}/verify`)).toBe(true);
  });

  test("crash replay shows the summary, each crash and its sources", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await page.goto("/replay");
    await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: /9 May 2022/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("img", { name: /Health through the 9 May 2022/ })).toBeVisible();
    await page.getByRole("tab", { name: /21 May 2021/ }).click();
    await expect(page.getByRole("img", { name: /Health through the 21 May 2021/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Sources" }).getByText("Binance spot, hourly NEARUSDT")).toBeVisible();
    expect(problems()).toEqual([]);
  });
});

test.describe("watched accounts", () => {
  test("a link from a check fills the form; the table reads live risk and sorts", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await page.goto(`/app/watched?add=${fx.ACCOUNT}`);
    const form = page.getByRole("form", { name: "Watch an account" });
    await expect(form.getByLabel("NEAR account")).toHaveValue(fx.ACCOUNT);
    await form.getByLabel("Label (optional)").fill("Treasury");
    await form.getByRole("button", { name: "Watch" }).click();
    const table = page.getByRole("region", { name: "Watched accounts" });
    await expect(table.getByText(/Treasury, alerts at score 60/)).toBeVisible();
    await expect(table.getByText("Over threshold")).toBeVisible();
    await table.getByRole("button", { name: "Score" }).click();
    await expect(table.getByRole("columnheader", { name: "Score" })).toHaveAttribute("aria-sort", "descending");
    await table.getByRole("button", { name: `Stop watching ${fx.ACCOUNT}` }).click();
    await expect(page.getByText(/No accounts watched yet/)).toBeVisible();
    expect(problems()).toEqual([]);
  });

  test("the owner turns on alerts for the list with a passkey sign-in", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto(`/app/watched?add=${fx.ACCOUNT}`);
    await page.getByRole("form", { name: "Watch an account" }).getByRole("button", { name: "Watch" }).click();
    await page.getByRole("button", { name: "Turn on alerts for this list" }).click();
    await expect(page.getByText(/Alerts on: the API watches this list/)).toBeVisible({ timeout: 15_000 });
    expect(api.calls("PUT", `/v1/watch/${fx.ACCOUNT}`)).toHaveLength(1);
  });
});

test.describe("certificates", () => {
  test("the owner issues one for a named reader and it lists with a verify link", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    // A position comfortably above the 1.3 threshold (the fixture's own sits at 1.05).
    api.override("GET /v1/accounts/:id/positions", { body: fx.positions(Date.now()).map((p) => (p.venue === "rhea" ? { ...p, health: 1.62, tier: "safe" as const } : p)) });
    await page.goto("/app/certificates");
    await page.getByLabel("For whom").fill("lender.testnet");
    await page.getByRole("button", { name: "Issue" }).click();
    await expect(page.getByText(/Issued\./)).toBeVisible({ timeout: 15_000 });
    const body = api.calls("POST", "/v1/certificates")[0]!.body as { account: string; reader: string; threshold: number; anchor: boolean };
    expect(body).toMatchObject({ account: fx.ACCOUNT, reader: "lender.testnet", threshold: 1.3, anchor: true });
    const list = page.getByRole("region", { name: "Issued" });
    await expect(list.getByText("health is at least 1.3")).toBeVisible();
    await expect(list.getByRole("link", { name: "Verify" })).toHaveAttribute("href", /\/verify\?id=[0-9a-f]{64}/);
  });

  test("a threshold over the health now is refused before asking the enclave", async ({ page }) => {
    await asPasskeyOwner(page);
    await page.goto("/app/certificates");
    await page.getByLabel("For whom").fill("lender.testnet");
    const slider = page.getByRole("slider", { name: "Health at least" });
    await slider.focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: "Issue" })).toBeDisabled();
    await expect(page.getByText(/Health is below this threshold now/)).toBeVisible();
  });
});

test.describe("close and unwind", () => {
  test("closing sells collateral in one owner action with the exchange pool", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app?action=close");
    const dialog = page.getByRole("dialog", { name: /Close Rhea wNEAR\/USDC/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close the position" }).click();
    await expect.poll(() => relayedActions(api).length, { timeout: 15_000 }).toBe(1);
    expect(relayedActions(api)[0]).toEqual([{ close_rhea: { slippage_bps: 100, pool_id: 2939 } }]);
  });

  test("unwinding sends everything to the NEAR account the owner names", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app?action=unwind");
    const dialog = page.getByRole("dialog", { name: "Unwind the protected account" });
    await dialog.getByLabel("Send everything to").fill("owner.testnet");
    await dialog.getByRole("button", { name: "Unwind everything" }).click();
    await expect.poll(() => relayedActions(api).length, { timeout: 15_000 }).toBe(1);
    expect(relayedActions(api)[0]).toEqual([{ unwind: { tokens: [fx.CONTRACTS.usdc, fx.CONTRACTS.wnear], to: "owner.testnet" } }]);
  });

  test("cancelling leaves the dashboard and changes nothing", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app?action=unwind");
    await page.getByRole("dialog", { name: "Unwind the protected account" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/app$/);
    expect(relayedActions(api)).toHaveLength(0);
  });
});

test.describe("markets", () => {
  test("the cascade map reads mainnet and testnet borrowers and lists the chains", async ({ page }) => {
    const problems = watchConsole(page);
    const api = await mockApi(page);
    await page.goto("/app/cascade");
    await expect(page.getByRole("img", { name: /Collateral liquidated by NEAR price/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Cascade chains" }).getByText("$2.6M")).toBeVisible();
    await page.getByRole("radio", { name: "Testnet" }).click();
    await expect.poll(() => api.requests.some((r) => r.path === "/v1/heatmap" && r.query.network === "testnet")).toBe(true);
    await page.getByRole("radio", { name: "To -70%" }).click();
    expect(problems()).toEqual([]);
  });

  test("rates show Rhea per asset, funding and the vault's split, each with a source", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await page.goto("/app/rates");
    const rhea = page.getByRole("region", { name: "Rhea lending" });
    await expect(rhea.getByRole("row", { name: /USDC.*6\.12%.*8\.93%.*71\.0%/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Hyperliquid funding, NEAR" }).getByText("10.95%")).toBeVisible();
    await expect(page.getByRole("region", { name: /yield, split/ }).getByText("9.51%")).toBeVisible();
    await expect(page.getByText(/^Source: /).first()).toBeVisible();
    expect(problems()).toEqual([]);
  });
});

test.describe("command palette", () => {
  test("opens from the top bar, finds a page and goes there", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app");
    await page.getByRole("button", { name: /Search/ }).click();
    const palette = page.getByRole("dialog", { name: /Command/ });
    await palette.getByRole("combobox").fill("cascade");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/cascade$/);
  });

  test("Ctrl+K opens it and the g shortcuts jump between pages", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: /Command/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("r");
    await expect(page).toHaveURL(/\/app\/rates$/);
  });
});

test("live updates arrive over the event stream and show on the status page", async ({ page }) => {
  const api = await mockApi(page);
  await seedAccount(page, "watch");
  await page.goto("/app/status");
  await expect.poll(() => api.requests.some((r) => r.path === "/v1/stream" && r.query.account === fx.ACCOUNT)).toBe(true);
  const live = page.getByRole("region", { name: "Live updates" });
  await expect(live.getByText("Events received").locator("..").getByText(/^[1-9]\d*$/)).toBeVisible({ timeout: 15_000 });
  // On the alerts page, each alert event from the stream makes the alerts stale: they are read again.
  await page.goto("/app/alerts");
  await expect.poll(() => api.calls("GET", "/v1/alerts").length).toBeGreaterThan(0);
  const before = api.calls("GET", "/v1/alerts").length;
  await expect.poll(() => api.calls("GET", "/v1/alerts").length, { timeout: 15_000 }).toBeGreaterThan(before);
});
