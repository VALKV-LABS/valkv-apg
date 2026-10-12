// Declarative configuration, browser sessions, the UI host and the route
// tester, against a real Postgres.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, start } from "./harness.js";

let h: Harness;
let node: Server;
let nodeAnswer: (url: URL) => { status: number; body: unknown };
let tenant: { id: string };
let editor: string;
let viewer: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "apg-ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>console</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");

  // Stands in for a node's management listener.
  node = createServer((req, res) => {
    const { status, body } = nodeAnswer(new URL(req.url!, "http://node"));
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
  const port = (node.address() as { port: number }).port;

  h = await start("config", {
    ui: { enabled: true, dir, brandName: "Acme Gateway", logoUrl: null, primaryColor: "#0f766e", embedOrigins: ["https://portal.example.com"] },
    debugNodeUrl: `http://127.0.0.1:${port}`,
  });
  const ws = await h.call("POST", "/v1/workspaces", { body: { name: "acme" } });
  tenant = { id: ws.json.id };
  editor = await h.token("editor", [tenant.id]);
  viewer = await h.token("viewer", [tenant.id]);
});
afterAll(async () => {
  await h.close();
  await new Promise((resolve) => node.close(resolve));
});

const document = () => ({
  version: 1,
  services: [
    { name: "orders", backends: [{ target: "10.0.0.1:8080" }, { target: "10.0.0.2:8080", weight: 2 }], plugins: [{ type: "cors", config: { origins: ["https://app.example.com"] } }] },
    { name: "billing", backends: [{ target: "10.0.1.1:8080" }], labels: { team: "money" } },
  ],
  routes: [
    { name: "orders-api", service: "orders", hosts: ["api.example.com"], paths: ["/orders"], plugins: [{ type: "key_auth" }, { type: "rate_limit", config: { per_second: 50, burst: 100 } }] },
    { name: "billing-api", service: "billing", hosts: ["api.example.com"], paths: ["/billing"], labels: { team: "money" } },
  ],
  consumers: [
    { name: "mobile-app", groups: ["partners"], credentials: [{ type: "key", key: "mobile-key-0123456789" }, { type: "basic", username: "mobile", password: "correct horse battery" }] },
  ],
  plugins: [{ type: "request_size_limit", scope: "workspace", config: { max_bytes: 1048576 } }],
});

const post = (path: string, body: unknown, token?: string) => h.call("POST", path, { body, ...(token ? { token } : {}) });

