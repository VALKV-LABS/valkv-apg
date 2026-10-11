// The console in a real browser, against a real control plane and node.
// Everything created here is named ui-e2e-* and removed at the end.

import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

const TOKEN = process.env["ADMIN_TOKEN"] ?? "apg_at_dev-only-admin-token-do-not-use";
const auth = { authorization: `Bearer ${TOKEN}` };
const WS = "/v1/workspaces/default";

async function signIn(page: Page, token = TOKEN) {
  await page.goto("/ui/");
  await page.getByLabel("Admin token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

/** No WCAG 2.1 A or AA violation that a machine can find (spec UI-3). */
async function scan(page: Page, what: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 160)}`);
  expect(summary, `accessibility violations on ${what}`).toEqual([]);
}

async function cleanup(request: APIRequestContext) {
  for (const segment of ["plugins", "routes", "services", "consumers"]) {
    const list = await (await request.get(`${WS}/${segment}?limit=500`, { headers: auth })).json();
    for (const r of list.data.filter((x: { name: string }) => x.name.startsWith("ui-e2e-"))) {
      await request.delete(`${WS}/${segment}/${r.id}?cascade=true`, { headers: auth });
    }
  }
  const tokens = await (await request.get("/v1/tokens", { headers: auth })).json();
  for (const t of tokens.data.filter((x: { name: string }) => x.name.startsWith("ui-e2e-"))) await request.delete(`/v1/tokens/${t.id}`, { headers: auth });
}

test.beforeAll(async ({ request }) => cleanup(request));
test.afterAll(async ({ request }) => cleanup(request));

test("signing in: a wrong token is refused with the server's words, a right one opens the overview", async ({ page }) => {
  await page.goto("/ui/");
  await scan(page, "sign-in");
  await page.getByLabel("Admin token").fill("apg_at_not-a-real-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("missing or invalid credentials");

  await page.getByLabel("Admin token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByText("Requests per hour")).toBeVisible();
  await scan(page, "overview (dark)");

  // The session is a cookie the page's scripts cannot read, and the token is not kept.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "apg_session")).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("apg_at_");

  // A reload keeps the session; signing out ends it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Admin token")).toBeVisible();
  await page.goto("/ui/routes");
  await expect(page.getByLabel("Admin token")).toBeVisible();
});

test("a service and a route are created through forms, and a node confirms the route", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Services" }).click();
  await page.getByRole("button", { name: "New service" }).click();
  let dialog = page.getByRole("dialog", { name: "New service" });
  await dialog.getByLabel("Name").fill("ui-e2e-echo");
  await dialog.getByLabel("Target").fill("not a target");
  await dialog.getByRole("button", { name: "Save" }).click();
  // The server's fault lands on the field it is about.
  await expect(dialog.getByLabel("Target")).toHaveAttribute("aria-invalid", "true");
  await scan(page, "service form with a fault");
  await dialog.getByLabel("Target").fill("echo:8080");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: "ui-e2e-echo", exact: true })).toBeVisible();
  await scan(page, "services");

  await page.getByRole("link", { name: "Routes" }).click();
  await page.getByRole("button", { name: "New route" }).click();
  dialog = page.getByRole("dialog", { name: "New route" });
  await dialog.getByLabel("Name").fill("ui-e2e-route");
  await dialog.getByLabel("Service").selectOption({ label: "ui-e2e-echo" });
  await dialog.getByRole("button", { name: "Add host" }).click();
  await dialog.getByLabel("Hosts 1", { exact: true }).fill("ui-e2e.example.test");
  await dialog.getByLabel("Paths").fill('["/ui-e2e"]');
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: "ui-e2e-route", exact: true })).toBeVisible();

  // The route tester asks a real node; it answers once the change has reached it.
  await page.getByLabel("Host", { exact: true }).fill("ui-e2e.example.test");
  await page.getByLabel("Path", { exact: true }).fill("/ui-e2e/items");
  await expect(async () => {
    await page.getByRole("button", { name: "Test" }).click();
    await expect(page.getByText("This request goes to route")).toContainText("ui-e2e-route", { timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await page.getByLabel("Path", { exact: true }).fill("/somewhere-else");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("the path does not match prefix /ui-e2e")).toBeVisible();
  await scan(page, "routes with tester results");
});

test("a plugin is attached to the route from the catalogue, with its settings from the schema", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Plugins" }).click();
  await page.getByRole("tab", { name: "Catalogue" }).click();
  await scan(page, "plugin catalogue");
  await page.getByRole("button", { name: "Add rate_limit" }).click();
  const dialog = page.getByRole("dialog", { name: "Add rate_limit" });
  await dialog.getByLabel("Attach to").selectOption("route");
  await dialog.getByLabel("Route", { exact: true }).selectOption({ label: "ui-e2e-route" });
  await dialog.getByLabel("Name").fill("ui-e2e-limit");
  await dialog.getByLabel("Per second").fill("5");
  await dialog.getByLabel("Burst").fill("10");
  await scan(page, "plugin form");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row", { name: /ui-e2e-limit/ });
  await expect(row).toContainText("rate_limit");
  await expect(row).toContainText("route ui-e2e-route");

  // The route's own view shows it as the instance that applies.
  await page.getByRole("link", { name: "Routes" }).click();
  await page.getByRole("button", { name: "Plugins and usage of ui-e2e-route" }).click();
  await expect(page.getByRole("dialog").getByRole("row", { name: /rate_limit/ })).toContainText("ui-e2e-limit");
});

test("a generated API key is shown once and never again", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Consumers" }).click();
  await page.getByRole("button", { name: "New consumer" }).click();
  const dialog = page.getByRole("dialog", { name: "New consumer" });
  await dialog.getByLabel("Name").fill("ui-e2e-app");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Credentials of ui-e2e-app" }).click();
  await page.getByRole("button", { name: "Add credential" }).click();
  const editor = page.getByRole("dialog", { name: "New credential for ui-e2e-app" });
  await editor.getByLabel("Name").fill("main");
  await editor.getByRole("button", { name: "Save" }).click();
  const secret = page.getByTestId("secret-once");
  await expect(secret).toHaveText(/^apg_k_/);
  const key = (await secret.textContent())!;
  await scan(page, "credentials with a new key");

  await page.reload();
  await page.getByRole("button", { name: "Credentials of ui-e2e-app" }).click();
  await expect(page.getByRole("row", { name: /main/ })).toContainText(key.slice(0, 8));
  await expect(page.getByText(key)).toHaveCount(0);
});

test("config: a document is reviewed before it is applied, and the revision is recorded", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Config" }).click();
  await expect(page.getByLabel("Current configuration as YAML")).toContainText("ui-e2e-route");
  await scan(page, "config, current");

  await page.getByRole("tab", { name: "Apply a document" }).click();
  await page.getByLabel("Document", { exact: true }).fill(["version: 1", "services:", "  - name: ui-e2e-second", "    backends:", '      - target: "echo:8080"', ""].join("\n"));
  await page.getByLabel("Message").fill("from the browser test");
  await page.getByRole("button", { name: "Show changes" }).click();
  await expect(page.getByRole("list", { name: "Changes" })).toContainText("service ui-e2e-second");
  await scan(page, "config, changes");
  await page.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Recorded revision" })).toBeVisible();

  await page.getByRole("tab", { name: "Revisions" }).click();
  await expect(page.getByRole("row", { name: /from the browser test/ }).first()).toContainText("apply");
  await scan(page, "config, revisions");
});

test("the remaining pages load real data and pass the accessibility scan in the light theme", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await scan(page, "overview (light)");

  for (const [link, heading, expectText] of [
    ["Domains & certificates", "Domains & certificates", "Host names this workspace serves"],
    ["Usage", "Usage", "Requests over time"],
    ["Audit log", "Audit log", "Newest first"],
    ["Workspaces", "Workspaces", "default"],
    ["Nodes", "Nodes", "node-1"],
    ["Settings", "Settings", "bootstrap-admin"],
    ["Routes", "Routes", "ui-e2e-route"],
    ["Plugins", "Plugins", "ui-e2e-limit"],
  ] as const) {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(page.locator("main").getByText(expectText).first()).toBeVisible();
    await scan(page, `${link} (light)`);
  }

  // The choice survives a reload.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("the theme follows the system until a choice is made", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "light" });
  const page = await context.newPage();
  await page.goto("/ui/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await scan(page, "sign-in (light)");
  await context.close();
});

test("usable on a phone: the menu opens, nothing overflows sideways", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await page.goto("/ui/");
  await page.getByLabel("Admin token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Routes" }).click();
  await expect(page.getByRole("heading", { name: "Routes", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  for (const path of ["/ui/routes", "/ui/services", "/ui/config", "/ui/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} scrolls sideways at 360px`).toBeLessThanOrEqual(0);
  }
  await scan(page, "settings at 360px");
  await context.close();
});

