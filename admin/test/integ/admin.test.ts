// Admin API against a real Postgres: authorisation, the resource rules, and
// the guarantee that a resource row, its changelog event and its audit row
// are written together or not at all (spec CFG-1).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, fixture, start } from "./harness.js";

let h: Harness;
let tenant: { id: string; slug: string };
let editor: string; // editor scoped to `tenant`
let viewer: string;
const D = "/v1/workspaces/default";

beforeAll(async () => {
  h = await start("admin");
  const ws = await h.call("POST", "/v1/workspaces", { body: { name: "acme" } });
  expect(ws.status).toBe(201);
  tenant = { id: ws.json.id, slug: ws.json.slug };
  editor = await h.token("editor", [tenant.id]);
  viewer = await h.token("viewer", [tenant.id]);
});
afterAll(async () => h.close());

const T = () => `/v1/workspaces/${tenant.id}`;

describe("authentication and roles", () => {
  it("no token, a wrong token and a malformed header are all 401 with the same message", async () => {
    const a = await h.call("GET", "/v1/workspaces", { token: null });
    const b = await h.call("GET", "/v1/workspaces", { token: "apg_at_wrong" });
    const c = await h.call("GET", "/v1/workspaces", { token: null, headers: { authorization: "Basic abc" } });
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
    expect(a.json.error.message).toBe(b.json.error.message);
  });

  it("a node token cannot use the Admin API", async () => {
    expect((await h.call("GET", "/v1/workspaces", { token: h.tokens.node })).status).toBe(403);
  });

  it("an expired token is refused", async () => {
    const res = await h.call("POST", "/v1/tokens", { body: { name: "short-lived", role: "viewer", expires_at: new Date(Date.now() - 1000).toISOString() } });
    expect(res.status).toBe(201);
    expect((await h.call("GET", "/v1/workspaces", { token: res.json.token })).status).toBe(401);
  });

  it("a scoped caller sees only its workspace, and others read as not found (no existence leak)", async () => {
    const list = await h.call("GET", "/v1/workspaces", { token: editor });
    expect(list.json.data.map((w: any) => w.name)).toEqual(["acme"]);
    const other = await h.call("GET", `${D}/services`, { token: editor });
    expect(other.status).toBe(404);
    const missing = await h.call("GET", "/v1/workspaces/does-not-exist/services", { token: editor });
    expect(missing.status).toBe(404);
    expect(other.json.error.message).toBe(missing.json.error.message);
  });

  it("a viewer reads but cannot write; fleet endpoints need the admin role", async () => {
    expect((await h.call("GET", `${T()}/services`, { token: viewer })).status).toBe(200);
    expect((await h.call("POST", `${T()}/consumers`, { token: viewer, body: { name: "x" } })).status).toBe(403);
    for (const path of ["/v1/flags", "/v1/settings", "/v1/tokens", "/v1/nodes", "/v1/audit"]) {
      expect((await h.call("GET", path, { token: editor })).status, path).toBe(403);
    }
    expect((await h.call("POST", "/v1/workspaces", { token: editor, body: { name: "nope" } })).status).toBe(403);
  });

  it("a token secret is returned once, stored hashed, and the last fleet admin cannot be revoked", async () => {
    const made = await h.call("POST", "/v1/tokens", { body: { name: "ci", role: "editor", workspaces: [tenant.id] } });
    expect(made.json.token).toMatch(/^apg_at_/);
    const listed = await h.call("GET", "/v1/tokens");
    expect(JSON.stringify(listed.json)).not.toContain(made.json.token);
    const stored = await h.sql`SELECT token_hash FROM apg_admin_tokens WHERE name = 'ci'`;
    expect(stored[0]!["token_hash"]).not.toContain(made.json.token.slice(8));
    expect((await h.call("DELETE", "/v1/tokens/ci")).status).toBe(204);
    expect((await h.call("GET", `${T()}/services`, { token: made.json.token })).status).toBe(401);

    const admins = (await h.call("GET", "/v1/tokens")).json.data.filter((t: any) => t.role === "admin" && t.workspaces.includes("*"));
    expect(admins).toHaveLength(1);
    expect((await h.call("DELETE", `/v1/tokens/${admins[0].id}`)).status).toBe(409);
    expect((await h.call("GET", "/v1/workspaces")).status).toBe(200);
  });
});