describe("apply, diff and sync", () => {
  it("validate and diff change nothing, and say what apply would do", async () => {
    const before = await h.lastSeq();
    const valid = await post("/v1/config/validate", { document: document() });
    expect(valid.status).toBe(200);
    expect(valid.json).toMatchObject({ valid: true, summary: { create: 11, update: 0, delete: 0 } });
    const diff = await post("/v1/config/diff", { document: document() });
    expect(diff.json.changes.map((c: any) => `${c.op} ${c.kind} ${c.name}`)).toEqual(expect.arrayContaining([
      "create service orders", "create route orders-api", "create consumer mobile-app", "create credential mobile-app/basic-mobile",
      "create plugin key_auth.route.orders-api", "create plugin cors.service.orders", "create plugin request_size_limit.workspace",
    ]));
    expect(diff.json.revisions).toEqual([]);
    expect(await h.lastSeq()).toBe(before);
    expect((await h.call("GET", "/v1/workspaces/default/services")).json.data).toEqual([]);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_config_revisions`)[0]!["n"]).toBe(0);
  });

  it("apply lands everything, records a revision, and a second apply is a no-op", async () => {
    const first = await post("/v1/config/apply", { document: document(), message: "first" });
    expect(first.status).toBe(200);
    expect(first.json.summary).toEqual({ create: 11, update: 0, delete: 0, unchanged: 0 });
    expect(first.json.revisions).toEqual([{ id: expect.any(String), workspace: "default", number: 1 }]);
    expect((await h.call("GET", "/v1/workspaces/default/routes/orders-api")).status).toBe(200);

    const seq = await h.lastSeq();
    const audit = (await h.sql`SELECT count(*)::int AS n FROM apg_audit_log`)[0]!["n"];
    const again = await post("/v1/config/apply", { document: document() });
    expect(again.json.summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 11 });
    expect(again.json.changes).toEqual([]);
    // nothing reached the nodes, the audit log or the revision history
    expect(await h.lastSeq()).toBe(seq);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_audit_log`)[0]!["n"]).toBe(audit);
    expect(again.json.revisions).toEqual([]);
  });

  it("a change shows up field by field; a changed secret shows as changed, never in clear", async () => {
    const doc = document();
    doc.services[0]!.backends[1]!.weight = 5;
    doc.routes[0]!.paths = ["/orders", "/v2/orders"];
    (doc.consumers[0]!.credentials[1] as any).password = "a different password";
    const diff = await post("/v1/config/diff", { document: doc });
    expect(diff.json.summary).toMatchObject({ create: 0, update: 3, delete: 0 });
    const byName = Object.fromEntries(diff.json.changes.map((c: any) => [c.name, c.fields]));
    expect(byName["orders"].map((f: any) => f.pointer)).toEqual(["/backends"]);
    expect(byName["orders-api"]).toEqual([{ pointer: "/paths", before: [{ type: "prefix", value: "/orders" }], after: [{ type: "prefix", value: "/orders" }, { type: "prefix", value: "/v2/orders" }] }]);
    expect(byName["mobile-app/basic-mobile"]).toEqual([{ pointer: "/password", before: "***", after: "*** (changed)" }]);
    expect(JSON.stringify(diff.json)).not.toContain("a different password");
  });

  it("a fault anywhere means nothing lands, and the pointer is into the document", async () => {
    const doc = document();
    doc.services.push({ name: "new-one", backends: [{ target: "10.0.2.1:80" }] } as never);
    doc.routes.push({ name: "broken", service: "does-not-exist", hosts: ["api.example.com"], paths: ["/x"] } as never);
    const seq = await h.lastSeq();
    const res = await post("/v1/config/apply", { document: doc });
    expect(res.status).toBe(422);
    expect(res.json.error.message).toContain("route 'broken'");
    expect(res.json.error.details[0].pointer).toBe("/routes/2/service");
    expect(await h.lastSeq()).toBe(seq);
    expect((await h.call("GET", "/v1/workspaces/default/services/new-one")).status).toBe(404);

    const typo = await post("/v1/config/validate", { document: { version: 1, servcies: [] } });
    expect(typo.status).toBe(422);
    expect(JSON.stringify(typo.json.error.details)).toContain("servcies");
  });

  it("apply never deletes; sync does, and a label limits what it may delete", async () => {
    const doc = document();
    doc.services = doc.services.filter((s) => s.name !== "billing");
    doc.routes = doc.routes.filter((r) => r.name !== "billing-api");
    doc.consumers = [];

    const applied = await post("/v1/config/apply", { document: doc });
    expect(applied.json.summary.delete).toBe(0);
    expect((await h.call("GET", "/v1/workspaces/default/services/billing")).status).toBe(200);

    const preview = await post("/v1/config/diff?prune=true", { document: doc });
    expect(preview.json.changes.filter((c: any) => c.op === "delete").map((c: any) => `${c.kind} ${c.name}`).sort()).toEqual([
      "consumer mobile-app", "credential mobile-app/basic-mobile", `credential mobile-app/${preview.json.changes.find((c: any) => c.name.startsWith("mobile-app/key-")).name.split("/")[1]}`,
      "route billing-api", "service billing",
    ]);

    const labelled = await post("/v1/config/sync", { document: doc, select_label: "team=money" });
    expect(labelled.json.changes.map((c: any) => `${c.op} ${c.kind} ${c.name}`).sort()).toEqual(["delete route billing-api", "delete service billing"]);
    expect((await h.call("GET", "/v1/workspaces/default/consumers/mobile-app")).status).toBe(200);

    const full = await post("/v1/config/sync", { document: doc });
    expect(full.json.summary.delete).toBe(3);
    expect((await h.call("GET", "/v1/workspaces/default/consumers/mobile-app")).status).toBe(404);
    // every deletion reached the nodes as an event
    const kinds = (await h.events()).filter((e) => e.data["op"] === "delete").map((e) => e.data["kind"]);
    expect(kinds).toEqual(expect.arrayContaining(["service", "route", "consumer", "credential"]));
  });
});

