#!/usr/bin/env node
// Smoke test for a running valkv-apg deployment (spec PKG-6).
//
// It configures a set of routes of its own, sends real requests through the
// gateway, and prints, for every feature, what was expected and what happened.
// Everything it creates is labelled suite=smoke and removed at the end.
//
//   APG_ADMIN_URL      the Admin API, for example http://localhost:9000
//   APG_ADMIN_TOKEN    an admin token
//   APG_GATEWAY_URL    where clients reach the gateway over HTTP, for example http://localhost:8080
//   SMOKE_UPSTREAM     host:port of an upstream that echoes requests as JSON (default echo:8080)
//   SMOKE_TLS_URL      optional: the HTTPS address, to check that TLS answers
//   SMOKE_KEEP=1       leave the smoke configuration in place afterwards
//   SMOKE_SKIP_USAGE=1 do not wait (up to two minutes) for usage to be reported
//
// Needs Node 20 or newer and nothing else. Exit code 1 when any check fails.

import http from "node:http";
import https from "node:https";

const ADMIN = (process.env.APG_ADMIN_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.APG_ADMIN_TOKEN ?? "";
const GATEWAY = (process.env.APG_GATEWAY_URL ?? "").replace(/\/+$/, "");
const UPSTREAM = process.env.SMOKE_UPSTREAM ?? "echo:8080";
const TLS_URL = process.env.SMOKE_TLS_URL;
if (!ADMIN || !TOKEN || !GATEWAY) {
  console.error("Set APG_ADMIN_URL, APG_ADMIN_TOKEN and APG_GATEWAY_URL. See the top of this file.");
  process.exit(2);
}

const RUN = `r${Date.now().toString(36)}`;
const KEY_STAFF = `smoke-staff-${RUN}-0123456789abcdef`;
const KEY_GUEST = `smoke-guest-${RUN}-0123456789abcdef`;
const PASSWORD = `smoke-password-${RUN}`;
const host = (name) => `${name}.smoke.test`;

// ── Plumbing ─────────────────────────────────────────────────────────────────

async function admin(method, path, body) {
  const res = await fetch(`${ADMIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text };
}

/** One request through the gateway with a chosen Host header. Never throws on a status. */
function send(name, { method = "GET", path = "/", headers = {}, body, base = GATEWAY } = {}) {
  const url = new URL(base + path);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = lib.request({
      method, hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search,
      headers: { host: host(name), ...headers, ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}) },
      rejectUnauthorized: false, servername: host(name), timeout: 10_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ status: 0, headers: {}, text: String(err.message), json: undefined }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 20_000, every = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(every);
  }
  return last ?? { ok: false, actual: "timed out" };
}

const results = [];
/** Records one check. `fn` returns { ok, actual }. */
async function check(feature, expected, fn) {
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = { ok: false, actual: `error: ${err.message}` };
  }
  results.push({ feature, expected, actual: String(outcome.actual), ok: Boolean(outcome.ok) });
  console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${feature}`);
  return outcome.ok;
}
const status = (res, want) => ({ ok: res.status === want, actual: `${res.status}${res.headers["x-apg-error"] ? ` ${res.headers["x-apg-error"]}` : res.status === 0 ? ` ${res.text}` : ""}` });

// ── The configuration under test ─────────────────────────────────────────────

const labels = { suite: "smoke" };
const route = (name, plugins = [], extra = {}) => ({ name: `smoke-${name}`, labels, service: "smoke-echo", hosts: [host(name)], plugins: plugins.map((p) => ({ ...p, labels })), ...extra });
const document = {
  version: 1,
  services: [{ name: "smoke-echo", labels, backends: [{ target: UPSTREAM }] }],
  consumers: [
    { name: "smoke-staff", labels, groups: ["smoke-staff"], credentials: [{ name: "key", type: "key", key: KEY_STAFF, labels }, { name: "login", type: "basic", username: `smoke-${RUN}`, password: PASSWORD, labels }] },
    { name: "smoke-guest", labels, groups: ["smoke-guests"], credentials: [{ name: "key", type: "key", key: KEY_GUEST, labels }] },
  ],
  routes: [
    route("plain", [], { paths: ["/"] }),
    route("methods", [], { methods: ["POST"] }),
    route("paths", [], { paths: ["/only-here"] }),
    route("key", [{ type: "key_auth" }]),
    route("basic", [{ type: "basic_auth" }]),
    route("acl", [{ type: "key_auth" }, { type: "acl", config: { allow: ["smoke-staff"] } }]),
    route("ip", [{ type: "ip_restriction", config: { deny: ["0.0.0.0/0", "::/0"] } }]),
    route("size", [{ type: "request_size_limit", config: { max_bytes: 100 } }]),
    route("cors", [{ type: "cors", config: { origins: ["https://app.smoke.test"] } }]),
    route("rate", [{ type: "rate_limit", config: { per_second: 0.001, burst: 2, scope: "header:x-smoke-run" } }]),
    route("quota", [{ type: "quota", config: { limit: 2, window: "hour", scope: "header:x-smoke-run" } }]),
    route("redirect", [{ type: "redirect", config: { status: 301, host: "new.smoke.test", path: "/moved{{ request.path }}" } }]),
    route("static", [{ type: "static_response", config: { status: 503, content_type: "text/plain", body: "maintenance on {{ request.host }}" } }]),
    route("reqtx", [{ type: "request_transformer", config: { headers: { set: { "x-smoke-added": "{{ route.name }}" } } } }]),
    route("resptx", [{ type: "response_transformer", config: { headers: { set: { "x-smoke-served-by": "apg" } } } }]),
    route("gzip", [{ type: "compression", config: { min_bytes: 10, algorithms: ["gzip"] } }]),
    route("cache", [{ type: "response_cache", config: { ttl_secs: 30 } }]),
  ],
};

async function cleanup() {
  return admin("POST", "/v1/config/sync", { document: { version: 1 }, select_label: "suite=smoke", message: "smoke test cleanup" });
}

// ── Checks ───────────────────────────────────────────────────────────────────

console.log(`valkv-apg smoke test, run ${RUN}\n  admin    ${ADMIN}\n  gateway  ${GATEWAY}\n  upstream ${UPSTREAM}\n`);

const up = await check("Control plane is ready", "200 from /readyz", async () => {
  const res = await fetch(`${ADMIN}/readyz`).catch((e) => ({ status: 0, text: async () => e.message }));
  return { ok: res.status === 200, actual: res.status === 0 ? `unreachable: ${await res.text()}` : res.status };
});
const authed = up && await check("The admin token is accepted", "200 from /v1/session with the admin role", async () => {
  const res = await admin("GET", "/v1/session");
  return { ok: res.status === 200 && res.json?.actor?.fleet_admin === true, actual: res.status === 200 ? `role ${res.json.actor.role}${res.json.actor.fleet_admin ? "" : ", not fleet-wide"}` : `${res.status} ${res.json?.error?.message ?? ""}` };
});

let applied = false;
if (authed) {
  await cleanup(); // leftovers of an interrupted run
  applied = await check("A configuration document applies in one step", "apply creates 1 service, 2 consumers, 17 routes and their plugins", async () => {
    const res = await admin("POST", "/v1/config/apply", { document, message: `smoke test ${RUN}` });
    return { ok: res.status === 200 && res.json.summary.create >= 35, actual: res.status === 200 ? `${res.json.summary.create} created` : `${res.status} ${res.json?.error?.message ?? res.text}` };
  });
}

if (applied) {
  await check("Every node receives the change", "every live node up to date within 20 s", async () => until(async () => {
    const res = await admin("GET", "/v1/nodes");
    const live = (res.json?.data ?? []).filter((n) => n.live);
    const behind = live.filter((n) => n.lag > 0);
    return { ok: live.length > 0 && behind.length === 0, actual: live.length === 0 ? "no live node reported" : behind.length === 0 ? `${live.length} node(s) up to date` : `${behind.length} of ${live.length} node(s) behind` };
  }));

  await check("Routing by host", "200, and the upstream sees the path", async () => until(async () => {
    const res = await send("plain", { path: "/hello/world?x=1" });
    return { ok: res.status === 200 && res.json?.path === "/hello/world", actual: res.status === 200 ? `200, upstream path ${res.json?.path}` : status(res, 200).actual };
  }));
  await check("An unknown host has no route", "404 NO_ROUTE", async () => {
    const res = await send("nobody-home");
    return { ok: res.status === 404 && res.headers["x-apg-error"] === "NO_ROUTE", actual: status(res, 404).actual };
  });
  await check("Routing by method", "POST 200, GET 404", async () => {
    const [post, get] = [await send("methods", { method: "POST", body: "{}" }), await send("methods")];
    return { ok: post.status === 200 && get.status === 404, actual: `POST ${post.status}, GET ${get.status}` };
  });
  await check("Routing by path", "/only-here 200, /elsewhere 404", async () => {
    const [here, there] = [await send("paths", { path: "/only-here/x" }), await send("paths", { path: "/elsewhere" })];
    return { ok: here.status === 200 && there.status === 404, actual: `/only-here ${here.status}, /elsewhere ${there.status}` };
  });

  await check("API key authentication", "no key 401, right key 200 as smoke-staff, key not forwarded", async () => {
    const [none, good] = [await send("key"), await send("key", { headers: { "x-api-key": KEY_STAFF } })];
    const consumer = good.json?.headers?.["x-apg-consumer-name"];
    const leaked = good.json?.headers?.["x-api-key"] !== undefined;
    return { ok: none.status === 401 && good.status === 200 && consumer === "smoke-staff" && !leaked, actual: `no key ${none.status}, right key ${good.status} as ${consumer}${leaked ? ", key forwarded" : ""}` };
  });
  await check("Basic authentication", "no password 401, right password 200", async () => {
    const basic = Buffer.from(`smoke-${RUN}:${PASSWORD}`).toString("base64");
    const [none, good] = [await send("basic"), await send("basic", { headers: { authorization: `Basic ${basic}` } })];
    return { ok: none.status === 401 && good.status === 200, actual: `no password ${none.status}, right password ${good.status}` };
  });
  await check("Access control by group", "staff 200, guest 403", async () => {
    const [staff, guest] = [await send("acl", { headers: { "x-api-key": KEY_STAFF } }), await send("acl", { headers: { "x-api-key": KEY_GUEST } })];
    return { ok: staff.status === 200 && guest.status === 403, actual: `staff ${staff.status}, guest ${guest.status}` };
  });
  await check("IP restriction", "403 for a denied address", async () => status(await send("ip"), 403));
  await check("Request size limit", "small body 200, 500-byte body 413", async () => {
    const [small, big] = [await send("size", { method: "POST", body: "ok" }), await send("size", { method: "POST", body: "x".repeat(500) })];
    return { ok: small.status === 200 && big.status === 413, actual: `small ${small.status}, large ${big.status}` };
  });
  await check("CORS preflight", "allowed origin echoed, other origin not", async () => {
    const ask = (origin) => send("cors", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
    const [ok, other] = [await ask("https://app.smoke.test"), await ask("https://evil.smoke.test")];
    const allowed = ok.headers["access-control-allow-origin"];
    return { ok: allowed === "https://app.smoke.test" && other.headers["access-control-allow-origin"] === undefined, actual: `allowed origin got ${allowed ?? "no header"}, other origin got ${other.headers["access-control-allow-origin"] ?? "no header"}` };
  });
  await check("Rate limit", "2 requests pass, the 3rd is 429 with Retry-After", async () => {
    const codes = [];
    let retry;
    for (let i = 0; i < 3; i++) {
      const res = await send("rate", { headers: { "x-smoke-run": RUN } });
      codes.push(res.status);
      retry = res.headers["retry-after"];
    }
    return { ok: codes.join() === "200,200,429" && retry !== undefined, actual: `${codes.join(", ")}${retry ? `, Retry-After ${retry}` : ", no Retry-After"}` };
  });
  await check("Quota", "2 requests pass, the 3rd is 429 QUOTA_EXCEEDED", async () => {
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await send("quota", { headers: { "x-smoke-run": RUN } }));
    return { ok: out.map((r) => r.status).join() === "200,200,429" && out[2].headers["x-apg-error"] === "QUOTA_EXCEEDED", actual: `${out.map((r) => r.status).join(", ")} ${out[2].headers["x-apg-error"] ?? ""}` };
  });
  await check("Redirect", "301 to http(s)://new.smoke.test/moved/page", async () => {
    const res = await send("redirect", { path: "/page" });
    return { ok: res.status === 301 && /^https?:\/\/new\.smoke\.test\/moved\/page$/.test(res.headers.location ?? ""), actual: `${res.status} to ${res.headers.location ?? "nowhere"}` };
  });
  await check("Static response", "503 with the configured body, upstream not called", async () => {
    const res = await send("static");
    return { ok: res.status === 503 && res.text === `maintenance on ${host("static")}`, actual: `${res.status} "${res.text.slice(0, 60)}"` };
  });
  await check("Request transformer", "the upstream sees the added header", async () => {
    const res = await send("reqtx");
    const seen = res.json?.headers?.["x-smoke-added"];
    return { ok: seen === "smoke-reqtx", actual: seen === undefined ? `${res.status}, header missing` : `header = ${seen}` };
  });
  await check("Response transformer", "the client sees the added header", async () => {
    const res = await send("resptx");
    return { ok: res.headers["x-smoke-served-by"] === "apg", actual: res.headers["x-smoke-served-by"] === undefined ? `${res.status}, header missing` : `header = ${res.headers["x-smoke-served-by"]}` };
  });
  await check("Compression", "gzip when the client accepts it, none otherwise", async () => {
    const [gz, plain] = [await send("gzip", { headers: { "accept-encoding": "gzip" } }), await send("gzip")];
    return { ok: gz.headers["content-encoding"] === "gzip" && plain.headers["content-encoding"] === undefined, actual: `with Accept-Encoding: ${gz.headers["content-encoding"] ?? "none"}; without: ${plain.headers["content-encoding"] ?? "none"}` };
  });
  await check("Response cache", "first request MISS, second HIT", async () => {
    const path = `/cached-${RUN}`;
    const [first, second] = [await send("cache", { path }), await send("cache", { path })];
    return { ok: first.headers["x-apg-cache"] === "MISS" && second.headers["x-apg-cache"] === "HIT", actual: `${first.headers["x-apg-cache"] ?? "no header"}, then ${second.headers["x-apg-cache"] ?? "no header"}` };
  });
  await check("Every response carries a request id", "X-Request-Id on a proxied and on a refused response", async () => {
    const [ok, refused] = [await send("plain"), await send("key")];
    return { ok: Boolean(ok.headers["x-request-id"] && refused.headers["x-request-id"]), actual: `proxied: ${ok.headers["x-request-id"] ? "present" : "missing"}; refused: ${refused.headers["x-request-id"] ? "present" : "missing"}` };
  });

  if (TLS_URL) {
    await check("TLS answers", "a TLS handshake and an HTTP response", async () => {
      const res = await send("plain", { base: TLS_URL.replace(/\/+$/, "") });
      return { ok: res.status > 0, actual: res.status > 0 ? `handshake ok, status ${res.status}` : res.text };
    });
  }

  await check("A changed route takes effect on the nodes", "after a patch, the route answers on its new path within 20 s", async () => {
    const patch = await admin("PATCH", "/v1/workspaces/default/routes/smoke-paths", { paths: ["/moved-here"] });
    if (patch.status !== 200) return { ok: false, actual: `patch ${patch.status} ${patch.json?.error?.message ?? ""}` };
    return until(async () => {
      const [now, before] = [await send("paths", { path: "/moved-here" }), await send("paths", { path: "/only-here" })];
      return { ok: now.status === 200 && before.status === 404, actual: `new path ${now.status}, old path ${before.status}` };
    });
  });

  await check("The audit log recorded the apply", "an entry for this run's apply", async () => {
    const res = await admin("GET", "/v1/audit?workspace=default&kind=config&limit=20");
    const found = (res.json?.data ?? []).some((a) => a.action === "apply");
    return { ok: found, actual: found ? "found" : `${res.status}, not found` };
  });

  if (!process.env.SMOKE_SKIP_USAGE) {
    console.log("      waiting for the nodes to report usage (up to two minutes)");
    const mine = new Set(((await admin("GET", "/v1/workspaces/default/routes?label=suite%3Dsmoke&limit=500")).json?.data ?? []).map((r) => r.id));
    await check("Usage is metered", "requests of this run counted for the smoke routes", async () => until(async () => {
      const from = new Date(Date.now() - 15 * 60_000).toISOString();
      const res = await admin("GET", `/v1/usage?workspace=default&granularity=minute&group_by=route&from=${encodeURIComponent(from)}`);
      const total = (res.json?.data ?? []).filter((r) => mine.has(r.route_id)).reduce((n, r) => n + Number(r.requests), 0);
      return { ok: total > 0, actual: res.status === 200 ? `${total} request(s) counted` : `${res.status} ${res.json?.error?.message ?? ""}` };
    }, { timeout: 120_000, every: 5000 }));
  }
}

if (authed && !process.env.SMOKE_KEEP) {
  await check("The smoke configuration is removed", "sync deletes everything labelled suite=smoke", async () => {
    const res = await cleanup();
    const left = await admin("GET", "/v1/workspaces/default/routes?label=suite%3Dsmoke");
    return { ok: res.status === 200 && left.json?.data?.length === 0, actual: res.status === 200 ? `${res.json.summary.delete} deleted, ${left.json?.data?.length ?? "?"} left` : `${res.status} ${res.json?.error?.message ?? ""}` };
  });
}

// ── Report ───────────────────────────────────────────────────────────────────

const width = (key) => Math.min(58, Math.max(key.length, ...results.map((r) => r[key].length)));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const [f, e, a] = [width("feature"), width("expected"), width("actual")];
console.log(`\n${"RESULT"}  ${"FEATURE".padEnd(f)}  ${"EXPECTED".padEnd(e)}  ACTUAL`);
console.log(`${"-".repeat(6)}  ${"-".repeat(f)}  ${"-".repeat(e)}  ${"-".repeat(a)}`);
for (const r of results) console.log(`${r.ok ? "PASS  " : "FAIL  "}  ${cut(r.feature, f)}  ${cut(r.expected, e)}  ${r.actual}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length > 0 ? `; failed: ${failed.map((r) => r.feature).join("; ")}` : ""}.`);
if (process.env.SMOKE_REPORT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.SMOKE_REPORT, JSON.stringify({ run: RUN, admin: ADMIN, gateway: GATEWAY, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
}
process.exit(failed.length > 0 ? 1 : 0);
