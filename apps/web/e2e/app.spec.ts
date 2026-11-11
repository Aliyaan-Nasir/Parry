import { expect, test, type Page } from "@playwright/test";
import { openPolicy } from "@parry/sdk";
import * as fx from "./fixtures";
import { addVirtualAuthenticator, asPasskeyOwner, mockApi, relayedActions, seedAccount } from "./mock";
import { POSITION_PATH, watchConsole } from "./support";

// What each app page does with the API mocked: real figures from the fixtures, the owner's
// actions signed with a passkey in Chromium's virtual authenticator, and plain errors.

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("dashboard", () => {
  test("shows the account's positions, the market, alerts and guardian actions", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app");
    const market = page.getByRole("region", { name: "Market" });
    await expect(market.getByText("$2.86", { exact: true })).toBeVisible();
    const positions = page.getByRole("region", { name: "Positions" });
    await expect(positions.getByRole("link", { name: /Rhea wNEAR\/USDC/ })).toBeVisible();
    // The tier is a plain word on the card's instrument.
    await expect(positions.getByRole("img", { name: /Health 1\.05, critical/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Alerts" }).getByText(/health 1.05/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Guardian actions" }).getByText(/Repay on Rhea/).first()).toBeVisible();
    await positions.getByRole("link", { name: /Rhea wNEAR\/USDC/ }).click();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(fx.POSITION_ID).replace(/%/g, "%")));
    await expect(page.getByRole("heading", { level: 1, name: "Rhea wNEAR/USDC" })).toBeVisible();
    expect(problems()).toEqual([]);
  });

  test("without an account, offers a wallet or a passkey account", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app");
    const card = page.getByRole("region", { name: "Connect an account to see your positions" });
    await expect(card.getByRole("button", { name: "Connect a wallet" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Create a passkey account" })).toBeVisible();
  });

  test("says plainly when the API is down, and shows no figures", async ({ page }) => {
    const problems = watchConsole(page, [/Failed to load resource/]);
    await mockApi(page, { api: "down" });
    await seedAccount(page, "watch");
    await page.goto("/app");
    await expect(page.getByRole("alert").filter({ hasText: "Market data is unavailable" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("alert").filter({ hasText: "Your account could not be loaded" })).toBeVisible();
    expect(problems()).toEqual([]);
  });

  test("an empty account says what to do next", async ({ page }) => {
    await mockApi(page, { api: "empty" });
    await seedAccount(page, "watch");
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "No positions yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open a protected position" })).toBeVisible();
  });
});