describe("services and routes", () => {
  it("creates a service with defaults filled in and emits one event carrying backends", async () => {
    const before = await h.lastSeq();
    const res = await h.call("POST", `${D}/services`, { body: { name: "orders", backends: [{ target: "10.0.0.1:8080" }, { target: "10.0.0.2:8080", weight: 3 }] } });
    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.json).toMatchObject({ name: "orders", scheme: "http", http_version: "1.1", revision: 1 });
    expect(res.json.backends.map((b: any) => [b.target, b.weight, b.status])).toEqual([["10.0.0.1:8080", 1, "active"], ["10.0.0.2:8080", 3, "active"]]);
    const events = await h.events(before);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ v: 2, kind: "service", op: "upsert", id: res.json.id, revision: 1 });
    expect(events[0]!.data["data"].backends).toHaveLength(2);
  });

  it("rejects an unknown key instead of ignoring it, with a pointer", async () => {
    const res = await h.call("POST", `${D}/services`, { body: { name: "typo", backends: [{ target: "a:1" }], load_balancing: { strategy: "least_conn" } } });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
    expect(res.json.error.details.some((d: any) => d.pointer === "/load_balancing/strategy")).toBe(true);
    const extra = await h.call("POST", `${D}/services`, { body: { name: "typo", backends: [{ target: "a:1" }], helth_check: {} } });
    expect(extra.status).toBe(422);
    expect(JSON.stringify(extra.json.error.details)).toContain("helth_check");
  });

  it("a route resolves its service by name, stores the id, and the event names the service by id", async () => {
    const svc = (await h.call("GET", `${D}/services/orders`)).json;
    const before = await h.lastSeq();
    const res = await h.call("POST", `${D}/routes`, { body: { name: "orders-api", service: "orders", hosts: ["api.example.com"], paths: ["/orders", { type: "regex", value: "/o/[0-9]+" }] } });
    expect(res.status).toBe(201);
    expect(res.json.service).toBe(svc.id);
    expect(res.json.hosts).toEqual(["api.example.com"]);
    // hosts are stored lower-case; anything else is rejected rather than silently rewritten
    const upper = await h.call("POST", `${D}/routes`, { body: { name: "upper", service: "orders", hosts: ["API.example.com"] } });
    expect(upper.status).toBe(422);
    expect(upper.json.error.details[0].pointer).toBe("/hosts/0");
    expect(res.json.paths).toEqual([{ type: "prefix", value: "/orders" }, { type: "regex", value: "/o/[0-9]+" }]);
    expect(res.json.strip_path).toBe(false);
    const [event] = await h.events(before);
    expect(event!.data["data"].service).toBe(svc.id);
  });

  it("a route to a missing service writes nothing at all", async () => {
    const before = await h.lastSeq();
    const audit = (await h.sql`SELECT count(*)::int AS n FROM apg_audit_log`)[0]!["n"];
    const res = await h.call("POST", `${D}/routes`, { body: { name: "dangling", service: "nope" } });
    expect(res.status).toBe(422);
    expect(res.json.error.details[0].pointer).toBe("/service");
    expect(await h.lastSeq()).toBe(before);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_routes WHERE name = 'dangling'`)[0]!["n"]).toBe(0);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_audit_log`)[0]!["n"]).toBe(audit);
  });

  it("refuses patterns the node's regex engine cannot run", async () => {
    const res = await h.call("POST", `${D}/routes`, { body: { name: "lookahead", service: "orders", paths: [{ type: "regex", value: "/a(?=b)" }] } });
    expect(res.status).toBe(422);
    expect(res.json.error.details[0].pointer).toBe("/paths/0/value");
  });

  it("PUT by name is an idempotent upsert: create, then replace, never a duplicate", async () => {
    const body = { backends: [{ target: "10.0.1.1:80" }] };
    const first = await h.call("PUT", `${D}/services/payments`, { body });
    const second = await h.call("PUT", `${D}/services/payments`, { body: { ...body, scheme: "https" } });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.json.id).toBe(first.json.id);
    expect(second.json).toMatchObject({ revision: 2, scheme: "https" });
    expect(second.json.backends[0].id).toBe(first.json.backends[0].id); // a backend keeps its id across updates
    expect((await h.call("POST", `${D}/services`, { body: { name: "payments", ...body } })).status).toBe(409);
  });

  it("If-Match guards against lost updates", async () => {
    const cur = (await h.call("GET", `${D}/services/payments`)).json;
    const stale = await h.call("PATCH", `${D}/services/payments`, { body: { http_version: "2" }, headers: { "if-match": `"${cur.revision - 1}"` } });
    expect(stale.status).toBe(412);
    const ok = await h.call("PATCH", `${D}/services/payments`, { body: { http_version: "2" }, headers: { "if-match": `"${cur.revision}"` } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ http_version: "2", scheme: "https", revision: cur.revision + 1 });
  });

  it("what GET returns can be sent straight back in a PUT", async () => {
    const got = (await h.call("GET", `${D}/routes/orders-api`)).json;
    const put = await h.call("PUT", `${D}/routes/orders-api`, { body: got });
    expect(put.status).toBe(200);
    expect(put.json.service).toBe(got.service);
  });

  it("dry_run validates and reports the result but writes nothing", async () => {
    const before = await h.lastSeq();
    const res = await h.call("POST", `${D}/services?dry_run=true`, { body: { name: "ghost", backends: [{ target: "g:1" }] } });
    expect(res.status).toBe(201);
    expect(res.json.name).toBe("ghost");
    expect((await h.call("GET", `${D}/services/ghost`)).status).toBe(404);
    expect(await h.lastSeq()).toBe(before);
  });

  it("backend endpoints edit the service document and emit one service event", async () => {
    const before = await h.lastSeq();
    const added = await h.call("POST", `${D}/services/orders/backends`, { body: { target: "10.0.0.3:8080" } });
    expect(added.json.backends).toHaveLength(3);
    const bid = added.json.backends[2].id;
    const drained = await h.call("PATCH", `${D}/services/orders/backends/${bid}`, { body: { status: "draining" } });
    expect(drained.json.backends[2].status).toBe("draining");
    expect((await h.call("PATCH", `${D}/services/orders/backends/${bid}`, { body: { target: "x:1" } })).status).toBe(422);
    const removed = await h.call("DELETE", `${D}/services/orders/backends/${bid}`);
    expect(removed.json.backends).toHaveLength(2);
    expect((await h.events(before)).map((e) => e.data["kind"])).toEqual(["service", "service", "service"]);
  });

  it("a service in use cannot be deleted; cascade deletes the route and its plugins and says so to nodes", async () => {
    const plugin = await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route", scope_ref: "orders-api" } });
    expect(plugin.status).toBe(201);
    const blocked = await h.call("DELETE", `${D}/services/orders`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatchObject({ code: "IN_USE" });
    expect(blocked.json.error.message).toContain("orders-api");

    const before = await h.lastSeq();
    expect((await h.call("DELETE", `${D}/services/orders?cascade=true`)).status).toBe(204);
    const events = (await h.events(before)).map((e) => `${e.data["kind"]}:${e.data["op"]}`);
    // referrers first, so a node never holds a route whose service is gone
    expect(events).toEqual(["plugin:delete", "route:delete", "service:delete"]);
    expect((await h.call("GET", `${D}/routes/orders-api`)).status).toBe(404);
  });

  it("lists with a cursor, a name filter and a label filter", async () => {
    for (const n of ["a", "b", "c"]) await h.call("PUT", `${D}/services/page-${n}`, { body: { backends: [{ target: "p:1" }], labels: { set: "page", n } } });
    const first = await h.call("GET", `${D}/services?label=set=page&limit=2`);
    expect(first.json.data).toHaveLength(2);
    expect(first.json.next_cursor).toBeTruthy();
    const rest = await h.call("GET", `${D}/services?label=set=page&limit=2&cursor=${first.json.next_cursor}`);
    expect(rest.json.data).toHaveLength(1);
    expect(rest.json.next_cursor).toBeNull();
    expect((await h.call("GET", `${D}/services?name=page-b`)).json.data.map((s: any) => s.name)).toEqual(["page-b"]);
    expect((await h.call("GET", `${D}/services?limit=0`)).status).toBe(400);
  });
});