describe("dump, revisions and rollback", () => {
  it("a dump holds no secret and syncs back with no change", async () => {
    await post("/v1/config/sync", { document: document() });
    const dump = await h.call("GET", "/v1/config/dump");
    expect(dump.status).toBe(200);
    expect(dump.json.routes.find((r: any) => r.name === "orders-api").service).toBe("orders");
    expect(dump.json.plugins.find((p: any) => p.type === "key_auth")).toMatchObject({ scope: "route", scope_ref: "orders-api" });
    const text = JSON.stringify(dump.json);
    expect(text).not.toContain("mobile-key-0123456789");
    expect(text).not.toContain("correct horse");
    expect(text).not.toMatch(/"id":|"revision":|"created_at":/);
    expect(dump.json.consumers[0].credentials.map((c: any) => c.key ?? c.password)).toEqual([{ $secret: "***" }, { $secret: "***" }]);

    const seq = await h.lastSeq();
    const back = await post("/v1/config/sync", { document: dump.json });
    expect(back.status).toBe(200);
    expect(back.json.changes).toEqual([]);
    expect(await h.lastSeq()).toBe(seq);
    // the key still works: its hash was kept, not replaced by the placeholder
    const [cred] = await h.sql`SELECT key_hash FROM apg_credentials WHERE type = 'key'`;
    expect(cred!["key_hash"]).toHaveLength(64);
  });

  it("revisions list newest first, never show a secret, and report drift", async () => {
    const list = await h.call("GET", "/v1/config/revisions");
    expect(list.status).toBe(200);
    const numbers = list.json.data.map((r: any) => r.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(list.json.data[0]).toMatchObject({ action: "sync", actor: { kind: "token" } });
    expect(list.json.drift).toEqual({ drifted: false, since_revision: numbers[0] });

    const shown = await h.call("GET", `/v1/config/revisions/${list.json.data[0].id}`);
    expect(JSON.stringify(shown.json)).not.toContain("mobile-key-0123456789");
    expect(JSON.stringify(shown.json)).not.toContain("$sealed");
    const stored = await h.sql`SELECT document FROM apg_config_revisions WHERE id = ${list.json.data[0].id}`;
    expect(JSON.stringify(stored[0]!["document"])).not.toContain("mobile-key-0123456789");

    // someone changes the workspace through the API
    await h.call("PATCH", "/v1/workspaces/default/routes/orders-api", { body: { priority: 7 } });
    expect((await h.call("GET", "/v1/config/revisions")).json.drift).toEqual({ drifted: true, since_revision: numbers[0] });
  });

  it("rollback restores an earlier revision, secrets included, as a new revision", async () => {
    const target = (await h.call("GET", "/v1/config/revisions")).json.data[0];
    const emptied = await post("/v1/config/sync", { document: { version: 1 } });
    expect(emptied.json.summary.delete).toBeGreaterThan(5);
    expect((await h.call("GET", "/v1/workspaces/default/consumers")).json.data).toEqual([]);

    const preview = await post(`/v1/config/revisions/${target.id}/rollback?dry_run=true`, {});
    expect(preview.json.summary.create).toBe(11);
    expect((await h.call("GET", "/v1/workspaces/default/consumers")).json.data).toEqual([]);

    const back = await post(`/v1/config/revisions/${target.id}/rollback`, {});
    expect(back.status).toBe(200);
    expect(back.json.revisions[0].number).toBe(target.number + 2);
    const list = (await h.call("GET", "/v1/config/revisions")).json;
    expect(list.data[0]).toMatchObject({ action: "rollback", message: `rollback to revision ${target.number}` });
    expect(list.drift.drifted).toBe(false);
    // the API key from the original document works again
    const { createHash } = await import("node:crypto");
    const [cred] = await h.sql`SELECT key_hash FROM apg_credentials WHERE type = 'key'`;
    expect(cred!["key_hash"]).toBe(createHash("sha256").update("mobile-key-0123456789").digest("hex"));
  });
});

describe("scope", () => {
  it("a workspace editor applies to its own workspace only; a viewer reads but cannot apply", async () => {
    await h.call("POST", `/v1/workspaces/${tenant.id}/domains`, { body: { hostname: "shop.acme.example" } });
    const doc = { version: 1, workspace: "acme", services: [{ name: "shop", backends: [{ target: "shop.acme.example:443" }] }], routes: [{ name: "shop", service: "shop", hosts: ["shop.acme.example"] }] };
    h.dns.set("shop.acme.example", ["203.0.113.10"]);
    const own = await post("/v1/config/apply", { document: doc }, editor);
    expect(own.status).toBe(200);
    expect(own.json.summary.create).toBe(2);

    expect((await post("/v1/config/apply", { document: { ...doc, workspace: "default" } }, editor)).status).toBe(404);
    expect((await post("/v1/config/apply", { document: { version: 1, workspace: "acme", flags: { usage_metering: true } } }, editor)).status).toBe(403);
    expect((await post("/v1/config/apply", { document: { version: 1, workspaces: [{ name: "brand-new" }] } }, editor)).status).toBe(403);
    expect((await post("/v1/config/apply", { document: doc }, viewer)).status).toBe(403);

    expect((await h.call("GET", "/v1/config/dump?workspace=acme", { token: viewer })).json.services[0].name).toBe("shop");
    expect((await h.call("GET", "/v1/config/dump?workspace=default", { token: viewer })).status).toBe(404);
    const revision = (await h.call("GET", "/v1/config/revisions")).json.data[0];
    expect((await h.call("GET", `/v1/config/revisions/${revision.id}`, { token: viewer })).status).toBe(404);
  });

  it("an admin can describe several workspaces, settings and flags in one document", async () => {
    const res = await post("/v1/config/apply", {
      document: {
        version: 1,
        flags: { usage_metering: true },
        settings: { identity_headers: false },
        workspaces: [{ name: "globex", labels: { tier: "gold" }, services: [{ name: "api", backends: [{ target: "10.9.0.1:80" }] }] }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.changes.map((c: any) => `${c.op} ${c.kind} ${c.name}`)).toEqual(expect.arrayContaining(["create workspace globex", "create service api"]));
    expect((await h.call("GET", "/v1/workspaces/globex/services/api")).status).toBe(200);
    expect((await h.call("GET", "/v1/settings")).json.data.find((s: any) => s.name === "identity_headers").value).toBe(false);
  });
});

describe("browser sessions", () => {
  const cookieFrom = (res: { headers: Record<string, any> }) => String(res.headers["set-cookie"]).split(";")[0]!;

  it("a token opens a session; the cookie reads, and writes only with the CSRF token", async () => {
    const opened = await h.call("POST", "/v1/session", {});
    expect(opened.status).toBe(201);
    expect(String(opened.headers["set-cookie"])).toMatch(/^apg_session=apg_s_\w+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    expect(opened.json.actor).toMatchObject({ role: "admin", workspaces: "*", fleet_admin: true });
    const cookie = cookieFrom(opened);

    const me = await h.call("GET", "/v1/session", { token: null, headers: { cookie } });
    expect(me.json.csrf_token).toBe(opened.json.csrf_token);
    expect((await h.call("GET", "/v1/workspaces", { token: null, headers: { cookie } })).status).toBe(200);

    const body = { name: "from-a-browser" };
    expect((await h.call("POST", "/v1/workspaces", { token: null, headers: { cookie }, body })).status).toBe(403);
    expect((await h.call("POST", "/v1/workspaces", { token: null, headers: { cookie, "x-apg-csrf": "wrong" }, body })).status).toBe(403);
    expect((await h.call("POST", "/v1/workspaces", { token: null, headers: { cookie, "x-apg-csrf": opened.json.csrf_token }, body })).status).toBe(201);

    // only a hash of the cookie is stored
    const stored = await h.sql`SELECT id_hash FROM apg_sessions`;
    expect(stored.some((s) => cookie.includes(s["id_hash"]))).toBe(false);

    const out = await h.call("DELETE", "/v1/session", { token: null, headers: { cookie, "x-apg-csrf": opened.json.csrf_token } });
    expect(out.status).toBe(204);
    expect((await h.call("GET", "/v1/workspaces", { token: null, headers: { cookie } })).status).toBe(401);
  });

  it("a session ends when its token is revoked, and a node token gets none", async () => {
    const made = await h.call("POST", "/v1/tokens", { body: { name: "temp-ui", role: "viewer" } });
    const opened = await h.call("POST", "/v1/session", { token: made.json.token });
    const cookie = cookieFrom(opened);
    expect((await h.call("GET", "/v1/session", { token: null, headers: { cookie } })).json.actor.role).toBe("viewer");
    await h.call("DELETE", "/v1/tokens/temp-ui");
    expect((await h.call("GET", "/v1/session", { token: null, headers: { cookie } })).status).toBe(401);
    expect((await h.call("POST", "/v1/session", { token: h.tokens.node })).status).toBe(403);
    expect((await h.call("GET", "/v1/session", { token: null, headers: { cookie: "apg_session=apg_s_made-up" } })).status).toBe(401);
  });
});

describe("the UI host", () => {
  it("serves the application, its assets and its settings without credentials", async () => {
    const page = await h.call("GET", "/ui/", { token: null });
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>console</title>");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors https://portal.example.com");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const asset = await h.call("GET", "/ui/assets/app-abc123.js", { token: null });
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");

    // a deep link is the application; a missing file is not
    expect((await h.call("GET", "/ui/routes/orders-api", { token: null })).text).toContain("<title>console</title>");
    expect((await h.call("GET", "/ui/assets/missing.js", { token: null })).status).toBe(404);
    expect((await h.call("GET", "/ui/..%2f..%2fetc/passwd", { token: null })).text).not.toContain("root:");
    expect((await h.call("GET", "/", { token: null })).headers["location"]).toBe("/ui/");

    const settings = await h.call("GET", "/ui/config.json", { token: null });
    expect(settings.json).toMatchObject({ brand_name: "Acme Gateway", primary_color: "#0f766e", embed_origins: ["https://portal.example.com"] });
    // the API behind it still needs credentials
    expect((await h.call("GET", "/v1/workspaces", { token: null })).status).toBe(401);
  });
});

describe("the route tester", () => {
  const answer = () => ({
    host: "api.example.com", path: "/orders", method: "GET", host_owner: tenant.id, node_id: "n1", truncated: false,
    selected: { route_id: "r-sys", route: "system-route", workspace_id: "ws-system", tier: "system", path: "prefix /", matches: true, selected: true, reason: "" },
    candidates: [
      { route_id: "r-sys", route: "system-route", workspace_id: "ws-system", tier: "system", path: "prefix /", matches: true, selected: true, reason: "" },
      { route_id: "r-own", route: "shop", workspace_id: tenant.id, tier: "workspace", path: "any path", matches: true, selected: false, reason: "matches, but 'system-route' is ahead of it in match order" },
    ],
  });

  it("asks the node, passes the request through, and hides other workspaces' routes from a scoped caller", async () => {
    let seen = "";
    nodeAnswer = (url) => {
      seen = url.search;
      return { status: 200, body: answer() };
    };
    const full = await h.call("GET", "/v1/debug/match?host=api.example.com&path=/orders&method=GET&header=X-Beta:1&header=X-Other:2");
    expect(full.status).toBe(200);
    expect(full.json.selected.route).toBe("system-route");
    expect(seen).toContain("header=X-Beta%3A1");
    expect(seen).toContain("header=X-Other%3A2");

    const scoped = await h.call("GET", "/v1/debug/match?host=api.example.com&path=/orders", { token: viewer });
    expect(scoped.json.selected).toMatchObject({ route_id: null, route: "(a route of another workspace)", selected: true });
    expect(scoped.json.candidates[1].route).toBe("shop");
    expect(JSON.stringify(scoped.json)).not.toContain("system-route");
  });

  it("says so when the request is incomplete, the node refuses, or the node is away", async () => {
    expect((await h.call("GET", "/v1/debug/match?host=a.example.com")).status).toBe(400);
    nodeAnswer = () => ({ status: 400, body: { error: "the path is not valid" } });
    const bad = await h.call("GET", "/v1/debug/match?host=a.example.com&path=/../..");
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe("the path is not valid");
    nodeAnswer = () => ({ status: 500, body: {} });
    const down = await h.call("GET", "/v1/debug/match?host=a.example.com&path=/");
    expect(down.status).toBe(503);
    expect(down.json.error.code).toBe("UNAVAILABLE");
  });
});