test.describe("position", () => {
  test("history tabs, the score's parts and the verified copilot", async ({ page }) => {
    const problems = watchConsole(page);
    const api = await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto(POSITION_PATH);
    await expect(page.getByRole("heading", { level: 1, name: "Rhea wNEAR/USDC" })).toBeVisible();
    await expect(page.getByText("Liquidation within 24 h")).toBeVisible();
    await expect(page.getByRole("img", { name: "Health over the last 24 hours" })).toBeVisible();
    await page.getByRole("radio", { name: "7 days" }).click();
    await expect(page.getByRole("img", { name: "Health over the last 168 hours" })).toBeVisible();
    await expect.poll(() => api.requests.some((r) => r.path.includes("/history") && r.query.hours === "168")).toBe(true);
    await expect(page.getByRole("img", { name: "NEAR price", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Collateral liquidated by NEAR price/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Score and its parts" }).getByText("Liquidation probability")).toBeVisible();
    await page.getByRole("button", { name: "Explain" }).click();
    const copilot = page.getByRole("region", { name: "Risk copilot" });
    await expect(copilot.getByText("Verified", { exact: true })).toBeVisible();
    await expect(copilot.getByRole("link", { name: /Check the model on NEAR AI/ })).toHaveAttribute("href", "https://cloud.near.ai/verify");
    expect(problems()).toEqual([]);
  });

  test("a closed position says so", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto(`/app/positions/${encodeURIComponent(`${fx.ACCOUNT}:rhea:gone`)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Position not found" })).toBeVisible();
  });
});

test.describe("open a position", () => {
  test("previews health with the risk model and runs every step with the passkey", async ({ page }) => {
    const problems = watchConsole(page);
    const api = await asPasskeyOwner(page);
    // A fresh account: the preview then covers the new position alone.
    api.override("GET /v1/accounts/:id", { body: fx.accountSummary(Date.now(), { ownerKind: "passkey", empty: true }) });
    await page.goto("/app/open");
    await page.getByLabel("NEAR to deposit").fill("10");
    const preview = page.getByRole("complementary", { name: "Preview" });
    await expect(preview.getByText(/USDC$/).first()).toBeVisible();
    const slider = page.getByRole("slider", { name: "Leverage" });
    await slider.focus();
    await page.keyboard.press("End");
    await expect(preview.getByRole("img", { name: /^Health after opening 1\.1\d,/ })).toBeVisible();
    await page.keyboard.press("Home");
    await expect(preview.getByRole("img", { name: /^Health after opening (2\.9\d|3\.00),/ })).toBeVisible();
    await page.getByRole("button", { name: "Open position" }).click();
    const steps = page.getByRole("list", { name: "Opening steps" });
    await expect(steps.getByText("Set the default mandate: Done")).toBeAttached({ timeout: 20_000 });
    const actions = relayedActions(api);
    expect(actions.map((a) => Object.keys(a[0] as object)[0])).toEqual(["call", "supply", "borrow", "set_mandate"]);
    const mandate = (actions[3]![0] as { set_mandate: { mandate: { sealed: string; powers: string[] } } }).set_mandate.mandate;
    expect(mandate.powers).toEqual(["repay", "add_collateral", "deleverage"]);
    expect(openPolicy(mandate.sealed, { account: fx.ACCOUNT, secret: fx.SEALING_SECRET })).toMatchObject({ triggerScore: 60, triggerHealth: 1.15, targetHealth: 1.45, strategy: "repay-first" });
    expect(problems()).toEqual([]);
  });

  test("a watched account cannot open", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/open");
    await expect(page.getByRole("button", { name: "Open position" })).toBeDisabled();
  });
});

test.describe("protect", () => {
  test("shows the mandate's live counters, the simulation and the routes", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/protect");
    const current = page.getByRole("region", { name: "Current mandate" });
    await expect(current.getByText("Protected", { exact: true })).toBeVisible();
    await expect(current.getByText("Sealed to the enclave")).toBeVisible();
    await expect(page.getByRole("region", { name: "If the guardian looked now" }).getByText("Would act")).toBeVisible();
    await expect(page.getByRole("region", { name: "Rescue route" }).getByText("Chosen")).toBeVisible();
    await expect(page.getByText(/dry-run quote from the mainnet 1Click API/).first()).toBeVisible();
  });

  test("seals the chosen policy to the enclave and sets the mandate with the passkey", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app/protect");
    const builder = page.getByRole("region", { name: "Replace the mandate" }).or(page.getByRole("region", { name: "Change the mandate" }));
    await expect(builder).toBeVisible();
    await builder.getByRole("radio", { name: /Keep exposure/ }).check();
    const score = builder.getByRole("slider", { name: "Act at score" });
    await score.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Replace the mandate" }).click();
    await expect.poll(() => relayedActions(api).length, { timeout: 15_000 }).toBe(1);
    const mandate = (relayedActions(api)[0]![0] as { set_mandate: { mandate: { sealed: string; guardian_key: string } } }).set_mandate.mandate;
    expect(mandate.guardian_key).toBe(fx.ENCLAVE_PUBLIC_KEY);
    expect(openPolicy(mandate.sealed, { account: fx.ACCOUNT, secret: fx.SEALING_SECRET })).toMatchObject({ triggerScore: 65, strategy: "keep-exposure" });
  });

  test("orders the steps by keyboard and drag, previews them, and seals the order", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app/protect");
    const builder = page.getByRole("region", { name: "Change the mandate" });
    await expect(builder).toBeVisible();
    const order = builder.getByRole("list", { name: "Order of steps" });
    // Keyboard: deleverage moves from third to first.
    const grip = order.getByRole("button", { name: /^Move Deleverage/ });
    await grip.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(order.getByRole("button", { name: /^Move Deleverage, position 1 of 5/ })).toBeFocused();
    // Drag: add collateral (now third) goes above repay (second).
    const add = order.getByRole("button", { name: /^Move Add collateral/ });
    const repay = order.getByRole("button", { name: /^Move Repay debt/ });
    const from = (await add.boundingBox())!;
    const to = (await repay.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 - 6, { steps: 8 });
    await page.mouse.up();
    await expect(order.getByRole("button", { name: /^Move Add collateral, position 2 of 5/ })).toBeVisible();
    await expect(builder.getByText(/Your own order/)).toBeVisible();
    await expect(builder.getByRole("complementary", { name: "Preview" }).getByText(/the guardian would act now|It waits/)).toBeVisible();
    await page.getByRole("button", { name: "Replace the mandate" }).click();
    await expect.poll(() => relayedActions(api).length, { timeout: 15_000 }).toBe(1);
    const mandate = (relayedActions(api)[0]![0] as { set_mandate: { mandate: { sealed: string } } }).set_mandate.mandate;
    expect(openPolicy(mandate.sealed, { account: fx.ACCOUNT, secret: fx.SEALING_SECRET })).toMatchObject({ steps: ["deleverage", "add_collateral", "repay"] });
  });

  test("revoking asks first", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app/protect");
    await page.getByRole("button", { name: "Revoke the mandate" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke the mandate?" });
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Revoke the mandate" }).click();
    await page.getByRole("dialog", { name: "Revoke the mandate?" }).getByRole("button", { name: "Revoke", exact: true }).click();
    await expect.poll(() => relayedActions(api)[0]?.[0]).toBe("revoke_mandate");
  });
});

test.describe("vault", () => {
  test("hedge, last order and a proof of reserves checked in the browser", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/vault");
    await expect(page.getByRole("region", { name: "Overview" }).getByText("22 of 100, low")).toBeVisible();
    const hedge = page.getByRole("region", { name: "Hedge" });
    await expect(hedge.getByText("Sell 163.0 NEAR at $2.86")).toBeVisible();
    await expect(hedge.getByRole("link", { name: /NEAR transaction/ })).toHaveAttribute("href", /testnet\.nearblocks\.io\/txns\//);
    await expect(hedge.getByRole("link", { name: /Explorer/ })).toHaveAttribute("href", /hyperliquid-testnet\.xyz\/explorer\/address\/0x/);
    const reserves = page.getByRole("region", { name: "Proof of reserves" });
    await reserves.getByRole("button", { name: "Verify" }).click();
    await expect(reserves.getByText("The reserves check out")).toBeVisible();
    await expect(reserves.getByText("4 of 4 leaf proofs verify against the root.")).toBeVisible();
    await expect(reserves.getByText("The root equals the one the vault contract holds.")).toBeVisible();
    await expect(page.getByText(/operator-funded test USDC/)).toBeVisible();
    expect(problems()).toEqual([]);
  });

  test("deposits from the protected account with the passkey", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app/vault");
    await page.getByLabel("Amount").fill("2");
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect.poll(() => relayedActions(api).length, { timeout: 15_000 }).toBe(1);
    const call = (relayedActions(api)[0]![0] as { call: { receiver_id: string; method_name: string; deposit: string } }).call;
    expect(call).toMatchObject({ receiver_id: fx.CONTRACTS.vault, method_name: "deposit", deposit: "2000000000000000000000000" });
  });

  test("a hedge short of margin shows the 1Click top-up route", async ({ page }) => {
    const v = fx.vault(Date.now());
    await mockApi(page, {
      overrides: {
        "GET /v1/vault": { body: { ...v, hedge: { ...v.hedge, needsMargin: true, marginRoute: { amountUsd: 1200, outUsd: 1197.6, unavailable: null, at: new Date().toISOString() } } } },
      },
    });
    await page.goto("/app/vault");
    const hedge = page.getByRole("region", { name: "Hedge" });
    await expect(hedge.getByText("Needs margin")).toBeVisible();
    await expect(hedge.getByText(/\$1,200 USDC on NEAR/)).toBeVisible();
    await expect(hedge.getByText(/\$1,198 on HyperCore/)).toBeVisible();
  });

  test("before the first report the vault says so", async ({ page }) => {
    await mockApi(page, { api: "empty" });
    await page.goto("/app/vault");
    await expect(page.getByText("No order yet")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "The reserves report could not be loaded" })).toBeVisible();
  });
});

test("portfolio shows totals and the vault value", async ({ page }) => {
  await mockApi(page);
  await seedAccount(page, "watch");
  await page.goto("/app/portfolio");
  await expect(page.getByText("Equity")).toBeVisible();
  await expect(page.getByText("1,500 EARN")).toBeVisible();
  await expect(page.getByRole("table", { name: "Positions in this portfolio" })).toBeVisible();
});

test.describe("guardian log", () => {
  test("verifies a decision in the browser and shows the EVM rescue's MPC verification", async ({ page }) => {
    const problems = watchConsole(page);
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/guardian");
    const first = page.getByRole("article").first();
    await expect(first.getByRole("heading", { name: /Repay on Rhea/ })).toBeVisible();
    await first.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(first.getByText("6 of 6 checks pass")).toBeVisible();
    const evm = page.getByRole("article").filter({ has: page.getByRole("heading", { name: /Repay on Aave/ }) });
    // Older decisions are one-line rows that open into the full record.
    await evm.getByRole("button", { expanded: false }).click();
    await expect(evm.getByText("Verified by the NEAR MPC network")).toBeVisible();
    await expect(evm.getByRole("link", { name: /Repay on Base Sepolia/ })).toHaveAttribute("href", /sepolia\.basescan\.org\/tx\/0x/);
    await expect(evm.getByRole("link", { name: /Verification on NearBlocks/ })).toHaveAttribute("href", /nearblocks\.io\/txns\//);
    const rejected = page.getByRole("article").filter({ hasText: "Rejected by review" });
    await rejected.getByRole("button", { expanded: false }).click();
    await expect(rejected.getByText("Chosen", { exact: true })).toBeVisible();
    expect(problems()).toEqual([]);
  });

  test("a tampered review fails its checks", async ({ page }) => {
    await mockApi(page, { overrides: { "GET /v1/guardian/decisions": { body: { items: [fx.tamperedDecision(Date.now())], next: null } } } });
    await page.goto("/app/guardian");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(page.getByText("Verification failed")).toBeVisible();
  });

  test("a link to one decision opens it", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/guardian");
    const evm = page.getByRole("article").filter({ has: page.getByRole("heading", { name: /Repay on Aave/ }) });
    const id = (await evm.getAttribute("id"))!.slice(2);
    await page.goto(`/app/guardian?decision=${id}`);
    await expect(page.locator(`#d-${id}`).getByText("Verified by the NEAR MPC network")).toBeVisible();
  });
});

test.describe("alerts", () => {
  test("the owner signs in with the passkey to acknowledge", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app/alerts");
    const first = page.getByRole("region", { name: "Alerts" }).getByRole("listitem").first();
    await first.getByRole("button", { name: "Acknowledge" }).click();
    await expect.poll(() => api.calls("POST", "/v1/auth/verify").length).toBe(1);
    await page.getByRole("radio", { name: "Acknowledged" }).click();
    await expect(page.getByRole("region", { name: "Alerts" }).getByText("Acknowledged", { exact: true }).first()).toBeVisible();
  });

  test("watching shows them read-only", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/alerts");
    await expect(page.getByRole("button", { name: "Acknowledge" }).first()).toBeDisabled();
  });
});

test.describe("settings", () => {
  test("the display currency applies to every figure", async ({ page }) => {
    await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/settings");
    await page.getByLabel("Currency", { exact: true }).selectOption("EUR");
    await expect(page.getByText(/1 USD = 0\.\d+ EUR/)).toBeVisible();
    await page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("region", { name: "Market" }).getByText(/^€2\.\d\d$/)).toBeVisible();
  });

  test("thresholds are saved after a passkey sign-in", async ({ page }) => {
    const api = await asPasskeyOwner(page);
    await page.goto("/app/settings");
    const slider = page.getByRole("slider", { name: "Risk score" });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Save thresholds" }).click();
    await expect.poll(() => api.calls("PUT", `/v1/settings/${fx.ACCOUNT}`).length, { timeout: 15_000 }).toBe(1);
    expect((api.calls("PUT", `/v1/settings/${fx.ACCOUNT}`)[0]!.body as { thresholds: { score: number } }).thresholds.score).toBe(55);
  });
});