describe("host ownership (DOM-1, DOM-2)", () => {
  it("a tenant route must name a host, and the host must be one the tenant owns", async () => {
    h.dns.set("app.internal.example", ["93.184.216.34"]);
    expect((await h.call("POST", `${T()}/services`, { token: editor, body: { name: "app", backends: [{ target: "app.internal.example:80" }] } })).status).toBe(201);
    const noHost = await h.call("POST", `${T()}/routes`, { token: editor, body: { name: "r", service: "app" } });
    expect(noHost.json.error.code).toBe("HOST_NOT_OWNED");
    const notOwned = await h.call("POST", `${T()}/routes`, { token: editor, body: { name: "r", service: "app", hosts: ["shop.acme.test"] } });
    expect(notOwned.status).toBe(422);
    expect(notOwned.json.error).toMatchObject({ code: "HOST_NOT_OWNED" });

    expect((await h.call("POST", `${T()}/domains`, { token: editor, body: { hostname: "shop.acme.test", tls: { mode: "none" } } })).status).toBe(201);
    expect((await h.call("POST", `${T()}/routes`, { token: editor, body: { name: "r", service: "app", hosts: ["shop.acme.test"] } })).status).toBe(201);
  });

  it("a hostname has one owner across all workspaces", async () => {
    const other = (await h.call("POST", "/v1/workspaces", { body: { name: "rival" } })).json;
    const res = await h.call("POST", `/v1/workspaces/${other.id}/domains`, { body: { hostname: "shop.acme.test", tls: { mode: "none" } } });
    expect(res.status).toBe(409);
    expect(res.json.error.message).not.toContain("acme"); // does not say who owns it
  });

  it("a wildcard domain covers one label, and base domains give every workspace its slug host", async () => {
    await h.call("POST", `${T()}/domains`, { token: editor, body: { hostname: "*.apps.acme.test", tls: { mode: "none" } } });
    expect((await h.call("PUT", `${T()}/routes/wild`, { token: editor, body: { service: "app", hosts: ["a.apps.acme.test"] } })).status).toBe(200);
    expect((await h.call("PUT", `${T()}/routes/deep`, { token: editor, body: { service: "app", hosts: ["a.b.apps.acme.test"] } })).status).toBe(422);

    expect((await h.call("PUT", "/v1/settings/workspace_base_domains", { body: { value: [{ domain: "gw.example.net" }] } })).status).toBe(200);
    expect((await h.call("PUT", `${T()}/routes/slug`, { token: editor, body: { service: "app", hosts: [`${tenant.slug}.gw.example.net`] } })).status).toBe(200);
    expect((await h.call("PUT", `${T()}/routes/steal`, { token: editor, body: { service: "app", hosts: ["rival.gw.example.net"] } })).status).toBe(422);
    // and a tenant cannot claim a name inside the base domain as its own Domain
    const claim = await h.call("POST", `${T()}/domains`, { token: editor, body: { hostname: "rival.gw.example.net", tls: { mode: "none" } } });
    expect(claim.json.error.code).toBe("HOST_NOT_OWNED");
  });

  it("deleting a domain that routes depend on is refused", async () => {
    const res = await h.call("DELETE", `${T()}/domains/shop.acme.test`, { token: editor });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("IN_USE");
  });

  it("a wildcard domain cannot use an HTTP-01 challenge", async () => {
    const res = await h.call("POST", `${T()}/domains`, { token: editor, body: { hostname: "*.bad.acme.test", tls: { mode: "acme", challenge: "http01" } } });
    expect(res.status).toBe(422);
  });

  it("a tenant cannot use a system service unless it is shared", async () => {
    await h.call("PUT", `${D}/services/private-sys`, { body: { backends: [{ target: "10.9.9.9:80" }] } });
    await h.call("PUT", `${D}/services/shared-sys`, { body: { shared: true, backends: [{ target: "10.9.9.8:80" }] } });
    expect((await h.call("PUT", `${T()}/routes/via-private`, { token: editor, body: { service: "private-sys", hosts: ["shop.acme.test"] } })).status).toBe(422);
    expect((await h.call("PUT", `${T()}/routes/via-shared`, { token: editor, body: { service: "shared-sys", hosts: ["shop.acme.test"] } })).status).toBe(200);
    expect((await h.call("PUT", `${T()}/services/mine`, { token: editor, body: { shared: true, backends: [{ target: "app.internal.example:80" }] } })).status).toBe(422);
  });
});

