// Routing, end to end: a real node, a real upstream, real sockets.
//
// The same steps run in every config mode (spec ARC-1: a routing behaviour that
// differs by mode is a bug). Only the way configuration reaches the node
// differs, and that is the driver's job:
//   file      the driver writes apg.yaml and the node reloads it
//   api_poll  the driver calls the Admin API and the node polls the changes
//
// Covers spec §5 (sources), §6 (request handling) and the two limit plugins.

import { writeFileSync } from "node:fs";
import { ADMIN, CONFIG, MGMT, MODE, NODE, NODE_TLS, REDIRECT, REDIRECT_TLS, admin, apply, seq } from "./lib/driver.js";
import { assert, http, step } from "./lib/harness.js";
import { send, sendH2, until } from "./lib/raw.js";

/** The configuration under test, as a document. JSON is YAML, so file mode writes it as is. */
function baseConfig() {
  return {
    version: 1,
    settings: {
      // No certificate is wanted for the base domain here; tls.js covers issuance.
      workspace_base_domains: [{ domain: "gw.test", tls: { mode: "none" } }],
      error_responses: {
        NO_ROUTE: {
          status: 404,
          content_type: "text/html",
          headers: { "x-brand": "acme" },
          body: "<h1>nothing here</h1><p>{{ request.id }} {{ error.code }} {{ request.host }}</p>",
        },
      },
    },
    services: [
      { name: "echo", shared: true, backends: [{ target: "echo:8080" }] },
      { name: "dead", backends: [{ target: "127.0.0.1:9" }] },
      { name: "named-host", host_header: "backend", backends: [{ target: "echo:8080" }] },
    ],
    routes: [
      { name: "api", service: "echo", hosts: ["api.test"], paths: ["/api"] },
      { name: "api-exact", service: "echo", hosts: ["api.test"], paths: [{ type: "exact", value: "/api/health" }], rewrite: { path: "/healthz" } },
      { name: "strip", service: "echo", hosts: ["api.test"], paths: ["/strip"], strip_path: true },
      { name: "rewrite", service: "echo", hosts: ["api.test"], paths: ["/old"], rewrite: { prefix: "/new" } },
      { name: "post-only", service: "echo", hosts: ["api.test"], paths: ["/submit"], methods: ["POST"] },
      { name: "versioned", service: "echo", hosts: ["api.test"], paths: ["/v"], headers: [{ name: "x-version", value: "2" }] },
      { name: "wildcard", service: "echo", hosts: ["*.wild.test"] },
      { name: "dead", service: "dead", hosts: ["dead.test"] },
      { name: "backend-host", service: "named-host", hosts: ["hosthdr.test"] },
      {
        name: "limited",
        service: "echo",
        hosts: ["limited.test"],
        plugins: [{ type: "rate_limit", config: { per_second: 0.001, burst: 2, scope: "header:x-run" } }],
      },
      {
        name: "metered",
        service: "echo",
        hosts: ["metered.test"],
        plugins: [{ type: "bandwidth_limit", config: { bytes_per_second: 0.001, burst_bytes: 100, scope: "header:x-run" } }],
      },
    ],
    workspaces: [
      {
        name: "acme",
        domains: [{ hostname: "shop.acme.test", tls: { mode: "none" } }],
        routes: [
          { name: "shop", service: "echo", hosts: ["shop.acme.test"] },
          { name: "slug", service: "echo", hosts: ["acme.gw.test"] },
        ],
      },
      {
        name: "frozen",
        status: "suspended",
        domains: [{ hostname: "frozen.test", tls: { mode: "none" } }],
        routes: [{ name: "f", service: "echo", hosts: ["frozen.test"] }],
      },
    ],
  };
}

const api = (path, opts = {}) => send(NODE, { host: "api.test", path, ...opts });