test("status lists services, the oracle, lanes and the treasury", async ({ page }) => {
  await mockApi(page);
  await page.goto("/app/status");
  await expect(page.getByRole("region", { name: "Services" }).getByText(/down$/).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Oracle" }).getByText("Fresh", { exact: true })).toBeVisible();
  const treasury = page.getByRole("region", { name: "Treasury" });
  await expect(treasury.getByRole("meter").first()).toBeVisible();
  await expect(treasury.getByText("Post-quantum key (ML-DSA-65)")).toBeVisible();
  await expect(treasury.getByText("monitor gas key")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Gas-key lanes" }).getByText("4.60 NEAR prepaid gas")).toBeVisible();
});

test.describe("market shock", () => {
  test("moves the price, explains the rate limit, and clears", async ({ page }) => {
    const problems = watchConsole(page, [/Failed to load resource: the server responded with a status of 400/]);
    const api = await mockApi(page);
    await seedAccount(page, "watch");
    await page.goto("/app/shock");
    await expect(page.getByRole("region", { name: "Test oracle" }).getByText("Shock -20%")).toBeVisible();
    await expect(page.getByText("The oracle bounds a shock at 40% either way.")).toBeVisible();
    await page.getByRole("button", { name: "Replace the shock" }).click();
    await expect(page.getByRole("status").filter({ hasText: "NEAR moved -20% on the test oracle" })).toBeVisible();
    await page.getByRole("button", { name: "Replace the shock" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /one shock a minute: try again in \d+ s/ })).toBeVisible();
    await page.getByRole("button", { name: "Clear the shock" }).click();
    await expect(page.getByRole("region", { name: "Test oracle" }).getByText("No shock")).toBeVisible();
    expect(api.calls("POST", "/v1/shock").map((r) => (r.body as { bps: number }).bps)).toEqual([-2000, -2000, 0]);
    await expect(page.getByRole("region", { name: "Your position, live" })).toBeVisible();
    expect(problems()).toEqual([]);
  });
});

test.describe("connecting", () => {
  test("watch an account from the connect dialog, then stop", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app");
    await page.getByRole("banner").getByRole("button", { name: "Connect" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect to Parry" });
    await dialog.getByLabel("Protected account address").fill(fx.ACCOUNT);
    await dialog.getByRole("button", { name: "View" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Positions" })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: /0uwg/ }).click();
    const menu = page.getByRole("dialog", { name: "Your account" });
    await expect(menu.getByRole("link", { name: /NearBlocks/ })).toHaveAttribute("href", `https://testnet.nearblocks.io/address/${fx.ACCOUNT}`);
    await menu.getByRole("button", { name: "Stop watching" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Connect an account to see your positions" })).toBeVisible();
  });

  test("creates a passkey account without gas", async ({ page }) => {
    const api = await mockApi(page);
    await addVirtualAuthenticator(page);
    await page.goto("/app");
    await page.getByRole("region", { name: "Connect an account to see your positions" }).getByRole("button", { name: "Create a passkey account" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Passkey account created" })).toBeVisible({ timeout: 15_000 });
    const body = api.calls("POST", "/v1/relay/create-account")[0]?.body as { passkey: string };
    expect(body.passkey).toMatch(/^0[23][0-9a-f]{64}$/);
  });
});