describe("egress guard (SEC-4)", () => {
  it("a tenant cannot point a backend at the metadata address, a private range, or a name that resolves to one", async () => {
    for (const target of ["169.254.169.254:80", "10.0.0.5:5432", "127.0.0.1:9000"]) {
      const res = await h.call("POST", `${T()}/services`, { token: editor, body: { name: "evil", backends: [{ target }] } });
      expect(res.status, target).toBe(422);
      expect(res.json.error.code).toBe("EGRESS_NOT_ALLOWED");
    }
    h.dns.set("rebind.example", ["10.0.0.5"]);
    const byName = await h.call("POST", `${T()}/services`, { token: editor, body: { name: "evil", backends: [{ target: "rebind.example:80" }] } });
    expect(byName.json.error.code).toBe("EGRESS_NOT_ALLOWED");
    expect((await h.call("GET", `${T()}/services/evil`, { token: editor })).status).toBe(404);
  });

  it("the operator may use private addresses", async () => {
    expect((await h.call("PUT", `${D}/services/internal`, { body: { backends: [{ target: "10.0.0.5:5432" }] } })).status).toBe(200);
  });

  it("nodes are told whose service it is, so they check the address again on every connection", async () => {
    const before = await h.lastSeq();
    h.dns.set("public.example", ["203.0.113.7"]);
    // A tenant cannot switch the check off by sending the field.
    const mine = await h.call("PUT", `${T()}/services/restricted`, { token: editor, body: { backends: [{ target: "public.example:80" }], egress_restricted: false } });
    expect(mine.json.egress_restricted).toBe(true);
    const ops = await h.call("PUT", `${D}/services/unrestricted`, { body: { backends: [{ target: "10.0.0.6:80" }] } });
    expect(ops.json.egress_restricted).toBe(false);
    const events = (await h.events(before)).map((e) => e.data["data"]);
    expect(events.map((d) => [d.name, d.egress_restricted])).toEqual([["restricted", true], ["unrestricted", false]]);
    // An admin who edits the tenant's service vouches for it.
    expect((await h.call("PUT", `${T()}/services/restricted`, { body: { backends: [{ target: "10.0.0.7:80" }] } })).json.egress_restricted).toBe(false);
  });
});

