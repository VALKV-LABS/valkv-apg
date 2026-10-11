// Plugins and consumers, end to end (spec §9, §10): real requests through a
// real node to an upstream that reports what it received, so a test can see
// both what the client got and what the upstream was told.
//
// Runs in every config mode through the shared driver (spec ARC-1). From a
// file, keys and passwords are written in the document and hashed by the
// node; through the Admin API they are hashed by the control plane.

import { createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { MODE, NODE, NODE_TLS, adminCall, apply } from "./lib/driver.js";
import { assert, step } from "./lib/harness.js";
import { send, until } from "./lib/raw.js";

const RUN = `${Date.now()}`;
const HOST = process.env.UPSTREAM_HOST ?? "e2e";
const JWKS_PORT = 9050;
const AUTH_PORT = 9060;
const HOOK_PORT = 9061;
const fixture = (name) => readFileSync(new URL(`../../admin/test/fixtures/${name}`, import.meta.url), "utf8");
const CERT = fixture("test-cert.crt");
const CERT_KEY = fixture("test-cert.key");
const ISSUER = "https://idp.plug.test";

const KEYS = { alice: "apg_k_alice_0123456789abcdef", bob: "apg_k_bob_0123456789abcdefgh", tenant: "apg_k_tenant_0123456789abcde" };
const PASSWORD = "wonderland-pass";

// ── A token issuer the suite controls ────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "e2e-1", use: "sig", alg: "ES256" };
const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function token(claims, { alg = "ES256", kid = "e2e-1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg, kid, typ: "JWT" })}.${b64({ iss: ISSUER, exp: now + 300, ...claims })}`;
  if (alg === "none") return `${input}.`;
  return `${input}.${createSign("SHA256").update(input).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

let jwksServer;
let jwksFetches = 0;
function startJwks() {
  jwksServer = http.createServer((_req, res) => {
    jwksFetches++;
    const body = JSON.stringify({ keys: [JWK] });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve, reject) => jwksServer.once("error", reject).listen(JWKS_PORT, "0.0.0.0", resolve));
}

// ── Services the gateway asks ────────────────────────────────────────────────

const listen = (server, port) => new Promise((resolve, reject) => server.once("error", reject).listen(port, "0.0.0.0", resolve));
const reply = (res, status, headers, body) => {
  res.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
};
const authCalls = [];
const hookCalls = [];

/** Allows `Bearer ok`, and says who it is; refuses everything else in its own words. */
function startAuthService() {
  return listen(
    http.createServer((req, res) => {
      authCalls.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.headers.authorization === "Bearer ok") return reply(res, 200, { "x-auth-user": "carol" }, "");
      return reply(res, 401, { "www-authenticate": 'Bearer realm="svc"', "content-type": "text/plain" }, "nope");
    }),
    AUTH_PORT,
  );
}

/** A callout service: tags requests and responses, and blocks or replaces on request. */
function startHookService() {
  return listen(
    http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        hookCalls.push(call);
        const asked = call.request.headers;
        let answer = {};
        if (call.phase === "request") {
          answer = asked["x-block"] ? { action: "respond", status: 451, headers: { "content-type": "text/plain" }, body: "blocked" } : { set_headers: { "x-callout": call.request.path }, remove_headers: ["x-strip"] };
        } else {
          answer = asked["x-replace"] ? { action: "respond", status: 418, headers: { "content-type": "text/plain" }, body: "replaced" } : { set_headers: { "x-callout-response": String(call.response.status) } };
        }
        reply(res, 200, { "content-type": "application/json" }, JSON.stringify(answer));
      });
    }),
    HOOK_PORT,
  );
}

// ── Configuration ────────────────────────────────────────────────────────────

const jwt = (extra = {}) => ({ issuer: ISSUER, jwks: { keys: [JWK] }, algorithms: ["ES256"], ...extra });

function config({ keyAuthOn = true } = {}) {
  const route = (name, plugins, extra = {}) => ({ name: `pl-${name}`, service: "echo", hosts: [`${name}.plug.test`], plugins, ...extra });
  return {
    version: 1,
    flags: { plugin_key_auth: keyAuthOn },
    consumers: [
      {
        name: "alice",
        custom_id: "alice-1",
        groups: ["staff"],
        credentials: [
          { type: "key", name: "main", key: KEYS.alice },
          { type: "basic", name: "login", username: "alice", password: PASSWORD },
        ],
      },
      { name: "bob", groups: ["suspended"], credentials: [{ type: "key", name: "main", key: KEYS.bob }] },
      { name: "guest" },
      // Known by the name in its client certificate.
      { name: "svc", credentials: [{ type: "mtls", name: "cert", identity: "api.example.com" }] },
    ],
    ca_certificates: [{ name: "plug-ca", cert_pem: CERT }],
    services: [
      { name: "echo", shared: true, backends: [{ target: "echo:8080" }] },
      // Two services on one upstream, told apart by the Host they send.
      { name: "pl-side-a", backends: [{ target: "echo:8080" }], host_header: "side-a.internal" },
      { name: "pl-side-b", backends: [{ target: "echo:8080" }], host_header: "side-b.internal" },
    ],
    routes: [
      route("key", [{ type: "key_auth" }]),
      route("keyquery", [{ type: "key_auth", config: { in_query: true, key_names: ["apikey"] } }]),
      route("basic", [{ type: "basic_auth", config: { realm: "plug" } }]),
      route("jwt", [{ type: "jwt_auth", config: jwt({ consumer_claim: "sub", claims_to_headers: { tenant: "x-tenant" }, audiences: ["plug-api"] }) }]),
      route("jwtremote", [{ type: "jwt_auth", config: { issuer: ISSUER, jwks_url: `http://${HOST}:${JWKS_PORT}/jwks`, algorithms: ["ES256"] } }]),
      route("anon", [{ type: "key_auth", config: { anonymous: "guest" } }]),
      route("either", [
        { type: "key_auth", config: { anonymous: "guest" } },
        { type: "jwt_auth", config: jwt({ consumer_claim: "sub", anonymous: "guest" }) },
      ]),
      route("acl", [{ type: "key_auth" }, { type: "acl", config: { allow: ["staff"], deny: ["suspended"] } }]),
      route("aclonly", [{ type: "acl", config: { allow: ["staff"] } }]),
      route("ipdeny", [{ type: "ip_restriction", config: { deny: ["0.0.0.0/0", "::/0"] } }]),
      route("ipallow", [{ type: "ip_restriction", config: { allow: ["203.0.113.0/24"] } }]),
      route("ipopen", [{ type: "ip_restriction", config: { allow: ["0.0.0.0/0", "::/0"], deny: ["203.0.113.0/24"] } }]),
      route("size", [{ type: "request_size_limit", config: { max_bytes: 100 } }]),
      route("cors", [{ type: "cors", config: { origins: ["https://app.example.com"], credentials: true, expose_headers: ["X-Total"] } }, { type: "key_auth" }]),
      route("tiered", [
        { type: "key_auth" },
        { type: "rate_limit", config: { per_second: 0.001, burst: 100, scope: "header:x-run" } },
        // Narrower than the route's own limit, for one consumer only (spec PL-1).
        { type: "rate_limit", consumer: "bob", config: { per_second: 0.001, burst: 1, scope: "header:x-run" } },
      ]),
      route("redirect", [{ type: "redirect", config: { status: 301, host: "new.plug.test", path: "/v2{{ request.path }}" } }]),
      route("static", [{ type: "static_response", config: { status: 503, content_type: "text/plain", headers: { "Retry-After": "120" }, body: "maintenance on {{ request.host }}" } }]),
      route("reqtx", [
        {
          type: "request_transformer",
          config: {
            headers: { set: { "x-set": "{{ request.method }}" }, add: { "x-added": "{{ route.name }}" }, remove: ["x-remove"], rename: { "x-old": "x-new" } },
            query: { set: { page: "1" }, remove: ["drop"], add: { via: "gateway" } },
            body: { set: { "/added": "{{ request.host }}", "/n": 5 }, remove: ["/secret"] },
          },
        },
      ]),
      route("resptx", [
        { type: "response_transformer", config: { headers: { set: { "x-served-by": "apg" }, remove: ["x-powered-by"] }, body: { set: { "/gateway": "{{ route.name }}" }, remove: ["/headers"] } } },
      ]),
      route("quota", [{ type: "quota", config: { limit: 2, window: "hour", scope: "header:x-run" } }]),
      route("gzip", [{ type: "compression", config: { min_bytes: 10, algorithms: ["gzip"] } }]),
      route("gzipbig", [{ type: "compression", config: { min_bytes: 10000000 } }]),
      route("fwd", [{ type: "forward_auth", config: { url: `http://${HOST}:${AUTH_PORT}/verify`, response_headers: ["X-Auth-User"] } }]),
      route("fwdclosed", [{ type: "forward_auth", config: { url: `http://${HOST}:9069/`, timeout_ms: 500 } }]),
      route("fwdopen", [{ type: "forward_auth", config: { url: `http://${HOST}:9069/`, timeout_ms: 500, fail_open: true } }]),
      route("hook", [{ type: "http_callout", config: { url: `http://${HOST}:${HOOK_PORT}/hook`, phases: ["request", "response"], timeout_ms: 2000 } }]),
      route("mtls", [{ type: "mtls_auth", config: { ca_certificates: ["plug-ca"] } }]),
      route("cache", [{ type: "response_cache", config: { ttl_secs: 30 } }]),
      // Keys with a default most configurations never change; each is set here to something else and shown to matter (TST-1).
      route("keyqueryonly", [{ type: "key_auth", config: { in_header: false, in_query: true, key_names: ["apikey"] } }]),
      route("jwtstrict", [{ type: "jwt_auth", config: jwt({ leeway_secs: 0 }) }]),
      route("fwdtenant", [{ type: "forward_auth", config: { url: `http://${HOST}:${AUTH_PORT}/verify`, request_headers: ["Authorization", "X-Tenant"], cache_secs: 60, cache_key_headers: ["Authorization", "X-Tenant"] } }]),
      route("fwdcached", [{ type: "forward_auth", config: { url: `http://${HOST}:${AUTH_PORT}/verify`, cache_secs: 60 } }]),
      route("cachevary", [{ type: "response_cache", config: { ttl_secs: 30, vary_headers: ["Accept-Language"] } }]),
      route("cacheauth", [{ type: "key_auth" }, { type: "response_cache", config: { ttl_secs: 30, cache_authenticated: true } }]),
      { name: "pl-split", hosts: ["split.plug.test"], split: [{ service: "pl-side-a", weight: 1 }, { service: "pl-side-b", weight: 1 }], split_key: "consumer", plugins: [{ type: "key_auth" }] },
    ],
    workspaces: [
      {
        name: "plugtenant",
        domains: [{ hostname: "tenant.plug.test", tls: { mode: "none" } }],
        consumers: [{ name: "tenant-user", credentials: [{ type: "key", name: "main", key: KEYS.tenant }] }],
        routes: [{ name: "tenant-key", service: "echo", hosts: ["tenant.plug.test"] }],
        // At workspace scope: every route of this workspace asks for a key.
        plugins: [{ type: "key_auth", scope: "workspace" }],
      },
    ],
  };
}