test("everything works from the keyboard", async ({ page }) => {
  await page.goto("/ui/");
  await expect(page.getByLabel("Admin token")).toBeFocused(); // the token field has focus on arrival
  await page.keyboard.type(TOKEN);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.goto("/ui/services");
  await page.getByRole("button", { name: "New service" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New service" });
  await expect(dialog).toBeVisible();
  // Focus is inside the dialog, and Escape closes it.
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a viewer scoped to one workspace sees no control that changes anything, and no fleet page", async ({ page, request }) => {
  await request.delete("/v1/workspaces/ui-e2e-tenant?cascade=true", { headers: auth });
  const ws = await request.post("/v1/workspaces", { headers: auth, data: { name: "ui-e2e-tenant" } });
  expect(ws.status()).toBe(201);
  const workspace = await ws.json();
  const made = await (await request.post("/v1/tokens", { headers: auth, data: { name: `ui-e2e-viewer-${Date.now()}`, role: "viewer", workspaces: [workspace.id] } })).json();
  try {
    await signIn(page, made.token);
    await expect(page.getByLabel("Workspace")).toHaveValue("ui-e2e-tenant");
    await expect(page.getByLabel("Workspace").getByRole("option")).toHaveCount(1);
    for (const link of ["Workspaces", "Nodes", "Settings"]) await expect(page.getByRole("link", { name: link })).toHaveCount(0);
    for (const link of ["Routes", "Services", "Consumers", "Plugins"]) {
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { name: link, level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: /^(New|Add|Edit|Delete)/ })).toHaveCount(0);
    }
    await page.goto("/ui/settings");
    await expect(page.getByText("This page is for fleet administrators")).toBeVisible();
  } finally {
    await request.delete(`/v1/workspaces/${workspace.id}?cascade=true`, { headers: auth });
  }
});

