// Tenant isolation and the egress guard, end to end (spec SEC-4, SEC-7): two
// tenants with their own tokens, domains, consumers and routes, and every way
// one of them might reach into the other, through the Admin API and through
// real nodes.
//
// Needs a control plane, so it runs in api_poll mode only. The secrets used
// here start with "leak-canary"; tests/e2e/security.sh searches the logs of
// every container for them afterwards (SEC-8).

import { NODE, adminCall } from "./lib/driver.js";
import { assert, http, step } from "./lib/harness.js";
import { send, until } from "./lib/raw.js";

const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
const RUN = Date.now().toString(36);
const KEY = { a: `leak-canary-tenant-a-key-${RUN}`, b: `leak-canary-tenant-b-key-${RUN}` };
const ws = {};
const token = {};

const as = (who) => async (method, path, body) => http(method, `${ADMIN}${path}`, { headers: { authorization: `Bearer ${token[who]}` }, body });
const call = (host, opts = {}) => send(NODE, { host, path: "/", ...opts });

step("two tenants are set up, each with its own token, domain, consumer and routes", async () => {
  for (const t of ["a", "b"]) {
    const name = `sec-${t}`;
    const found = await http("GET", `${ADMIN}/v1/workspaces/${name}`, { headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
    ws[t] = found.status === 200 ? found.json : (await adminCall("POST", "/v1/workspaces", { name })).json;
    token[t] = (await adminCall("POST", "/v1/tokens", { name: `sec-${t}-${RUN}`, role: "editor", workspaces: [ws[t].id] })).json.token;
    const base = `/v1/workspaces/${name}`;
    await adminCall("PUT", `${base}/domains/${t}.sec.test`, { hostname: `${t}.sec.test`, tls: { mode: "none" } });
    // The operator provides the upstream; a tenant may not point at a private address itself (see the egress step).
    await adminCall("PUT", `${base}/services/echo`, { backends: [{ target: "echo:8080" }] });
    await adminCall("PUT", `${base}/consumers/app`, {});
    await adminCall("PUT", `${base}/consumers/app/credentials/key`, { type: "key", key: KEY[t] });
    await adminCall("PUT", `${base}/routes/api`, { service: "echo", hosts: [`${t}.sec.test`], paths: ["/"] });
    await adminCall("PUT", `${base}/plugins/api-key`, { type: "key_auth", scope: "route", scope_ref: "api", config: {} });
    await adminCall("PUT", `${base}/routes/limited`, { service: "echo", hosts: [`${t}.sec.test`], paths: ["/limited"] });
    await adminCall("PUT", `${base}/plugins/limited-key`, { type: "key_auth", scope: "route", scope_ref: "limited", config: {} });
    await adminCall("PUT", `${base}/plugins/limited-rate`, { type: "rate_limit", scope: "route", scope_ref: "limited", config: { per_second: 0.001, burst: 2, scope: "consumer" } });
    await adminCall("PUT", `${base}/routes/cached`, { service: "echo", hosts: [`${t}.sec.test`], paths: ["/cached"] });
    await adminCall("PUT", `${base}/plugins/cached-cache`, { type: "response_cache", scope: "route", scope_ref: "cached", config: { ttl_secs: 60 } });
  }
  await until(async () => (await call("a.sec.test", { headers: { "x-api-key": KEY.a } })).status === 200 && (await call("b.sec.test", { headers: { "x-api-key": KEY.b } })).status === 200, { what: "both tenants' routes to be served" });
});

step("Admin API: a tenant's token reads and writes its own workspace, and the other reads as not found", async () => {
  const a = as("a");
  assert.equal((await a("GET", "/v1/workspaces/sec-a/routes")).status, 200);
  assert.deepEqual((await a("GET", "/v1/workspaces")).json.data.map((w) => w.name), ["sec-a"]);
  const missing = await a("GET", "/v1/workspaces/no-such-workspace/routes");
  for (const [method, path, body] of [
    ["GET", "/v1/workspaces/sec-b/routes"], ["GET", `/v1/workspaces/${ws.b.id}/consumers`], ["GET", "/v1/workspaces/sec-b/consumers/app/credentials"],
    ["PUT", "/v1/workspaces/sec-b/routes/planted", { service: "echo", hosts: ["b.sec.test"] }], ["DELETE", "/v1/workspaces/sec-b/routes/api"],
    ["GET", "/v1/config/dump?workspace=sec-b"], ["GET", "/v1/config/revisions?workspace=sec-b"], ["GET", "/v1/audit?workspace=sec-b"], ["GET", "/v1/usage?workspace=sec-b"],
    ["POST", "/v1/config/apply", { document: { version: 1, workspace: "sec-b", services: [{ name: "planted", backends: [{ target: "example.com:80" }] }] } }],
    ["GET", "/v1/workspaces/default/services"],
  ]) {
    const res = await a(method, path, body);
    // Not found, with the same words as a workspace that does not exist: its existence is not revealed.
    assert.equal(res.status, 404, `${method} ${path} -> ${res.status} ${res.text}`);
    assert.equal(res.json.error.message, missing.json.error.message, `${method} ${path}`);
  }
  // Fleet-wide views are for fleet admins.
  for (const path of ["/v1/tokens", "/v1/nodes", "/v1/settings", "/v1/flags", "/v1/audit", "/v1/usage"]) assert.equal((await a("GET", path)).status, 403, path);
  assert.equal((await adminCall("GET", "/v1/workspaces/sec-b/routes")).json.data.some((r) => r.name === "planted"), false);
});

step("Admin API: a tenant cannot route a host it does not own, nor claim one that is taken", async () => {
  const a = as("a");
  const steal = await a("PUT", "/v1/workspaces/sec-a/routes/steal", { service: "echo", hosts: ["b.sec.test"] });
  assert.equal(steal.status, 422, steal.text);
  assert.equal(steal.json.error.code, "HOST_NOT_OWNED");
  const hostless = await a("PUT", "/v1/workspaces/sec-a/routes/catch-all", { service: "echo", paths: ["/"] });
  assert.equal(hostless.json.error.code, "HOST_NOT_OWNED", "a tenant route with no host would match every host");
  const claim = await a("PUT", "/v1/workspaces/sec-a/domains/claimed", { hostname: "b.sec.test", tls: { mode: "none" } });
  assert.equal(claim.status, 409, claim.text);
  assert.doesNotMatch(claim.text, /sec-b/, "the refusal does not say who owns it");
  // A plugin cannot be attached across the boundary, by name or by id.
  const routeB = (await adminCall("GET", "/v1/workspaces/sec-b/routes/api")).json.id;
  assert.equal((await a("POST", "/v1/workspaces/sec-a/plugins", { type: "static_response", scope: "route", scope_ref: routeB, config: { status: 500 } })).status, 422);
  assert.equal((await a("POST", "/v1/workspaces/sec-a/plugins", { type: "cors", scope: "global", config: { origins: ["*"] } })).status, 422, "a tenant cannot attach a global plugin");
});

step("Admin API: the egress guard stops a tenant pointing the gateway at private addresses (SEC-4)", async () => {
  const a = as("a");
  for (const target of ["127.0.0.1:5432", "169.254.169.254:80", "10.0.0.5:8080", "[::1]:80", "echo:8080"]) {
    const res = await a("PUT", "/v1/workspaces/sec-a/services/inside", { backends: [{ target }] });
    assert.equal(res.status, 422, `${target} -> ${res.status} ${res.text}`);
    assert.equal(res.json.error.code, "EGRESS_NOT_ALLOWED", target);
  }
  for (const [type, config] of [
    ["forward_auth", { url: "http://169.254.169.254/latest/meta-data/" }],
    ["http_callout", { url: "http://admin:9000/v1/tokens", phases: ["request"] }],
    ["jwt_auth", { issuer: "https://issuer.example", jwks_url: "http://127.0.0.1:9000/jwks" }],
  ]) {
    const res = await a("POST", "/v1/workspaces/sec-a/plugins", { type, scope: "workspace", config });
    assert.equal(res.json?.error?.code, "EGRESS_NOT_ALLOWED", `${type}: ${res.status} ${res.text}`);
  }
  assert.equal((await adminCall("GET", "/v1/workspaces/sec-a/services")).json.data.some((s) => s.name === "inside"), false);
});

step("nodes: one tenant's key is not a key on the other tenant's route", async () => {
  assert.equal((await call("a.sec.test", { headers: { "x-api-key": KEY.a } })).status, 200);
  assert.equal((await call("b.sec.test", { headers: { "x-api-key": KEY.a } })).status, 401);
  assert.equal((await call("a.sec.test", { headers: { "x-api-key": KEY.b } })).status, 401);
  // Both consumers are called "app"; the upstream is told which tenant's.
  const [seenA, seenB] = [await call("a.sec.test", { headers: { "x-api-key": KEY.a } }), await call("b.sec.test", { headers: { "x-api-key": KEY.b } })];
  assert.equal(seenA.json.headers["x-apg-consumer-name"], "app");
  assert.notEqual(seenA.json.headers["x-apg-consumer-id"], seenB.json.headers["x-apg-consumer-id"]);
  assert.equal(seenA.json.headers["x-api-key"], undefined, "the key is not passed upstream");
});

step("nodes: identity headers a client sends are not believed", async () => {
  const forged = await call("a.sec.test", { headers: { "x-api-key": KEY.a, "x-apg-consumer-name": "admin", "x-apg-workspace-id": ws.b.id, "x-apg-consumer-id": "forged" } });
  assert.equal(forged.status, 200);
  assert.equal(forged.json.headers["x-apg-consumer-name"], "app");
  assert.notEqual(forged.json.headers["x-apg-consumer-id"], "forged");
  assert.notEqual(forged.json.headers["x-apg-workspace-id"], ws.b.id);
});

step("nodes: a limit used up in one tenant leaves the same-named consumer of the other untouched", async () => {
  const hit = (t) => call(`${t}.sec.test`, { path: "/limited", headers: { "x-api-key": KEY[t] } });
  assert.deepEqual([(await hit("a")).status, (await hit("a")).status, (await hit("a")).status], [200, 200, 429]);
  assert.equal((await hit("b")).status, 200, "tenant b has its own bucket");
});

step("nodes: a cached response of one tenant is never served to the other", async () => {
  const path = `/cached/${RUN}`;
  const firstA = await call("a.sec.test", { path });
  assert.equal(firstA.headers["x-apg-cache"], "MISS");
  assert.equal((await call("a.sec.test", { path })).headers["x-apg-cache"], "HIT");
  const firstB = await call("b.sec.test", { path });
  assert.equal(firstB.headers["x-apg-cache"], "MISS", "same path, other tenant: not a hit");
  assert.equal(firstB.json.headers.host !== firstA.json.headers.host || firstB.json.headers["x-request-id"] !== firstA.json.headers["x-request-id"], true);
});

step("nodes: suspending one tenant stops its traffic and nobody else's", async () => {
  await adminCall("PATCH", "/v1/workspaces/sec-a", { status: "suspended" });
  try {
    await until(async () => (await call("a.sec.test", { headers: { "x-api-key": KEY.a } })).status >= 400, { what: "the suspension to reach the node" });
    const refused = await call("a.sec.test", { headers: { "x-api-key": KEY.a } });
    assert.ok(refused.headers["x-apg-error"], "the refusal comes from the gateway, not the upstream");
    assert.equal((await call("b.sec.test", { headers: { "x-api-key": KEY.b } })).status, 200);
  } finally {
    await adminCall("PATCH", "/v1/workspaces/sec-a", { status: "active" });
  }
  await until(async () => (await call("a.sec.test", { headers: { "x-api-key": KEY.a } })).status === 200, { what: "the tenant to be served again" });
});

step("the node's own endpoints show no key", async () => {
  const mgmt = process.env.NODE_MGMT ?? "http://node:9100";
  for (const path of ["/status", "/metrics", "/readyz", "/debug/match?host=a.sec.test&path=/"]) {
    const res = await http("GET", `${mgmt}${path}`);
    assert.equal(res.status, 200, path);
    for (const key of Object.values(KEY)) assert.equal(res.text.includes(key), false, `${path} shows a key`);
  }
});

step("the tenants are removed", async () => {
  for (const t of ["a", "b"]) {
    await adminCall("DELETE", `/v1/tokens/sec-${t}-${RUN}`);
    await adminCall("DELETE", `/v1/workspaces/sec-${t}?cascade=true`);
  }
  await until(async () => (await call("a.sec.test", { headers: { "x-api-key": KEY.a } })).status === 404, { what: "the routes to be gone from the node" });
});