const call = (name, opts = {}) => send(NODE, { host: `${name}.plug.test`, path: "/", ...opts });
const withKey = (key) => ({ headers: { "x-api-key": key } });

function assertRefused(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.headers["x-apg-error"], code);
  assert.equal(res.json.error.code, code);
}

// ── Steps ────────────────────────────────────────────────────────────────────

step("the plugin configuration is accepted and served", async () => {
  await startJwks();
  await startAuthService();
  await startHookService();
  await apply(config());
  assert.equal((await call("key", withKey(KEYS.alice))).status, 200);
});

step("key_auth: no key or a wrong key is 401; a valid key names the consumer and is hidden from the upstream", async () => {
  assertRefused(await call("key"), 401, "UNAUTHENTICATED");
  assertRefused(await call("key", withKey("apg_k_not_a_real_key_000000")), 401, "UNAUTHENTICATED");
  const res = await call("key", withKey(KEYS.alice));
  assert.equal(res.status, 200);
  const h = res.json.headers;
  assert.equal(h["x-apg-consumer-name"], "alice");
  assert.equal(h["x-apg-consumer-custom-id"], "alice-1");
  assert.ok(h["x-apg-consumer-id"]);
  assert.equal(h["x-api-key"], undefined, "the key is not forwarded");
  // A client cannot claim to be someone by sending the identity headers itself.
  const forged = await call("key", { headers: { "x-api-key": KEYS.bob, "x-apg-consumer-name": "alice" } });
  assert.equal(forged.json.headers["x-apg-consumer-name"], "bob");
});