describe("everything accepted is enforced", () => {
  it("upstream policy the node implements is accepted and reaches nodes as written", async () => {
    const before = await h.lastSeq();
    const body = {
      backends: [{ target: "10.0.1.1:80" }, { target: "10.0.1.2:80", weight: 3 }],
      http_version: "2",
      load_balancing: { strategy: "hash", hash_key: "header:x-user" },
      timeouts: { connect_ms: 250, read_ms: 4000 },
      retries: { attempts: 2, on: ["connect_failure", "timeout"], non_idempotent: true },
      health_check: { active: { path: "/ready", interval_ms: 1000 }, passive: { consecutive_failures: 2, open_ms: 5000, statuses: [503] } },
      keepalive: { idle_ms: 5000 },
    };
    const res = await h.call("PUT", `${D}/services/policy`, { body });
    expect(res.status).toBe(200);
    const [event] = await h.events(before);
    expect(event!.data["data"]).toMatchObject(body);
    // Defaults the caller left out are stored, so a node and a reader see the same policy.
    expect(event!.data["data"].timeouts.write_ms).toBe(60000);
    expect(event!.data["data"].health_check.active.unhealthy_threshold).toBe(3);

    const route = await h.call("PUT", `${D}/routes/policy`, { body: { service: "policy", paths: ["/policy"], timeout_ms: 1500 } });
    expect(route.status).toBe(200);
    const split = await h.call("PUT", `${D}/routes/policy-split`, { body: { split: [{ service: "policy", weight: 1 }, { service: "internal", weight: 1 }], split_key: "cookie:session", paths: ["/policy-split"] } });
    expect(split.status).toBe(200);
  });

  it("policy no node enforces yet is refused, not stored and ignored", async () => {
    const base = { backends: [{ target: "10.0.1.1:80" }] };
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ drain_timeout_ms: 5000 }, "/drain_timeout_ms"],
      [{ keepalive: { max_idle_per_backend: 8 } }, "/keepalive/max_idle_per_backend"],
      [{ retries: { buffer_bytes: 1024 } }, "/retries/buffer_bytes"],
      [{ retries: { on: ["connect_failure", 503] } }, "/retries/on/1"],
    ];
    for (const [extra, pointer] of refused) {
      const res = await h.call("PUT", `${D}/services/unbuilt`, { body: { ...base, ...extra } });
      expect(res.status, pointer).toBe(422);
      expect(res.json.error.details[0].pointer).toBe(pointer);
      expect(res.json.error.message).toContain("not enforced by this build");
    }
    expect((await h.call("GET", `${D}/services/unbuilt`)).status).toBe(404);

    // A value equal to the default is what a GET returns, so sending it back works.
    const ok = await h.call("PUT", `${D}/services/unbuilt`, { body: { ...base, drain_timeout_ms: 30000, retries: { attempts: 0 } } });
    expect(ok.status).toBe(200);
    expect((await h.call("PUT", `${D}/services/unbuilt`, { body: ok.json, headers: { "if-match": String(ok.json.revision) } })).status).toBe(200);

    const route = await h.call("PUT", `${D}/routes/unbuilt`, { body: { service: "unbuilt", paths: ["/unbuilt"], idle_timeout_ms: 1000 } });
    expect(route.status).toBe(422);
    expect(route.json.error.details[0].pointer).toBe("/idle_timeout_ms");

    const setting = await h.call("PUT", "/v1/settings/access_log", { body: { value: { sink: "https://logs.example.com/ingest" } } });
    expect(setting.status).toBe(422);
    expect(setting.json.error.message).toContain("not enforced by this build");
    // The sinks nodes do implement are accepted, and a broken template is not.
    expect((await h.call("PUT", "/v1/settings/access_log", { body: { value: { sink: "file:/var/log/apg/access.log", sample_rate: 0.5 } } })).status).toBe(200);
    expect((await h.call("PUT", "/v1/settings/access_log", { body: { value: { custom_fields: { who: "{{ nobody.home }}" } } } })).status).toBe(422);
    expect((await h.call("PUT", "/v1/settings/access_log", { body: { value: { sink: "stdout", custom_fields: { tenant: "{{ workspace.slug }}" } } } })).status).toBe(200);
  });

  it("a client certificate towards the upstream is referenced by id, and its key reaches nodes sealed", async () => {
    const before = await h.lastSeq();
    const cert = await h.call("PUT", `${D}/certificates/upstream-client`, { body: { cert_pem: fixture("test-cert.crt"), key_pem: fixture("test-cert.key") } });
    const res = await h.call("PUT", `${D}/services/mtls`, { body: { scheme: "https", backends: [{ target: "10.0.1.1:443" }], tls: { client_certificate: "upstream-client" } } });
    expect(res.status).toBe(200);
    expect(res.json.tls.client_certificate).toBe(cert.json.id);
    const events = await h.events(before);
    expect(JSON.stringify(events)).not.toContain("PRIVATE KEY");
    expect(events.find((e) => e.data["kind"] === "certificate")!.data["data"].key_ciphertext).toMatch(/^v1:/);
  });
});

describe("certificates", () => {
  const cert = fixture("test-cert.crt");
  const key = fixture("test-cert.key");

  it("stores the key encrypted, never returns it, and sends nodes ciphertext only", async () => {
    const before = await h.lastSeq();
    const res = await h.call("POST", `${D}/certificates`, { body: { name: "api", cert_pem: cert, key_pem: key } });
    expect(res.status).toBe(201);
    expect(res.json.hosts).toEqual(["api.example.com", "*.wild.example.com"]);
    expect(res.json.fingerprint_sha256).toMatch(/^[0-9A-F:]+$/);
    expect(res.text).not.toContain("PRIVATE KEY");
    expect(res.json.key_pem).toBeUndefined();
    expect(res.json.key_ciphertext).toBeUndefined();

    const [event] = await h.events(before);
    expect(event!.data["data"].key_ciphertext).toMatch(/^v1:/);
    expect(JSON.stringify(event)).not.toContain("PRIVATE KEY");
    const marker = key.split("\n")[1]!;
    const row = await h.sql`SELECT key_ciphertext FROM apg_certificates WHERE name = 'api'`;
    expect(row[0]!["key_ciphertext"]).not.toContain(marker);
    expect(h.store.deps.box.open(row[0]!["key_ciphertext"], `certificate:${res.json.id}`)).toBe(key);
  });

  it("rejects a key that does not match, and garbage", async () => {
    const wrong = await h.call("POST", `${D}/certificates`, { body: { name: "bad", cert_pem: cert, key_pem: fixture("other.key") } });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error.details[0]).toMatchObject({ pointer: "/key_pem" });
    expect((await h.call("POST", `${D}/certificates`, { body: { name: "bad", cert_pem: "nope", key_pem: key } })).status).toBe(422);
  });

  it("a label can change without resending the key, and the key survives", async () => {
    const res = await h.call("PATCH", `${D}/certificates/api`, { body: { labels: { env: "prod" } } });
    expect(res.status).toBe(200);
    const row = await h.sql`SELECT key_ciphertext FROM apg_certificates WHERE name = 'api'`;
    expect(h.store.deps.box.open(row[0]!["key_ciphertext"], `certificate:${res.json.id}`)).toBe(key);
  });

  it("a certificate used by a domain cannot be deleted", async () => {
    expect((await h.call("POST", `${D}/domains`, { body: { hostname: "api.example.com", tls: { mode: "manual", certificate: "api" } } })).status).toBe(201);
    expect((await h.call("DELETE", `${D}/certificates/api`)).status).toBe(409);
    expect((await h.call("POST", `${D}/domains`, { body: { hostname: "nocert.example.com", tls: { mode: "manual" } } })).status).toBe(422);
  });
});

