// Upstreams, end to end (spec §7): a real node in front of upstream servers
// this suite starts itself, so it can make them slow, failing, or silent.
//
// The servers listen in the test runner's container. The node reaches them by
// the runner's name on the container network, which also exercises backend
// name resolution (UP-5): every target here is a host name, not an address.
//
// Runs in every config mode through the shared driver (spec ARC-1).

import { readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { MGMT, MODE, NODE, apply, metric } from "./lib/driver.js";
import { assert, step } from "./lib/harness.js";
import { send, until } from "./lib/raw.js";

const HOST = process.env.UPSTREAM_HOST ?? "e2e";
const PORTS = { a: 9001, b: 9002, c: 9003, h2: 9010, tls: 9020, mtls: 9021, dead: 9099 };
const target = (name) => `${HOST}:${PORTS[name]}`;
const fixture = (name) => readFileSync(new URL(`../../admin/test/fixtures/${name}`, import.meta.url), "utf8");
const CERT = fixture("test-cert.crt");
const KEY = fixture("test-cert.key");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Upstream servers ─────────────────────────────────────────────────────────

/** What each server answers on /healthz and /flaky. Steps change these. */
const answers = { health: {}, flaky: {} };
/** Every request any server received. */
const hits = [];

function handler(name) {
  return (req, res) => {
    const url = new URL(req.url, "http://upstream");
    hits.push({ server: name, path: url.pathname, method: req.method, agent: req.headers["user-agent"] });
    const reply = (status) => {
      const body = JSON.stringify({
        server: name,
        path: url.pathname,
        http_version: req.httpVersion,
        sni: req.socket.servername ?? null,
        client_certificate: req.socket.getPeerCertificate?.()?.subject?.CN ?? null,
      });
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    if (url.pathname === "/healthz") return reply(answers.health[name] ?? 200);
    if (url.pathname === "/flaky") return reply(answers.flaky[name] ?? 200);
    // Accept the request and never answer it.
    if (url.pathname === "/hang" || url.pathname === `/hang-${name}`) return undefined;
    if (url.pathname === "/slow") return setTimeout(() => reply(200), Number(url.searchParams.get("ms") ?? 500));
    return reply(200);
  };
}

const listen = (server, port) => new Promise((resolve, reject) => server.once("error", reject).listen(port, "0.0.0.0", resolve));

async function startUpstreams() {
  for (const name of ["a", "b", "c"]) await listen(http.createServer(handler(name)), PORTS[name]);
  // HTTP/2 without TLS, with prior knowledge.
  await listen(http2.createServer(handler("h2")), PORTS.h2);
  await listen(https.createServer({ cert: CERT, key: KEY }, handler("tls")), PORTS.tls);
  // Refuses any client that does not present the test certificate.
  await listen(https.createServer({ cert: CERT, key: KEY, requestCert: true, rejectUnauthorized: true, ca: [CERT] }, handler("mtls")), PORTS.mtls);
}

// ── Configuration ────────────────────────────────────────────────────────────

const NO_BREAKER = { health_check: { passive: { enabled: false } } };

function config() {
  const svc = (name, backends, extra = {}) => ({ name: `up-${name}`, backends: backends.map((b) => (typeof b === "string" ? { target: target(b) } : b)), ...extra });
  const trusted = { sni: "api.example.com", ca_certificates: ["test-ca"] };
  const services = [
    svc("rr", [{ target: target("a"), weight: 2 }, "b"]),
    svc("drain", ["a", { target: target("b"), status: "draining" }, { target: target("c"), status: "down" }]),
    svc("hash", ["a", "b", "c"], { load_balancing: { strategy: "hash", hash_key: "header:x-user" } }),
    svc("lc", ["a", "b"], { load_balancing: { strategy: "least_connections" } }),
    svc("retry", ["dead", "a"], NO_BREAKER),
    svc("noretry", ["dead", "a"], { retries: { attempts: 0 }, ...NO_BREAKER }),
    svc("timeout", ["a"], { timeouts: { read_ms: 300 }, ...NO_BREAKER }),
    svc("timeout-retry", ["a", "b"], { timeouts: { read_ms: 300 }, retries: { attempts: 1, on: ["timeout"] }, ...NO_BREAKER }),
    svc("deadline", ["a"], NO_BREAKER),
    svc("circuit", ["a", "b"], { retries: { attempts: 0 }, health_check: { passive: { consecutive_failures: 2, open_ms: 2000, statuses: [503] } } }),
    svc("health", ["a", "b"], { health_check: { active: { path: "/healthz", interval_ms: 500, timeout_ms: 300, healthy_threshold: 2, unhealthy_threshold: 2 } } }),
    svc("h2c", ["h2"], { http_version: "2", health_check: { active: { interval_ms: 500 } } }),
    svc("tls", ["tls"], { scheme: "https", tls: trusted }),
    svc("tls-untrusted", ["tls"], { scheme: "https", tls: { sni: "api.example.com" } }),
    svc("tls-noverify", ["tls"], { scheme: "https", tls: { verify: false } }),
    svc("tls-wrongname", ["tls"], { scheme: "https", tls: { ca_certificates: ["test-ca"] } }),
    svc("side-a", ["a"]),
    svc("side-b", ["b"]),
    svc("unresolvable", [{ target: "no-such-host.invalid:80" }], { retries: { attempts: 0 } }),
    svc("unresolvable-retry", [{ target: "no-such-host.invalid:80" }, "a"], NO_BREAKER),
  ];
  // A client certificate needs its key on the node. From a file the node reads
  // it; from a control plane keys are delivered in a later build phase, and
  // until then the control plane refuses the setting.
  if (MODE === "file") {
    services.push(svc("mtls", ["mtls"], { scheme: "https", tls: { ...trusted, client_certificate: "client" } }));
    services.push(svc("mtls-missing", ["mtls"], { scheme: "https", tls: trusted }));
  }
  const routes = services
    .filter((s) => !s.name.startsWith("up-side-"))
    .map((s) => ({ name: s.name, service: s.name, hosts: [`${s.name}.up.test`], ...(s.name === "up-deadline" ? { timeout_ms: 400 } : {}) }));
  routes.push({ name: "up-split", hosts: ["up-split.up.test"], split_key: "header:x-user", split: [{ service: "up-side-a", weight: 1 }, { service: "up-side-b", weight: 1 }] });
  return {
    version: 1,
    ca_certificates: [{ name: "test-ca", cert_pem: CERT }],
    ...(MODE === "file" ? { certificates: [{ name: "client", cert_pem: CERT, key_pem: KEY }] } : {}),
    services,
    routes,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const call = (name, path = "/", opts = {}) => send(NODE, { host: `up-${name}.up.test`, path, ...opts });

/** Sends `n` requests one after another and counts answers by server name, or by status when not 200. */
async function tally(name, n, path = "/", opts = () => ({})) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const res = await call(name, path, opts(i));
    const key = res.status === 200 ? res.json.server : String(res.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function timed(fn) {
  const started = Date.now();
  const res = await fn();
  return { res, ms: Date.now() - started };
}

function assertGatewayError(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.headers["x-apg-error"], code);
  assert.equal(res.json.error.code, code);
}

// ── Steps ────────────────────────────────────────────────────────────────────

step("the upstream configuration is accepted and served", async () => {
  await startUpstreams();
  await apply(config());
  const res = await call("rr");
  assert.equal(res.status, 200, res.text);
});

step("round robin follows the weights exactly (UP-3)", async () => {
  assert.deepEqual(await tally("rr", 30), { a: 20, b: 10 });
});

step("a draining or down backend gets no new requests (UP-1, UP-11)", async () => {
  assert.deepEqual(await tally("drain", 9), { a: 9 });
});

step("hash: one key always reaches the same backend, and keys spread over the backends (UP-4)", async () => {
  const mine = await tally("hash", 10, "/", () => ({ headers: { "x-user": "user-42" } }));
  assert.equal(Object.keys(mine).length, 1, JSON.stringify(mine));
  const everyone = await tally("hash", 40, "/", (i) => ({ headers: { "x-user": `user-${i}` } }));
  assert.equal(Object.keys(everyone).length, 3, JSON.stringify(everyone));
  // A request without the key still gets served, in rotation.
  assert.equal(Object.keys(await tally("hash", 6)).length, 3);
});

step("least_connections avoids the backend that is busy (UP-3)", async () => {
  const held = call("lc", "/slow?ms=2500");
  await until(() => hits.some((h) => h.path === "/slow"), { what: "the slow request to reach a backend" });
  const busy = hits.findLast((h) => h.path === "/slow").server;
  const idle = busy === "a" ? "b" : "a";
  assert.deepEqual(await tally("lc", 6), { [idle]: 6 });
  assert.equal((await held).status, 200);
});

step("a refused connection is retried on another backend, and counted (UP-9, UP-10)", async () => {
  const before = (await metric(MGMT, "apg_upstream_retries_total", { service: "up-retry" })) ?? 0;
  assert.deepEqual(await tally("retry", 10), { a: 10 });
  const after = await metric(MGMT, "apg_upstream_retries_total", { service: "up-retry" });
  assert.ok(after >= before + 4, `retries went from ${before} to ${after}`);
});

step("with retries off the failure reaches the client as 502 UPSTREAM_ERROR", async () => {
  const counts = await tally("noretry", 4);
  assert.deepEqual(counts, { a: 2, 502: 2 });
  const failed = await until(async () => {
    const res = await call("noretry");
    return res.status === 502 ? res : null;
  }, { what: "a request to land on the dead backend" });
  assertGatewayError(failed, 502, "UPSTREAM_ERROR");
});

step("an upstream that does not answer within read_ms is a 504 UPSTREAM_TIMEOUT (UP-8)", async () => {
  const { res, ms } = await timed(() => call("timeout", "/hang"));
  assertGatewayError(res, 504, "UPSTREAM_TIMEOUT");
  assert.ok(ms >= 250 && ms < 2500, `took ${ms} ms`);
});

step("a timeout is retried elsewhere for an idempotent request only (UP-10)", async () => {
  // Backend a never answers this path; backend b does.
  assert.deepEqual(await tally("timeout-retry", 4, "/hang-a"), { b: 4 });
  // A POST may have been acted on, so it is not sent twice: the one that met backend a fails.
  const posts = await tally("timeout-retry", 2, "/hang-a", () => ({ method: "POST", body: "x=1", headers: { "content-length": "3" } }));
  assert.deepEqual(posts, { b: 1, 504: 1 });
});

step("the route's timeout_ms bounds the request whatever the service allows (UP-8)", async () => {
  const { res, ms } = await timed(() => call("deadline", "/hang"));
  assertGatewayError(res, 504, "UPSTREAM_TIMEOUT");
  assert.ok(ms >= 350 && ms < 2500, `took ${ms} ms`);
  assert.equal((await call("deadline")).status, 200, "a request that answers in time is unaffected");
});

step("the circuit opens after consecutive failures, then closes when a probe request succeeds (§7.3)", async () => {
  const labels = { service: "up-circuit", backend: target("a") };
  answers.flaky.a = 503;
  // The upstream's own 503 is passed through untouched, and counted against it.
  const first = await tally("circuit", 4, "/flaky");
  assert.deepEqual(first, { b: 2, 503: 2 });
  assert.deepEqual(await tally("circuit", 6, "/flaky"), { b: 6 }, "the failing backend is skipped");
  assert.equal(await metric(MGMT, "apg_backend_circuit_open", labels), 1);

  answers.flaky.a = 200;
  await sleep(2300);
  const after = await tally("circuit", 6, "/flaky");
  assert.ok(after.a >= 2, `traffic returns to the recovered backend: ${JSON.stringify(after)}`);
  assert.equal(await metric(MGMT, "apg_backend_circuit_open", labels), 0);
});

step("a backend failing its health check is taken out and put back (§7.2)", async () => {
  const labels = { service: "up-health", backend: target("b") };
  await until(() => hits.some((h) => h.path === "/healthz" && h.server === "b"), { what: "the first probe" });
  assert.equal(hits.find((h) => h.path === "/healthz").agent, "valkv-apg-health-check");
  assert.equal(await metric(MGMT, "apg_backend_healthy", labels), 1, "a backend starts healthy");

  answers.health.b = 503;
  await until(async () => (await metric(MGMT, "apg_backend_healthy", labels)) === 0, { what: "the backend to be marked unhealthy" });
  assert.deepEqual(await tally("health", 10), { a: 10 });

  answers.health.b = 200;
  await until(async () => (await metric(MGMT, "apg_backend_healthy", labels)) === 1, { what: "the backend to be marked healthy again" });
  assert.deepEqual(await tally("health", 10), { a: 5, b: 5 });
});

step("http_version 2 speaks HTTP/2 to the upstream, health checks included", async () => {
  const res = await call("h2c");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.http_version, "2.0");
  const probes = () => hits.filter((h) => h.server === "h2" && h.path === "/healthz").length;
  const seen = probes();
  await until(() => probes() >= seen + 3, { what: "health probes over HTTP/2" });
  assert.equal(await metric(MGMT, "apg_backend_healthy", { service: "up-h2c" }), 1);
});

step("upstream TLS: SNI is sent and the certificate is verified against the service's CA (UP-13)", async () => {
  const ok = await call("tls");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.sni, "api.example.com");
  // Not signed by a system root: refused unless the service trusts it or switches verification off.
  assertGatewayError(await call("tls-untrusted"), 502, "UPSTREAM_ERROR");
  assert.equal((await call("tls-noverify")).status, 200);
  // Trusted issuer, wrong name: SNI defaults to the backend's host, which the certificate does not cover.
  assertGatewayError(await call("tls-wrongname"), 502, "UPSTREAM_ERROR");
});

if (MODE === "file") {
  step("upstream mutual TLS: the node presents the service's client certificate (UP-14)", async () => {
    const ok = await call("mtls");
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.client_certificate, "the upstream saw a client certificate");
    assertGatewayError(await call("mtls-missing"), 502, "UPSTREAM_ERROR");
  });
}

step("a split with split_key keeps one caller on one side (UP-15)", async () => {
  const mine = await tally("split", 10, "/", () => ({ headers: { "x-user": "user-7" } }));
  assert.equal(Object.keys(mine).length, 1, JSON.stringify(mine));
  const everyone = await tally("split", 30, "/", (i) => ({ headers: { "x-user": `user-${i}` } }));
  assert.deepEqual(Object.keys(everyone).sort(), ["a", "b"], JSON.stringify(everyone));
  // Without the key the split is by rotation: exactly half each.
  assert.deepEqual(await tally("split", 10), { a: 5, b: 5 });
});

step("a backend name that does not resolve is a 502, and a retry gets past it (UP-5)", async () => {
  const { res, ms } = await timed(() => call("unresolvable"));
  assertGatewayError(res, 502, "UPSTREAM_ERROR");
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.deepEqual(await tally("unresolvable-retry", 6), { a: 6 });
});