step("key_auth can read the key from the query string and removes it from the forwarded URL", async () => {
  const res = await call("keyquery", { path: `/items?page=2&apikey=${KEYS.alice}` });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.query.page, "2");
  assert.equal(res.json.query.apikey, undefined);
  // The header form is still accepted under the configured name; the default name is not.
  assert.equal((await call("keyquery", { headers: { apikey: KEYS.alice } })).status, 200);
  assertRefused(await call("keyquery", withKey(KEYS.alice)), 401, "UNAUTHENTICATED");
});

step("basic_auth: a challenge naming the realm, the password checked, the header not forwarded", async () => {
  const basic = (user, pass) => ({ headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` } });
  const none = await call("basic");
  assertRefused(none, 401, "UNAUTHENTICATED");
  assert.match(none.headers["www-authenticate"], /^Basic realm="plug"/);
  assertRefused(await call("basic", basic("alice", "wrong-password")), 401, "UNAUTHENTICATED");
  assertRefused(await call("basic", basic("nobody", PASSWORD)), 401, "UNAUTHENTICATED");
  for (let i = 0; i < 3; i++) {
    const ok = await call("basic", basic("alice", PASSWORD));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.headers["x-apg-consumer-name"], "alice");
    assert.equal(ok.json.headers.authorization, undefined);
  }
});

step("jwt_auth verifies signature, expiry, issuer and audience, maps the consumer and passes claims on", async () => {
  const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  const good = { sub: "alice-1", aud: "plug-api", tenant: "acme" };
  const ok = await call("jwt", bearer(token(good)));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.headers["x-apg-consumer-name"], "alice");
  assert.equal(ok.json.headers["x-tenant"], "acme");

  const now = Math.floor(Date.now() / 1000);
  const refused = {
    "no token": {},
    "expired": bearer(token({ ...good, exp: now - 3600 })),
    "another issuer": bearer(token({ ...good, iss: "https://evil.test" })),
    "another audience": bearer(token({ ...good, aud: "elsewhere" })),
    "a consumer nobody knows": bearer(token({ ...good, sub: "stranger" })),
    "the none algorithm": bearer(token(good, { alg: "none" })),
    "a tampered payload": bearer(token(good).replace(/\.[^.]+\./, `.${b64({ iss: ISSUER, sub: "alice-1", aud: "plug-api", admin: true, exp: now + 300 })}.`)),
    "garbage": bearer("not.a.token"),
  };
  for (const [why, opts] of Object.entries(refused)) {
    const res = await call("jwt", opts);
    assertRefused(res, 401, "UNAUTHENTICATED");
    assert.ok(res.headers["www-authenticate"]?.startsWith("Bearer"), why);
  }
});

step("jwt_auth fetches signing keys from jwks_url and keeps working from its copy when the issuer is down", async () => {
  const bearer = { headers: { authorization: `Bearer ${token({ sub: "anyone" })}` } };
  const first = await call("jwtremote", bearer);
  assert.equal(first.status, 200, first.text);
  assert.ok(jwksFetches >= 1);
  // No consumer_claim: the caller is authenticated, but is no consumer.
  assert.equal(first.json.headers["x-apg-consumer-name"], undefined);
  await new Promise((resolve) => jwksServer.close(resolve));
  for (let i = 0; i < 3; i++) assert.equal((await call("jwtremote", bearer)).status, 200);
  assertRefused(await call("jwtremote", { headers: { authorization: "Bearer a.b.c" } }), 401, "UNAUTHENTICATED");
});

step("anonymous: with no credential the request runs as the named consumer; a bad credential is still refused", async () => {
  const open = await call("anon");
  assert.equal(open.status, 200, open.text);
  assert.equal(open.json.headers["x-apg-consumer-name"], "guest");
  assert.equal((await call("anon", withKey(KEYS.alice))).json.headers["x-apg-consumer-name"], "alice");
  assertRefused(await call("anon", withKey("apg_k_not_a_real_key_000000")), 401, "UNAUTHENTICATED");
});

step("two schemes with anonymous give 'API key or token' (PL-10)", async () => {
  const name = async (opts) => {
    const res = await call("either", opts);
    assert.equal(res.status, 200, res.text);
    return res.json.headers["x-apg-consumer-name"];
  };
  assert.equal(await name(withKey(KEYS.alice)), "alice");
  assert.equal(await name({ headers: { authorization: `Bearer ${token({ sub: "alice-1" })}` } }), "alice");
  assert.equal(await name({}), "guest");
  // Presenting one valid and one invalid credential is not a way in.
  assertRefused(await call("either", { headers: { "x-api-key": KEYS.alice, authorization: "Bearer a.b.c" } }), 401, "UNAUTHENTICATED");
});

step("acl: group membership decides, deny wins, and no consumer means 401", async () => {
  assert.equal((await call("acl", withKey(KEYS.alice))).status, 200);
  assertRefused(await call("acl", withKey(KEYS.bob)), 403, "FORBIDDEN");
  assertRefused(await call("acl"), 401, "UNAUTHENTICATED");
  assertRefused(await call("aclonly"), 401, "UNAUTHENTICATED");
});

step("ip_restriction: deny wins, and a non-empty allow list excludes everyone else", async () => {
  assertRefused(await call("ipdeny"), 403, "IP_FORBIDDEN");
  assertRefused(await call("ipallow"), 403, "IP_FORBIDDEN");
  assert.equal((await call("ipopen")).status, 200);
});

step("request_size_limit: refused at once when declared too large, and mid-stream when not declared", async () => {
  const small = "x".repeat(50);
  const large = "x".repeat(5000);
  assert.equal((await call("size", { method: "POST", body: small, headers: { "content-length": "50" } })).status, 200);
  assertRefused(await call("size", { method: "POST", body: large, headers: { "content-length": "5000" } }), 413, "PAYLOAD_TOO_LARGE");
  assertRefused(await call("size", { method: "POST", body: large, headers: { "transfer-encoding": "chunked" } }), 413, "PAYLOAD_TOO_LARGE");
  assert.equal((await call("size", { method: "POST", body: small, headers: { "transfer-encoding": "chunked" } })).status, 200);
});

step("cors: preflight is answered by the gateway, and a refusal still carries the CORS headers (PL-8)", async () => {
  const origin = "https://app.example.com";
  const preflight = await call("cors", { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "x-api-key" } });
  assert.equal(preflight.status, 204, preflight.text);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.ok(preflight.headers["access-control-allow-methods"].includes("PUT"));
  assert.equal(preflight.headers["access-control-allow-headers"], "x-api-key");
  assert.equal(preflight.headers["access-control-max-age"], "86400");

  // Not authenticated: the browser must still be able to read the 401.
  const refused = await call("cors", { headers: { origin } });
  assertRefused(refused, 401, "UNAUTHENTICATED");
  assert.equal(refused.headers["access-control-allow-origin"], origin);

  const ok = await call("cors", { headers: { origin, "x-api-key": KEYS.alice } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], origin);
  assert.equal(ok.headers["access-control-expose-headers"], "X-Total");
  assert.match(String(ok.headers.vary), /Origin/);

  const other = await call("cors", { headers: { origin: "https://evil.example", "x-api-key": KEYS.alice } });
  assert.equal(other.status, 200);
  assert.equal(other.headers["access-control-allow-origin"], undefined);
  const otherPreflight = await call("cors", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "PUT" } });
  assert.equal(otherPreflight.headers["access-control-allow-origin"], undefined);
  assert.equal(otherPreflight.headers["access-control-allow-methods"], undefined);
});

step("a plugin instance for one consumer overrides the route's own (PL-1)", async () => {
  const as = (key) => call("tiered", { headers: { "x-api-key": key, "x-run": RUN } });
  // Bob has a burst of one; everyone else has a hundred.
  assert.equal((await as(KEYS.bob)).status, 200);
  assertRefused(await as(KEYS.bob), 429, "RATE_LIMITED");
  for (let i = 0; i < 5; i++) assert.equal((await as(KEYS.alice)).status, 200);
});

step("a split keyed on the consumer keeps each consumer on one side (UP-15)", async () => {
  const side = async (key) => (await send(NODE, { host: "split.plug.test", path: "/", headers: { "x-api-key": key } })).json.headers.host;
  for (const key of [KEYS.alice, KEYS.bob]) {
    const first = await side(key);
    assert.match(first, /^side-[ab]\.internal$/);
    for (let i = 0; i < 6; i++) assert.equal(await side(key), first);
  }
  assertRefused(await send(NODE, { host: "split.plug.test", path: "/" }), 401, "UNAUTHENTICATED");
});

step("credentials work in their own workspace and on operator routes, never in another tenant's (CON-1)", async () => {
  const tenant = (key) => send(NODE, { host: "tenant.plug.test", path: "/", headers: key ? { "x-api-key": key } : {} });
  // The workspace-scoped plugin guards the tenant's route.
  assertRefused(await tenant(), 401, "UNAUTHENTICATED");
  const own = await tenant(KEYS.tenant);
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.headers["x-apg-consumer-name"], "tenant-user");
  // A consumer of the operator's workspace is nobody here.
  assertRefused(await tenant(KEYS.alice), 401, "UNAUTHENTICATED");
  // On an operator route, a tenant's consumer is recognised.
  assert.equal((await call("key", withKey(KEYS.tenant))).json.headers["x-apg-consumer-name"], "tenant-user");
});

step("redirect and static_response answer without an upstream, with templates filled in", async () => {
  const moved = await call("redirect", { path: "/old/page?x=1" });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.location, "http://new.plug.test/v2/old/page?x=1");
  const down = await call("static");
  assert.equal(down.status, 503);
  assert.equal(down.text, "maintenance on static.plug.test");
  assert.equal(down.headers["content-type"], "text/plain");
  assert.equal(down.headers["retry-after"], "120");
});

step("request_transformer rewrites headers, query and a JSON body before the upstream sees them", async () => {
  const res = await call("reqtx", {
    method: "POST",
    path: "/submit?page=9&drop=me&keep=yes",
    body: JSON.stringify({ secret: "hunter2", keep: true }),
    headers: { "content-type": "application/json", "x-remove": "gone", "x-old": "moved" },
  });
  assert.equal(res.status, 200, res.text);
  const h = res.json.headers;
  assert.equal(h["x-set"], "POST");
  assert.equal(h["x-added"], "pl-reqtx");
  assert.equal(h["x-remove"], undefined);
  assert.equal(h["x-new"], "moved");
  assert.equal(h["x-old"], undefined);
  assert.deepEqual(res.json.query, { keep: "yes", page: "1", via: "gateway" });
  const body = typeof res.json.body === "string" ? JSON.parse(res.json.body) : res.json.body;
  assert.deepEqual(body, { keep: true, added: "reqtx.plug.test", n: 5 });
  // A body that is not JSON passes through untouched.
  const text = await call("reqtx", { method: "POST", body: "plain words", headers: { "content-type": "text/plain" } });
  assert.equal(text.json.body, "plain words");
});

step("response_transformer rewrites the upstream's headers and JSON body", async () => {
  const res = await call("resptx");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers["x-served-by"], "apg");
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.equal(res.json.gateway, "pl-resptx");
  assert.equal(res.json.headers, undefined);
  assert.equal(res.json.method, "GET", "the rest of the body is intact");
});

step("quota: the allowance counts down, then 429 until the window ends", async () => {
  const run = { headers: { "x-run": `quota-${RUN}` } };
  const first = await call("quota", run);
  assert.equal(first.status, 200);
  assert.equal(first.headers["x-quota-limit"], "2");
  assert.equal(first.headers["x-quota-remaining"], "1");
  assert.equal((await call("quota", run)).headers["x-quota-remaining"], "0");
  const over = await call("quota", run);
  assertRefused(over, 429, "QUOTA_EXCEEDED");
  assert.ok(Number(over.headers["retry-after"]) >= 1 && Number(over.headers["retry-after"]) <= 3600);
  assert.ok(Number(over.headers["x-quota-reset"]) > Date.now() / 1000);
});

step("compression: negotiated with the client, and skipped for small responses", async () => {
  const gz = { headers: { "accept-encoding": "gzip" } };
  assert.equal((await call("gzip", gz)).headers["content-encoding"], "gzip");
  assert.equal((await call("gzip")).headers["content-encoding"], undefined, "the client did not ask for it");
  assert.equal((await call("gzip", { headers: { "accept-encoding": "br" } })).headers["content-encoding"], undefined, "only gzip is switched on");
  assert.equal((await call("gzipbig", gz)).headers["content-encoding"], undefined, "below min_bytes");
});

step("forward_auth: another service decides; its refusal is the client's answer", async () => {
  const ok = await call("fwd", { path: "/thing?x=1", headers: { authorization: "Bearer ok", cookie: "a=b", "x-private": "not shared" } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.headers["x-auth-user"], "carol", "a header of the service's answer is passed on");
  const asked = authCalls.at(-1);
  assert.equal(asked.url, "/verify");
  assert.equal(asked.headers["x-forwarded-uri"], "/thing?x=1");
  assert.equal(asked.headers["x-forwarded-method"], "GET");
  assert.equal(asked.headers["x-forwarded-host"], "fwd.plug.test");
  assert.equal(asked.headers.cookie, "a=b");
  assert.equal(asked.headers["x-private"], undefined, "only the listed headers are sent");

  const refused = await call("fwd", { headers: { authorization: "Bearer wrong" } });
  assert.equal(refused.status, 401);
  assert.equal(refused.text, "nope");
  assert.equal(refused.headers["www-authenticate"], 'Bearer realm="svc"');

  // The service cannot be reached: closed unless the operator chose otherwise.
  assertRefused(await call("fwdclosed"), 503, "AUTH_UNAVAILABLE");
  assert.equal((await call("fwdopen")).status, 200);
});

step("http_callout: a service changes, blocks or replaces what passes through", async () => {
  const res = await call("hook", { path: "/thing", headers: { "x-strip": "remove me", authorization: "Bearer secret-token" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.headers["x-callout"], "/thing");
  assert.equal(res.json.headers["x-strip"], undefined);
  assert.equal(res.headers["x-callout-response"], "200");
  const told = hookCalls.find((c) => c.phase === "request" && c.request.path === "/thing");
  assert.equal(told.request.host, "hook.plug.test");
  assert.equal(told.route.name, "pl-hook");
  assert.equal(told.request.headers.authorization, undefined, "credentials are not shown to the service");
  assert.ok(hookCalls.some((c) => c.phase === "response" && c.response.status === 200));

  const blocked = await call("hook", { headers: { "x-block": "1" } });
  assert.equal(blocked.status, 451);
  assert.equal(blocked.text, "blocked");

  const replaced = await call("hook", { headers: { "x-replace": "1" } });
  assert.equal(replaced.status, 418);
  assert.equal(replaced.text, "replaced");
});

step("mtls_auth: a client certificate from a trusted CA names its consumer (TLS-3)", async () => {
  const request = (options) =>
    new Promise((resolve, reject) => {
      const url = new URL(NODE_TLS);
      const req = https.request({ hostname: url.hostname, port: url.port, path: "/", servername: "mtls.plug.test", setHost: false, headers: { host: "mtls.plug.test" }, rejectUnauthorized: false, agent: false, ...options }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(text) });
        });
      });
      req.on("error", reject);
      req.end();
    });
  const ok = await request({ cert: CERT, key: CERT_KEY });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.headers["x-apg-consumer-name"], "svc");
  const none = await request({});
  assert.equal(none.status, 401);
  assert.equal(none.json.error.code, "UNAUTHENTICATED");
  // Over plain HTTP there is no certificate either.
  assertRefused(await call("mtls"), 401, "UNAUTHENTICATED");
});

step("response_cache: a stored response is served again; credentials and other queries are kept apart", async () => {
  const path = `/cached-${RUN}?a=1&b=2`;
  const first = await call("cache", { path });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers["x-apg-cache"], "MISS");
  // The upstream echoes the request id it was sent, so a served copy shows the first request's.
  const again = await call("cache", { path: `/cached-${RUN}?b=2&a=1` });
  assert.equal(again.headers["x-apg-cache"], "HIT");
  assert.equal(again.json.headers["x-request-id"], first.json.headers["x-request-id"]);
  assert.notEqual(again.headers["x-request-id"], first.headers["x-request-id"], "the response still carries its own request id");

  assert.equal((await call("cache", { path: `/cached-${RUN}?a=2` })).headers["x-apg-cache"], "MISS");
  assert.equal((await call("cache", { path, headers: { authorization: "Bearer someone" } })).headers["x-apg-cache"], "BYPASS");
  assert.equal((await call("cache", { path, method: "POST" })).headers["x-apg-cache"], undefined, "only GET and HEAD are cached");
  const head = await call("cache", { path, method: "HEAD" });
  assert.equal(head.headers["x-apg-cache"], "HIT");
  assert.equal(head.text, "");

  if (MODE !== "file") {
    // Purging the route reaches every node through the changelog.
    await adminCall("POST", "/v1/workspaces/default/routes/pl-cache/cache/purge");
    await until(async () => (await call("cache", { path })).headers["x-apg-cache"] === "MISS", { what: "the purge to reach the node" });
    assert.equal((await call("cache", { path })).headers["x-apg-cache"], "HIT", "and the route caches again afterwards");
  }
});

step("defaults that are rarely changed do change behaviour when they are (TST-1)", async () => {
  // key_auth.in_header: with it off, a key in a header is not looked at.
  assertRefused(await call("keyqueryonly", { headers: { apikey: KEYS.alice } }), 401, "UNAUTHENTICATED");
  assert.equal((await call("keyqueryonly", { path: `/?apikey=${KEYS.alice}` })).status, 200);

  // jwt_auth.leeway_secs: a token that expired five seconds ago passes the default tolerance of a minute, and not a tolerance of zero.
  const justExpired = { headers: { authorization: `Bearer ${token({ sub: "alice-1", aud: "plug-api", exp: Math.floor(Date.now() / 1000) - 5 })}` } };
  assert.equal((await call("jwt", justExpired)).status, 200);
  assertRefused(await call("jwtstrict", justExpired), 401, "UNAUTHENTICATED");
  assert.equal((await call("jwtstrict", { headers: { authorization: `Bearer ${token({ sub: "alice-1" })}` } })).status, 200);

  // forward_auth.request_headers: only the listed headers reach the service.
  const before = authCalls.length;
  const ask = (name, tenant) => call(name, { headers: { authorization: "Bearer ok", cookie: "a=b", "x-tenant": tenant } });
  const firstAsk = await ask("fwdtenant", "one");
  assert.equal(firstAsk.status, 200, `fwdtenant: ${firstAsk.text}`);
  assert.equal(authCalls.at(-1).headers["x-tenant"], "one");
  assert.equal(authCalls.at(-1).headers.cookie, undefined, "Cookie is no longer in the list");
  // forward_auth.cache_key_headers: an answer is reused only for the same values of these headers.
  assert.equal((await ask("fwdtenant", "one")).status, 200);
  assert.equal(authCalls.length, before + 1, "the same tenant and token: answered from the cache");
  assert.equal((await ask("fwdtenant", "two")).status, 200);
  assert.equal(authCalls.length, before + 2, "another tenant: the service is asked again");
  // With the default key (Authorization alone) the tenant header makes no difference.
  await ask("fwdcached", "one");
  await ask("fwdcached", "two");
  assert.equal(authCalls.length, before + 3);

  // response_cache.vary_headers: each value of the header gets its own stored response.
  const lang = (l) => call("cachevary", { path: `/vary-${RUN}`, headers: { "accept-language": l } });
  assert.equal((await lang("en")).headers["x-apg-cache"], "MISS");
  assert.equal((await lang("fr")).headers["x-apg-cache"], "MISS");
  const again = await lang("fr");
  assert.equal(again.headers["x-apg-cache"], "HIT");
  assert.equal(again.json.headers["accept-language"], "fr");
  // Without it (the route above), a different language is served the stored copy.
  await call("cache", { path: `/novary-${RUN}`, headers: { "accept-language": "en" } });
  assert.equal((await call("cache", { path: `/novary-${RUN}`, headers: { "accept-language": "fr" } })).headers["x-apg-cache"], "HIT");

  // response_cache.cache_authenticated: authenticated callers are cached too, each consumer apart.
  const mine = (key) => call("cacheauth", { path: `/mine-${RUN}`, headers: { "x-api-key": key } });
  assert.equal((await mine(KEYS.alice)).headers["x-apg-cache"], "MISS");
  assert.equal((await mine(KEYS.alice)).headers["x-apg-cache"], "HIT");
  const bobs = await mine(KEYS.bob);
  assert.equal(bobs.headers["x-apg-cache"], "MISS", "bob is not served alice's copy");
  assert.equal(bobs.json.headers["x-apg-consumer-name"], "bob");

});

step("the kill switch stops a plugin type everywhere, and brings it back (PL-3)", async () => {
  await apply(config({ keyAuthOn: false }));
  assert.equal((await call("key")).status, 200, "with key_auth switched off the route is open");
  await apply(config());
  assertRefused(await call("key"), 401, "UNAUTHENTICATED");
});

step(`plugin routes are withdrawn at the end [mode=${MODE}]`, async () => {
  // Leave the stack as other suites expect it: no consumers' routes behind.
  const doc = config();
  doc.routes = [];
  doc.workspaces[0].routes = [];
  doc.workspaces[0].plugins = [];
  await apply(doc);
  assert.equal((await call("key", withKey(KEYS.alice))).status, 404);
});