describe("consumers and credentials", () => {
  it("a generated key is shown once; nodes and the database get only its hash", async () => {
    expect((await h.call("POST", `${D}/consumers`, { body: { name: "mobile", custom_id: "client-42", groups: ["partners"] } })).status).toBe(201);
    const before = await h.lastSeq();
    const made = await h.call("POST", `${D}/consumers/mobile/credentials`, { body: { type: "key" } });
    expect(made.status).toBe(201);
    const secret: string = made.json.key;
    expect(secret).toMatch(/^apg_k_/);
    expect(made.json.key_prefix).toBe(secret.slice(0, 8));

    const again = await h.call("GET", `${D}/consumers/mobile/credentials/${made.json.id}`);
    expect(again.json.key).toBeUndefined();
    const [event] = await h.events(before);
    expect(event!.data["data"].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event)).not.toContain(secret);
    const audit = await h.sql`SELECT after FROM apg_audit_log WHERE kind = 'credential' ORDER BY id DESC LIMIT 1`;
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("a password is stored as an argon2id hash and never returned", async () => {
    const before = await h.lastSeq();
    const made = await h.call("POST", `${D}/consumers/mobile/credentials`, { body: { type: "basic", username: "mobile", password: "correct horse battery" } });
    expect(made.status).toBe(201);
    expect(made.text).not.toContain("correct horse");
    const [event] = await h.events(before);
    expect(event!.data["data"].password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(event)).not.toContain("correct horse");
  });

  it("the same key cannot be given to two credentials, and a type cannot change", async () => {
    const k = "imported-key-0123456789abcdef";
    const a = await h.call("POST", `${D}/consumers/mobile/credentials`, { body: { type: "key", name: "imported", key: k } });
    expect(a.status).toBe(201);
    expect(a.json.key).toBeUndefined(); // supplied keys are not echoed
    expect((await h.call("POST", `${D}/consumers/mobile/credentials`, { body: { type: "key", key: k } })).status).toBe(409);
    expect((await h.call("PUT", `${D}/consumers/mobile/credentials/imported`, { body: { type: "mtls", identity: "x" } })).status).toBe(422);
  });

  it("deleting a consumer deletes its credentials and tells nodes about each", async () => {
    await h.call("POST", `${D}/consumers`, { body: { name: "temp" } });
    await h.call("POST", `${D}/consumers/temp/credentials`, { body: { type: "mtls", identity: "temp.clients.example.com" } });
    const before = await h.lastSeq();
    expect((await h.call("DELETE", `${D}/consumers/temp`)).status).toBe(204);
    expect((await h.events(before)).map((e) => `${e.data["kind"]}:${e.data["op"]}`)).toEqual(["credential:delete", "consumer:delete"]);
  });
});

describe("plugins", () => {
  it("fills config defaults, and reports config faults under /config", async () => {
    await h.call("PUT", `${D}/services/plug`, { body: { backends: [{ target: "10.1.1.1:80" }] } });
    await h.call("PUT", `${D}/routes/plug`, { body: { service: "plug", hosts: ["plug.example.com"] } });
    const ok = await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route", scope_ref: "plug", config: { per_second: 5 } } });
    expect(ok.status).toBe(201);
    expect(ok.json.config).toEqual({ per_second: 5, burst: 200, scope: "workspace", store: "local", fail_open: true, response_headers: true });

    const bad = await h.call("POST", `${D}/plugins`, { body: { type: "bandwidth_limit", scope: "route", scope_ref: "plug", config: { bytes_per_sec: 1 } } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details[0].pointer).toBe("/config");
    expect(JSON.stringify(bad.json.error.details)).toContain("bytes_per_sec");
  });

  it("refuses a plugin type this build cannot enforce, rather than storing it", async () => {
    const res = await h.call("POST", `${D}/plugins`, { body: { type: "wasm", scope: "workspace", config: { module: "m" } } });
    expect(res.status).toBe(422);
    expect(res.json.error.message).toContain("not available in this build");
  });

  it("validates an authentication plugin's configuration and seals its secret", async () => {
    // Exactly one key source is required.
    const none = await h.call("POST", `${D}/plugins`, { body: { name: "jwt-none", type: "jwt_auth", scope: "workspace", config: { issuer: "x" } } });
    expect(none.status).toBe(422);
    // A secret-typed field never takes a bare string.
    const bare = await h.call("POST", `${D}/plugins`, { body: { name: "jwt-bare", type: "jwt_auth", scope: "workspace", config: { issuer: "x", secret: "plain-text", algorithms: ["HS256"] } } });
    expect(bare.status).toBe(422);
    // Credentials with an open wildcard is not a configuration a browser honours.
    const cors = await h.call("POST", `${D}/plugins`, { body: { name: "cors-bad", type: "cors", scope: "workspace", config: { origins: ["*"], credentials: true } } });
    expect(cors.status).toBe(422);

    const before = await h.lastSeq();
    const ok = await h.call("POST", `${D}/plugins`, {
      body: { name: "jwt-hs", type: "jwt_auth", scope: "workspace", enabled: false, config: { issuer: "x", secret: { $secret: "the-shared-secret" }, algorithms: ["HS256"] } },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.config.secret).toEqual({ $secret: "***" });
    expect(ok.json.config.leeway_secs).toBe(60);
    const [event] = await h.events(before);
    expect(JSON.stringify(event)).not.toContain("the-shared-secret");
    expect(event!.data["data"].config.secret.$secret_ciphertext).toMatch(/^v1:/);
    await h.call("DELETE", `${D}/plugins/jwt-hs`);
  });

  it("refuses plugin settings no node enforces and templates that do not compile", async () => {
    const redis = await h.call("POST", `${D}/plugins`, { body: { name: "rl-redis", type: "rate_limit", scope: "workspace", enabled: false, consumer: "mobile", config: { store: "redis" } } });
    expect(redis.status).toBe(422);
    expect(redis.json.error.details[0].pointer).toBe("/config/store");
    const template = await h.call("POST", `${D}/plugins`, { body: { name: "static-bad", type: "static_response", scope: "workspace", enabled: false, config: { body: "hello {{ nobody.home }}" } } });
    expect(template.status).toBe(422);
    expect(template.json.error.details[0]).toMatchObject({ pointer: "/config/body" });
    const ok = await h.call("POST", `${D}/plugins`, { body: { name: "static-ok", type: "static_response", scope: "workspace", enabled: false, config: { body: "hello {{ request.host }}" } } });
    expect(ok.status).toBe(201);
    await h.call("DELETE", `${D}/plugins/static-ok`);
  });

  it("allows one instance per type at each exact attachment point", async () => {
    const dup = await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route", scope_ref: "plug" } });
    expect(dup.status).toBe(409);
    // the same type for one consumer on the same route is a different attachment point
    const perConsumer = await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route", scope_ref: "plug", consumer: "mobile", enabled: false } });
    expect(perConsumer.status).toBe(201);
  });

  it("scope rules: global and target_workspace belong to the system workspace", async () => {
    expect((await h.call("POST", `${T()}/plugins`, { token: editor, body: { type: "rate_limit", scope: "global" } })).status).toBe(422);
    expect((await h.call("POST", `${T()}/plugins`, { token: editor, body: { type: "rate_limit", scope: "workspace", target_workspace: tenant.id } })).status).toBe(422);
    expect((await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "global" } })).status).toBe(201);
    expect((await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route", scope_ref: "plug", target_workspace: "acme", config: { per_second: 1 } } })).status).toBe(201);
    expect((await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route" } })).status).toBe(422);
  });

  it("effective-plugins shows the winner per type and what it shadows", async () => {
    const res = await h.call("GET", `${D}/routes/plug/effective-plugins`);
    const rl = res.json.data.find((x: any) => x.type === "rate_limit");
    expect(rl.applies).toMatchObject({ scope: "route", runs: true });
    expect(rl.shadowed.map((s: any) => s.scope)).toEqual(["global"]);
    expect(rl.conditional).toHaveLength(2);
    expect(rl.conditional.find((c: any) => c.when.consumer)).toMatchObject({ runs: false });
  });

  it("the setting workspace_plugin_types limits what a tenant may create", async () => {
    await h.call("PUT", "/v1/settings/workspace_plugin_types", { body: { value: ["bandwidth_limit"] } });
    expect((await h.call("POST", `${T()}/plugins`, { token: editor, body: { type: "rate_limit", scope: "workspace" } })).status).toBe(422);
    expect((await h.call("POST", `${T()}/plugins`, { token: editor, body: { type: "bandwidth_limit", scope: "workspace" } })).status).toBe(201);
  });
});

describe("flags, settings, idempotency, audit", () => {
  it("a flag change reaches nodes; an unknown flag or setting is rejected", async () => {
    const before = await h.lastSeq();
    expect((await h.call("PUT", "/v1/flags/usage_metering", { body: { enabled: false } })).json).toMatchObject({ enabled: false, revision: 1 });
    expect((await h.call("PUT", "/v1/flags/usage_metering", { body: { enabled: true } })).json.revision).toBe(2);
    expect((await h.events(before)).map((e) => e.data["data"].enabled)).toEqual([false, true]);
    expect((await h.call("PUT", "/v1/flags/make_it_fast", { body: { enabled: true } })).status).toBe(422);
    expect((await h.call("PUT", "/v1/settings/nope", { body: { value: 1 } })).status).toBe(422);
    expect((await h.call("PUT", "/v1/settings/workspace_resolvers", { body: { value: ["cookie"] } })).status).toBe(422);
  });

  it("an Idempotency-Key replays the first response instead of creating twice", async () => {
    const headers = { "idempotency-key": "k-1" };
    const body = { name: "idem", backends: [{ target: "10.3.3.3:80" }] };
    const a = await h.call("POST", `${D}/services`, { body, headers });
    const b = await h.call("POST", `${D}/services`, { body, headers });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.json.id).toBe(a.json.id);
    expect((await h.call("POST", `${D}/consumers`, { body: { name: "idem" }, headers })).status).toBe(409);
  });

  it("every change is audited with who, what and before/after; refusals are audited too", async () => {
    await h.call("PUT", `${D}/services/audited`, { body: { backends: [{ target: "10.4.4.4:80" }] } });
    await h.call("PATCH", `${D}/services/audited`, { body: { scheme: "https" } });
    const log = await h.call("GET", "/v1/audit?kind=service&limit=2");
    expect(log.json.data[0]).toMatchObject({ action: "update", kind: "service", resource_name: "audited", outcome: "ok", actor_kind: "token" });
    expect(log.json.data[0].before.scheme).toBe("http");
    expect(log.json.data[0].after.scheme).toBe("https");
    expect(log.json.data[1].action).toBe("create");

    await h.call("POST", `${T()}/consumers`, { token: viewer, body: { name: "x" } });
    await new Promise((r) => setTimeout(r, 200)); // refusals are recorded just after the response
    const refused = await h.sql`SELECT * FROM apg_audit_log WHERE outcome = 'refused' ORDER BY id DESC LIMIT 1`;
    expect(refused[0]!["action"]).toContain("/consumers");
  });

  it("a scoped caller can read its own audit trail but not the fleet's", async () => {
    expect((await h.call("GET", `/v1/audit?workspace=${tenant.id}`, { token: viewer })).status).toBe(200);
    expect((await h.call("GET", "/v1/audit", { token: viewer })).status).toBe(403);
    expect((await h.call("GET", "/v1/audit?workspace=default", { token: viewer })).status).toBe(404);
  });

  it("if the audit row cannot be written, neither the resource nor the event is (one transaction)", async () => {
    const before = await h.lastSeq();
    const original = h.store.audit.bind(h.store);
    h.store.audit = async () => { throw new Error("audit storage failed"); };
    try {
      const res = await h.call("POST", `${D}/services`, { body: { name: "atomic", backends: [{ target: "10.5.5.5:80" }] } });
      expect(res.status).toBe(500);
      expect(res.text).not.toContain("audit storage failed");
    } finally {
      h.store.audit = original;
    }
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_services WHERE name = 'atomic'`)[0]!["n"]).toBe(0);
    expect(await h.lastSeq()).toBe(before);
    expect((await h.events(before))).toHaveLength(0);
  });
});

describe("workspaces", () => {
  it("limits are enforced on create", async () => {
    const ws = (await h.call("POST", "/v1/workspaces", { body: { name: "small", limits: { max_consumers: 1 } } })).json;
    expect((await h.call("POST", `/v1/workspaces/${ws.id}/consumers`, { body: { name: "one" } })).status).toBe(201);
    const over = await h.call("POST", `/v1/workspaces/${ws.id}/consumers`, { body: { name: "two" } });
    expect(over.status).toBe(422);
    expect(over.json.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("the system workspace cannot be deleted or suspended; a workspace with content needs cascade", async () => {
    expect((await h.call("DELETE", "/v1/workspaces/default")).status).toBe(422);
    expect((await h.call("PATCH", "/v1/workspaces/default", { body: { status: "suspended" } })).status).toBe(422);
    expect((await h.call("DELETE", "/v1/workspaces/small")).status).toBe(409);
    const before = await h.lastSeq();
    expect((await h.call("DELETE", "/v1/workspaces/small?cascade=true")).status).toBe(204);
    expect((await h.events(before)).map((e) => `${e.data["kind"]}:${e.data["op"]}`)).toEqual(["consumer:delete", "workspace:delete"]);
  });

  it("a client may supply the workspace id, so a platform can reuse its own tenant id", async () => {
    const id = "0193f2a0-0000-7000-8000-00000000abcd";
    const res = await h.call("POST", "/v1/workspaces", { body: { id, name: "byo-id" } });
    expect(res.json.id).toBe(id);
    expect((await h.call("PATCH", `/v1/workspaces/${id}`, { body: { status: "suspended" } })).json.status).toBe("suspended");
  });
});

describe("nothing secret leaves in clear (SEC-8)", () => {
  it("no changelog row, audit row or list response contains a seeded secret", async () => {
    const needles = [fixture("test-cert.key").split("\n")[1]!, "correct horse battery", "imported-key-0123456789abcdef"];
    const haystack = JSON.stringify([
      await h.sql`SELECT data FROM apg_changes`,
      await h.sql`SELECT before, after FROM apg_audit_log`,
      (await h.call("GET", `${D}/certificates`)).json,
      (await h.call("GET", `${D}/consumers/mobile/credentials`)).json,
      (await h.call("GET", "/v1/tokens")).json,
    ]);
    for (const n of needles) expect(haystack.includes(n), n.slice(0, 12)).toBe(false);
    expect(haystack).not.toContain(h.tokens.admin);
  });
});