test("settings: a new token is shown once", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New token" }).click();
  const dialog = page.getByRole("dialog", { name: "New token" });
  const name = `ui-e2e-token-${Date.now()}`;
  await dialog.getByLabel("Name").fill(name);
  await scan(page, "token form");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("secret-once")).toHaveText(/^apg_at_/);
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("viewer");
  await page.reload();
  await expect(page.getByTestId("secret-once")).toHaveCount(0);

  await page.getByRole("tab", { name: "Flags" }).click();
  await expect(page.getByRole("heading", { name: "Flags", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Gateway settings" }).click();
  await expect(page.getByRole("cell", { name: "identity_headers", exact: true })).toBeVisible();
  await scan(page, "gateway settings");
});

test("nodes: the fleet is summed up, and a node opens to show what it holds and sees", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Nodes", exact: true }).click();
  await expect(page.locator(".stat-label", { hasText: "With failing backends" })).toBeVisible();
  await page.getByRole("button", { name: "Details of node node-1" }).click();
  const dialog = page.getByRole("dialog", { name: "Node node-1" });
  await expect(dialog.getByText("Backends as this node sees them")).toBeVisible();
  await expect(dialog.getByRole("row", { name: /Configuration from/ })).toContainText("api_poll");
  await scan(page, "node details");
});