step("the node is ready and reports what it holds", async () => {
  await apply(baseConfig());
  const ready = await http("GET", `${MGMT}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ready, true);
  assert.equal(ready.json.source, MODE);
  const status = (await http("GET", `${MGMT}/status`)).json;
  assert.equal(status.counts.routes, 14);
  // a control plane may hold workspaces left by other suites; a file holds exactly these
  if (MODE === "file") assert.equal(status.counts.workspaces, 3);
  else assert.ok(status.counts.workspaces >= 3);
  assert.equal(status.counts.dangling_routes, 0);
});

step("a request is forwarded with the path unchanged and the client's Host preserved", async () => {
  const res = await api("/api/users?page=2");
  assert.equal(res.status, 200);
  assert.equal(res.json.path, "/api/users");
  assert.equal(res.json.query.page, "2");
  assert.equal(res.json.headers.host, "api.test");
});

step("forwarded and identity headers are set for the upstream (HDR)", async () => {
  const h = (await api("/api/x")).json.headers;
  assert.match(h["x-forwarded-for"], /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(h["x-real-ip"], h["x-forwarded-for"]);
  assert.equal(h["x-forwarded-proto"], "http");
  assert.equal(h["x-forwarded-host"], "api.test");
  assert.equal(h["x-forwarded-port"], "8080");
  assert.match(h["x-apg-workspace"], /^[0-9a-f-]{36}$/);
});

step("a request id is generated, sent upstream and echoed; a well-formed inbound id is kept", async () => {
  const fresh = await api("/api/x");
  assert.match(fresh.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  assert.equal(fresh.json.headers["x-request-id"], fresh.headers["x-request-id"]);
  const kept = await api("/api/x", { headers: { "x-request-id": "trace-abc.123" } });
  assert.equal(kept.headers["x-request-id"], "trace-abc.123");
  assert.equal(kept.json.headers["x-request-id"], "trace-abc.123");
  const bad = await api("/api/x", { headers: { "x-request-id": "has spaces!" } });
  assert.notEqual(bad.headers["x-request-id"], "has spaces!");
});

step("a client cannot forge identity headers or its own address (HDR-1, HDR-2)", async () => {
  const res = await api("/api/x", {
    headers: { "x-apg-workspace": "someone-else", "x-apg-consumer-id": "admin", "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" },
  });
  const h = res.json.headers;
  assert.notEqual(h["x-apg-workspace"], "someone-else");
  assert.equal(h["x-apg-consumer-id"], undefined);
  assert.ok(!h["x-forwarded-for"].includes("203.0.113.7"), h["x-forwarded-for"]);
  assert.notEqual(h["x-real-ip"], "203.0.113.7");
});

step("the most specific route wins: exact over prefix, and rewrite replaces the path", async () => {
  assert.equal((await api("/api/health")).json.path, "/healthz");
  assert.equal((await api("/api/health/deep")).json.path, "/api/health/deep");
});

step("strip_path removes the matched prefix; a prefix rewrite replaces it; the query survives", async () => {
  assert.equal((await api("/strip/a/b")).json.path, "/a/b");
  assert.equal((await api("/strip")).json.path, "/");
  const rw = await api("/old/item?x=1");
  assert.equal(rw.json.path, "/new/item");
  assert.equal(rw.json.query.x, "1");
});

step("method and header predicates gate a route", async () => {
  assert.equal((await api("/submit")).status, 404);
  assert.equal((await api("/submit", { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "2" } })).status, 200);
  assert.equal((await api("/v")).status, 404);
  assert.equal((await api("/v", { headers: { "x-version": "2" } })).status, 200);
  assert.equal((await api("/v", { headers: { "x-version": "3" } })).status, 404);
});

step("prefixes match on segment boundaries, hosts are case-insensitive, wildcards cover one label", async () => {
  assert.equal((await api("/apix")).status, 404);
  assert.equal((await send(NODE, { host: "API.Test:8080", path: "/api/x" })).status, 200);
  assert.equal((await send(NODE, { host: "a.wild.test", path: "/anything" })).status, 200);
  assert.equal((await send(NODE, { host: "a.b.wild.test", path: "/anything" })).status, 404);
  assert.equal((await send(NODE, { host: "wild.test", path: "/anything" })).status, 404);
});

step("no spelling of a path reaches a route its plain form would not (RT-3)", async () => {
  // dot segments are resolved before matching: this is /strip/x, and is forwarded as such
  const dots = await api("/api/../strip/x");
  assert.equal(dots.status, 200);
  assert.equal(dots.json.path, "/x");
  // an escaped unreserved character cannot dodge the route
  assert.equal((await api("/%61pi/users")).json.path, "/api/users");
  // duplicate slashes are merged
  assert.equal((await api("//api///users")).json.path, "/api/users");
  // climbing above the root is refused outright
  for (const path of ["/../etc/passwd", "/api/../../etc", "/%2e%2e/admin"]) {
    const res = await api(path);
    assert.equal(res.status, 400, path);
    assert.equal(res.json.error.code, "BAD_REQUEST");
    assert.equal(res.headers["x-apg-error"], "BAD_REQUEST");
  }
});

step("gateway errors use one JSON shape with the code in a header, and upstream responses are left alone", async () => {
  const res = await api("/nothing-here");
  assert.equal(res.status, 404);
  assert.equal(res.headers["x-apg-error"], "NO_ROUTE");
  const upstream404 = await api("/api/x", { headers: { "x-set-response-status-code": "404" } });
  assert.equal(upstream404.status, 404);
  assert.equal(upstream404.headers["x-apg-error"], undefined, "an upstream's own 404 is not marked as the gateway's");
});

step("an operator's custom error response replaces the default, with template variables filled in (ERR-2)", async () => {
  const res = await send(NODE, { host: "unknown.test", path: "/", headers: { "x-request-id": "req-77" } });
  assert.equal(res.status, 404);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.equal(res.headers["x-brand"], "acme");
  assert.equal(res.text, "<h1>nothing here</h1><p>req-77 NO_ROUTE unknown.test</p>");
});

step("tenants: a workspace serves its own hosts and its base-domain host, and nobody else's (DOM-1, DOM-2)", async () => {
  const shop = await send(NODE, { host: "shop.acme.test", path: "/cart" });
  assert.equal(shop.status, 200);
  const slug = await send(NODE, { host: "acme.gw.test", path: "/" });
  assert.equal(slug.status, 200);
  assert.equal(slug.json.headers["x-apg-workspace"], shop.json.headers["x-apg-workspace"]);
  const operator = await api("/api/x");
  assert.notEqual(operator.json.headers["x-apg-workspace"], shop.json.headers["x-apg-workspace"]);
  assert.equal((await send(NODE, { host: "rival.gw.test", path: "/" })).status, 404);
});

step("a suspended workspace answers 403", async () => {
  const res = await send(NODE, { host: "frozen.test", path: "/" });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, "WORKSPACE_SUSPENDED");
});

step("an unreachable upstream is a 502 in the standard shape, not a hang or a bare error", async () => {
  const res = await send(NODE, { host: "dead.test", path: "/" });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, "UPSTREAM_ERROR");
  assert.equal(res.headers["x-apg-error"], "UPSTREAM_ERROR");
  assert.ok(res.json.error.request_id);
});

step("host_header: backend sends the backend's name instead of the client's Host", async () => {
  assert.equal((await send(NODE, { host: "hosthdr.test", path: "/" })).json.headers.host, "echo:8080");
});

step("request bodies pass through unchanged, with or without a Content-Length", async () => {
  const payload = JSON.stringify({ hello: "world", n: 42 });
  const sized = await api("/api/echo", { method: "POST", body: payload, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } });
  assert.equal(sized.json.body, payload);
  const chunked = await api("/api/echo", { method: "POST", body: payload, headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
  assert.equal(chunked.json.body, payload);
  // a body larger than one read, to exercise streaming
  const big = "x".repeat(300_000);
  const large = await api("/api/echo", { method: "POST", body: big, headers: { "content-type": "text/plain", "content-length": String(big.length) } });
  assert.equal(large.status, 200);
  assert.equal(large.json.body.length, big.length);
});

step("rate_limit: a burst is allowed, then 429 with Retry-After and the remaining count", async () => {
  // The limit is keyed on a header, so each test run gets its own bucket: a
  // bucket outlives config reloads, which is the behaviour we want in production.
  const run = `run-${Date.now()}`;
  const limited = (who = run) => send(NODE, { host: "limited.test", path: "/", headers: { "x-run": who } });
  const a = await limited();
  const b = await limited();
  const c = await limited();
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
  assert.equal(a.headers["ratelimit-limit"], "2");
  assert.equal(a.headers["ratelimit-remaining"], "1");
  assert.equal(b.headers["ratelimit-remaining"], "0");
  assert.equal(c.json.error.code, "RATE_LIMITED");
  assert.ok(Number(c.headers["retry-after"]) >= 1);
  // another key has its own bucket, and reloading the config does not reset this one
  assert.equal((await limited(`${run}-other`)).status, 200);
  await apply(baseConfig());
  assert.equal((await limited()).status, 429, "a reload must not hand out a fresh burst");
  // other routes are unaffected
  assert.equal((await api("/api/x")).status, 200);
});

step("bandwidth_limit: the bytes a response actually used are charged, and the next request is refused", async () => {
  const run = `bw-${Date.now()}`;
  const metered = (who = run) => send(NODE, { host: "metered.test", path: "/", headers: { "x-run": who } });
  // The budget is 100 bytes. The first response is several hundred, which is
  // only known after it has been sent, so it is allowed and then charged.
  const first = await metered();
  assert.equal(first.status, 200);
  assert.ok(first.text.length > 100);
  const second = await metered();
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, "BANDWIDTH_LIMIT_EXCEEDED");
  assert.equal((await metered(`${run}-other`)).status, 200, "another key has its own budget");
});

step("TLS: HTTPS is served with the fallback certificate and the upstream is told the scheme", async () => {
  const res = await send(NODE_TLS, { host: "api.test", path: "/api/secure" });
  assert.equal(res.status, 200);
  assert.equal(res.json.headers["x-forwarded-proto"], "https");
  assert.equal(res.json.headers["x-forwarded-port"], "8443");
});

step("HTTP/2 is negotiated over TLS", async () => {
  const res = await sendH2(NODE_TLS, { host: "api.test", path: "/api/h2" });
  assert.equal(res.alpn, "h2");
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).path, "/api/h2");
});

step("in redirect mode plain HTTP answers 308 to the HTTPS URL, keeping path and query", async () => {
  const res = await send(REDIRECT, { host: "api.test", path: "/api/x?q=1" });
  assert.equal(res.status, 308);
  assert.equal(res.headers.location, "https://api.test:8443/api/x?q=1");
});

step("the traffic-port health path answers readiness without touching routes (DP-3)", async () => {
  const res = await send(REDIRECT, { host: "whatever", path: "/_apg/health" });
  assert.equal(res.status, 200);
  assert.equal(res.text, "ready\n");
  // on a node that did not ask for it, the same path is just a path
  assert.equal((await send(NODE, { host: "api.test", path: "/_apg/health" })).status, 404);
});

step("behind a trusted proxy the forwarded client address is honoured (HDR-2)", async () => {
  const res = await send(REDIRECT_TLS, { host: "api.test", path: "/api/x", headers: { "x-forwarded-for": "203.0.113.7" } });
  const h = res.json.headers;
  assert.equal(h["x-real-ip"], "203.0.113.7");
  assert.match(h["x-forwarded-for"], /^203\.0\.113\.7, \d+\.\d+\.\d+\.\d+$/);
  // a client-supplied hop to the left of the real one is not believed
  const spoof = await send(REDIRECT_TLS, { host: "api.test", path: "/api/x", headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.1.2.3" } });
  assert.equal(spoof.json.headers["x-real-ip"], "203.0.113.7");
});

step("metrics are exposed on the management port only", async () => {
  const m = await http("GET", `${MGMT}/metrics`);
  assert.ok(/apg_requests_total{route="[^"]+",service="[^"]+",status_class="2xx"}/.test(m.text));
  assert.ok(m.text.includes('apg_gateway_errors_total{code="NO_ROUTE"}'));
  assert.ok(m.text.includes('apg_limited_total{type="rate_limit"}'));
  // the traffic listener does not serve them: /metrics there is just an unmatched path
  assert.equal((await api("/metrics")).status, 404);
  assert.equal((await api("/healthz")).status, 404);
});

step("editing the file changes routing without a restart", async () => {
  const doc = baseConfig();
  doc.routes.push({ name: "late", service: "echo", hosts: ["late.test"] });
  await apply(doc);
  assert.equal((await send(NODE, { host: "late.test", path: "/" })).status, 200);
  assert.equal((await api("/api/x")).status, 200);
});

if (MODE !== "file") {
  step("an invalid change is refused by the control plane and never reaches a node", async () => {
    const before = await seq(MGMT);
    const res = await http("POST", `${ADMIN}/v1/workspaces/default/routes`, { headers: admin, body: { name: "broken", service: "does-not-exist" } });
    assert.equal(res.status, 422);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await seq(MGMT), before, "no change was published");
    assert.equal((await send(NODE, { host: "late.test", path: "/" })).status, 200);
  });

  step("every node reports to the control plane, in step with it", async () => {
    // Heartbeats go out every ten seconds.
    const fleet = await until(
      async () => {
        const res = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json;
        const mine = res.data.filter((n) => ["node-1", "node-redirect"].includes(n.node_id) && n.live && n.lag === 0);
        return mine.length === 2 ? mine : null;
      },
      { timeoutMs: 30000, everyMs: 1000, what: "both nodes to heartbeat with no lag" },
    );
    assert.deepEqual(fleet.map((n) => n.source), ["api_poll", "api_poll"]);
    assert.ok(fleet.every((n) => n.info.counts.routes >= 14));
  });
}

if (MODE === "file") step("an invalid edit is rejected whole: the node keeps serving the previous configuration (CFG-18)", async () => {
  const failures = async () => Number(/apg_config_reload_failures_total (\d+)/.exec((await http("GET", `${MGMT}/metrics`)).text)?.[1] ?? 0);
  const before = { seq: await seq(MGMT), failures: await failures() };
  writeFileSync(CONFIG, "version: 1\nroutes:\n  - { name: broken, service: does-not-exist }\n");
  await until(async () => (await failures()) > before.failures, { what: "the node to notice and reject the bad file" });
  assert.equal(await seq(MGMT), before.seq, "nothing was applied");
  assert.equal((await send(NODE, { host: "late.test", path: "/" })).status, 200, "the route from the last good file still works");
  assert.equal((await http("GET", `${MGMT}/readyz`)).status, 200, "and the node is still ready");
});

step("a later valid file is picked up, and removed routes stop matching", async () => {
  await apply(baseConfig());
  assert.equal((await send(NODE, { host: "late.test", path: "/" })).status, 404);
  assert.equal((await api("/api/x")).status, 200);
});
