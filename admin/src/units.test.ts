import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { type Actor, CallerRateLimiter, canRead, canWrite, isAdmin, requireAdmin, requireNode, requireRead, requireWrite } from "./auth.js";
import { SecretBox, generateToken, parseSecretKey, safeEqual, sha256, uuidv7 } from "./crypto.js";
import { egressViolation, isNonPublic, parseCidrList } from "./egress.js";
import { slotNameFor } from "./jobs.js";
import { hostCovered } from "./kinds.js";
import { buildOpenApi } from "./openapi.js";
import { PLUGIN_TYPES } from "./plugin-types.js";
import { ENDPOINTS, registerApi } from "./routes/api.js";
import { registerConfig } from "./routes/config.js";
import { canonical, credentialName, diffFields, pluginName } from "./declarative.js";
import { cookieOf } from "./server.js";
import { securityHeaders } from "./ui.js";
import { loadConfig } from "./config.js";
import { grantFor } from "./oidc.js";
import { SchemaRegistry } from "./schemas.js";
import { pluginTemplateFaults, templateFault } from "./template.js";
import { loadUnbuilt, unbuiltFaults } from "./unbuilt.js";
import { mergePatch } from "./store.js";

const actor = (role: Actor["role"], workspaces: Actor["workspaces"]): Actor => ({ kind: "token", id: "t", name: "t", role, workspaces });

describe("authorisation decisions", () => {
  it("an editor writes only inside its scope", () => {
    const a = actor("editor", ["ws-1"]);
    expect(canWrite(a, "ws-1")).toBe(true);
    expect(canWrite(a, "ws-2")).toBe(false);
    expect(canRead(a, "ws-2")).toBe(false);
  });

  it("a viewer reads but never writes", () => {
    const a = actor("viewer", "*");
    expect(canRead(a, "any")).toBe(true);
    expect(canWrite(a, "any")).toBe(false);
  });

  it("a node can do nothing on resources", () => {
    const a = actor("node", "*");
    expect(canRead(a, "any")).toBe(false);
    expect(canWrite(a, "any")).toBe(false);
    expect(() => requireNode(a)).not.toThrow();
    expect(() => requireNode(actor("editor", "*"))).toThrow(/data-plane/);
  });

  it("fleet admin means the admin role AND every workspace", () => {
    expect(isAdmin(actor("admin", "*"))).toBe(true);
    expect(isAdmin(actor("admin", ["ws-1"]))).toBe(false);
    expect(() => requireAdmin(actor("editor", "*"))).toThrow();
  });

  it("out of scope is NOT_FOUND, in scope but read-only is FORBIDDEN (no existence leak)", () => {
    expect(() => requireRead(actor("editor", ["ws-1"]), "ws-2")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => requireWrite(actor("editor", ["ws-1"]), "ws-2")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => requireWrite(actor("viewer", ["ws-1"]), "ws-1")).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

describe("caller rate limiter", () => {
  it("allows a burst, then refuses, then refills with time", () => {
    const rl = new CallerRateLimiter(10, 3);
    expect([rl.take("a", 0), rl.take("a", 0), rl.take("a", 0), rl.take("a", 0)]).toEqual([true, true, true, false]);
    expect(rl.take("a", 100)).toBe(true); // 100 ms at 10/s refills one token
    expect(rl.take("b", 0)).toBe(true); // callers are independent
  });

  it("stays bounded when callers are unbounded", () => {
    const rl = new CallerRateLimiter(1, 1, 100);
    for (let i = 0; i < 1000; i++) rl.take(`c${i}`, 0);
    expect((rl as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(100);
  });
});

describe("secrets", () => {
  const key = Buffer.alloc(32, 1);
  const other = Buffer.alloc(32, 2);

  it("round-trips, and the ciphertext does not contain the plaintext", () => {
    const box = new SecretBox(key);
    const sealed = box.seal("-----BEGIN PRIVATE KEY-----abc", "certificate:1");
    expect(sealed).not.toContain("PRIVATE KEY");
    expect(box.open(sealed, "certificate:1")).toBe("-----BEGIN PRIVATE KEY-----abc");
  });

  it("is bound to its resource: another resource's id cannot open it", () => {
    const box = new SecretBox(key);
    expect(() => box.open(box.seal("s", "certificate:1"), "certificate:2")).toThrow();
  });

  it("uses a fresh nonce every time", () => {
    const box = new SecretBox(key);
    expect(box.seal("s", "a")).not.toBe(box.seal("s", "a"));
  });

  it("opens values sealed under the previous key during rotation, and fails with neither", () => {
    const old = new SecretBox(other).seal("s", "a");
    expect(new SecretBox(key, other).open(old, "a")).toBe("s");
    expect(() => new SecretBox(key).open(old, "a")).toThrow(/could not be decrypted/);
  });

  it("rejects a tampered ciphertext", () => {
    const box = new SecretBox(key);
    const parts = box.seal("secret", "a").split(":");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => box.open(parts.join(":"), "a")).toThrow();
  });

  it("parseSecretKey accepts exactly 32 bytes", () => {
    expect(parseSecretKey(key.toString("base64"))).toHaveLength(32);
    expect(() => parseSecretKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 random bytes/);
  });

  it("tokens are long, prefixed and distinct; uuidv7 sorts by time", () => {
    const a = generateToken("apg_at_");
    expect(a).toMatch(/^apg_at_[0-9A-Za-z]{43}$/);
    expect(generateToken("apg_at_")).not.toBe(a);
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true);
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sha256("a")).toHaveLength(64);
    expect(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd")).toBe(true);
  });
});

describe("egress guard", () => {
  const none = parseCidrList("", "X");

  it("classifies loopback, private, link-local and metadata addresses as non-public", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isNonPublic(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1"]) expect(isNonPublic(ip), ip).toBe(false);
    expect(isNonPublic("not-an-ip")).toBe(true);
  });

  it("refuses an address literal in a private range and allows a public one", async () => {
    expect(await egressViolation("169.254.169.254", none)).toMatch(/not a public address/);
    expect(await egressViolation("[::1]", none)).toMatch(/not a public address/);
    expect(await egressViolation("8.8.8.8", none)).toBeNull();
  });

  it("judges a name by what it resolves to: one private record is enough to refuse", async () => {
    expect(await egressViolation("ok.example", none, async () => ["93.184.216.34"])).toBeNull();
    expect(await egressViolation("sneaky.example", none, async () => ["93.184.216.34", "10.0.0.5"])).toMatch(/10\.0\.0\.5/);
    expect(await egressViolation("gone.example", none, async () => { throw new Error("ENOTFOUND"); })).toMatch(/does not resolve/);
  });

  it("honours the allow-list", async () => {
    expect(await egressViolation("10.2.3.4", parseCidrList("10.2.0.0/16", "X"))).toBeNull();
    expect(await egressViolation("10.3.3.4", parseCidrList("10.2.0.0/16", "X"))).not.toBeNull();
    expect(() => parseCidrList("10.0.0.0/40", "X")).toThrow(/CIDR/);
  });
});

describe("small pure helpers", () => {
  it("hostCovered: exact, and a wildcard covers exactly one extra label", () => {
    expect(hostCovered("api.example.com", "api.example.com")).toBe(true);
    expect(hostCovered("*.example.com", "a.example.com")).toBe(true);
    expect(hostCovered("*.example.com", "a.b.example.com")).toBe(false);
    expect(hostCovered("*.example.com", "example.com")).toBe(false);
    expect(hostCovered("*.example.com", "*.example.com")).toBe(true);
    expect(hostCovered("api.example.com", "*.example.com")).toBe(false);
    expect(hostCovered("*.example.com", "evilexample.com")).toBe(false);
  });

  it("mergePatch follows RFC 7386", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: null, x: 9 }, e: [2, 3], a: null })).toEqual({ b: { d: 3, x: 9 }, e: [2, 3] });
  });

  it("slotNameFor matches the node's sanitising rule", () => {
    expect(slotNameFor("proxy-i-0abc123DEF")).toBe("apg_slot_proxy_i_0abc123def");
  });
});

describe("plugin type table", () => {
  it("is identical to the table the node uses (crates/apg-plugin-sdk)", () => {
    const rust = readFileSync(fileURLToPath(new URL("../../crates/apg-plugin-sdk/src/lib.rs", import.meta.url)), "utf8");
    const fromRust = [...rust.matchAll(/name: "(\w+)",\s+default_priority: (\d+),\s+phases: &\[([^\]]*)\]/g)].map((m) => ({
      name: m[1]!,
      default_priority: Number(m[2]),
      phases: m[3]!.split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()),
    }));
    expect(fromRust).toHaveLength(21);
    expect(PLUGIN_TYPES).toEqual(fromRust);
  });
});

describe("OpenAPI document", () => {
  const schemas = new SchemaRegistry(fileURLToPath(new URL("../../schemas/", import.meta.url)));
  registerApi(Fastify(), { deps: { sql: undefined } } as never, schemas);
  registerConfig(Fastify(), { deps: { sql: undefined } } as never, undefined as never, { debugNodeUrl: null, secureCookies: false });
  const document = buildOpenApi(ENDPOINTS, schemas, "0.1.0");

  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(structuredClone(document));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("describes every kind's five operations and resolves every $ref", () => {
    for (const seg of ["domains", "certificates", "ca-certificates", "services", "routes", "consumers", "plugins"]) {
      expect(Object.keys(document["paths"][`/v1/workspaces/{ws}/${seg}`])).toEqual(expect.arrayContaining(["get", "post"]));
      expect(Object.keys(document["paths"][`/v1/workspaces/{ws}/${seg}/{ref}`])).toEqual(expect.arrayContaining(["get", "put", "patch", "delete"]));
    }
    expect(document["paths"]["/v1/workspaces/{ws}/consumers/{parent}/credentials"]).toBeDefined();
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"/]+)/g)].map((m) => m[1]!);
    for (const name of refs) expect(document["components"]["schemas"][name], name).toBeDefined();
  });

  it("matches the committed admin/openapi.json (run `npm run openapi` after changing routes or schemas)", () => {
    const committed = JSON.parse(readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(document)));
  });
});

describe("keys nodes do not enforce yet (schemas/unbuilt.yaml)", () => {
  const list = loadUnbuilt();
  const schemas = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../schemas/resources/${file}`, import.meta.url)), "utf8"));

  it("every entry names a real schema property and repeats its default", () => {
    for (const [file, keys] of [["service.json", [...list.service, ...list.service_database_mode]], ["route.json", list.route], ["settings.json", list.settings]] as const) {
      for (const key of keys) {
        let node = schemas(file);
        for (const part of key.path.split(".")) node = node?.properties?.[part];
        expect(node, `${file}: ${key.path}`).toBeTypeOf("object");
        // A setting exists only once someone sets it, so it is refused whenever present.
        if (file !== "settings.json") expect(key.default, `${file}: ${key.path}`).toEqual(node.default);
      }
    }
  });

  it("a key is refused unless it is absent or carries its default", () => {
    const keys = [{ path: "drain_timeout_ms", default: 30000 }, { path: "keepalive.max_idle_per_backend", default: 64 }, { path: "tls.client_certificate" }];
    expect(unbuiltFaults({}, keys)).toEqual([]);
    expect(unbuiltFaults({ drain_timeout_ms: 30000, keepalive: { idle_ms: 5, max_idle_per_backend: 64 }, tls: { verify: true } }, keys)).toEqual([]);
    expect(unbuiltFaults({ drain_timeout_ms: 1, keepalive: { max_idle_per_backend: 0 }, tls: { client_certificate: "c" } }, keys).map((f) => f.pointer)).toEqual([
      "/drain_timeout_ms", "/keepalive/max_idle_per_backend", "/tls/client_certificate",
    ]);
    // A key with no default is refused whenever it is present.
    expect(unbuiltFaults({ tls: { client_certificate: null } }, keys)).toHaveLength(1);
    expect(unbuiltFaults({ keepalive: 5 }, keys)).toEqual([]);
  });
});

describe("templates are checked on write, by the node's rules (TPL-1)", () => {
  it("accepts variables with a known root and the default filter", () => {
    for (const ok of ["plain", "", "{{ request.id }}", "a {{request.header.x-tenant}} b", "{{ consumer.name | default(\"anonymous\") }}", "{{ jwt.claim.sub | default('none') }}", "{{ env.REGION }}"]) {
      expect(templateFault(ok), ok).toBeNull();
    }
  });

  it("refuses what the node would refuse", () => {
    const cases: Array<[string, RegExp]> = [
      ["{{ unclosed", /unclosed/],
      ["{{ }}", /empty placeholder/],
      ["{{ nobody.home }}", /unknown variable 'nobody.home'/],
      ["{{ request }}", /unknown variable/],
      ["{{ request..id }}", /unknown variable/],
      ["{{ request.id | upper }}", /unsupported filter/],
      ["{{ request.id | default(x) }}", /unsupported filter/],
    ];
    for (const [source, message] of cases) expect(templateFault(source), source).toMatch(message);
  });

  it("finds every template in a plugin configuration, with its pointer", () => {
    expect(pluginTemplateFaults("static_response", { body: "{{ oops" }).map((f) => f.pointer)).toEqual(["/body"]);
    expect(pluginTemplateFaults("request_transformer", { headers: { set: { "x-a": "{{ request.id }}", "x-b": "{{ bad.root }}" } }, body: { set: { "/a/b": "{{ nope", "/n": 5 } } }).map((f) => f.pointer)).toEqual([
      "/headers/set/x-b", "/body/set/~1a~1b",
    ]);
    expect(pluginTemplateFaults("access_log", { custom_fields: { tenant: "{{ workspace.slug }}" } })).toEqual([]);
    expect(pluginTemplateFaults("rate_limit", { scope: "{{ not a template field }}" })).toEqual([]);
  });
});

describe("declarative configuration helpers", () => {
  it("canonical JSON ignores key order and nothing else", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: null }] })).toBe(canonical({ a: [2, { c: null, d: 1 }], b: 1 }));
    expect(canonical({ a: [1, 2] })).not.toBe(canonical({ a: [2, 1] }));
    expect(canonical({ a: undefined, b: 1 })).toBe(canonical({ b: 1 }));
    expect(canonical(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
  });

  it("a diff lists leaf changes by pointer and compares lists whole", () => {
    expect(diffFields({ a: 1, t: { x: 1, y: 2 }, l: [1, 2] }, { a: 1, t: { x: 1, y: 3 }, l: [1, 2, 3], n: true })).toEqual([
      { pointer: "/l", before: [1, 2], after: [1, 2, 3] },
      { pointer: "/n", after: true },
      { pointer: "/t/y", before: 2, after: 3 },
    ]);
    expect(diffFields({ "a/b": 1 }, { "a/b": 2 })[0]!.pointer).toBe("/a~1b");
    expect(diffFields({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
  });

  it("unnamed plugins and credentials get the same name every time", () => {
    expect(pluginName({ type: "key_auth", scope: "route", scope_ref: "orders-api" })).toBe("key_auth.route.orders-api");
    expect(pluginName({ type: "rate_limit", scope: "workspace", consumer: "mobile" })).toBe("rate_limit.workspace.c-mobile");
    expect(pluginName({ type: "cors", scope: "route", scope_ref: "x".repeat(200) })).toHaveLength(128);
    expect(credentialName({ type: "basic", username: "Mobile User" })).toBe("basic-mobile-user");
    expect(credentialName({ type: "key", key: "0123456789abcdef" })).toBe(credentialName({ type: "key", key: { $secret: "0123456789abcdef" } }));
    // a key the server is to generate, or to keep, cannot name itself
    expect(credentialName({ type: "key" })).toBeNull();
    expect(credentialName({ type: "key", key: { $secret: "***" } })).toBeNull();
  });
});

describe("single sign-on settings", () => {
  const base = { APG_DATABASE_URL: "postgres://x/y", APG_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") };
  const oidc = { ...base, APG_OIDC_ISSUER: "https://idp.example.com/", APG_OIDC_CLIENT_ID: "apg", APG_PUBLIC_URL: "https://admin.example.com", APG_OIDC_ROLE_MAP: '{"gw-admins":{"role":"admin"},"acme-devs":{"role":"editor","workspaces":["acme"]}}' };

  it("is off unless an issuer is named, and complete when it is", () => {
    expect(loadConfig(base).oidc).toBeNull();
    expect(loadConfig(oidc).oidc).toEqual({
      issuer: "https://idp.example.com", clientId: "apg", clientSecret: null, roleClaim: "groups", publicUrl: "https://admin.example.com", scopes: "openid profile email",
      roleMap: [["gw-admins", { role: "admin", workspaces: ["*"] }], ["acme-devs", { role: "editor", workspaces: ["acme"] }]],
    });
  });

  it("refuses a setup in which nobody, or everybody, could sign in", () => {
    const without = (key: string) => Object.fromEntries(Object.entries(oidc).filter(([k]) => k !== key));
    expect(() => loadConfig(without("APG_OIDC_ROLE_MAP"))).toThrow(/APG_OIDC_ROLE_MAP/);
    expect(() => loadConfig(without("APG_PUBLIC_URL"))).toThrow(/APG_PUBLIC_URL/);
    expect(() => loadConfig(without("APG_OIDC_CLIENT_ID"))).toThrow(/APG_OIDC_CLIENT_ID/);
    expect(() => loadConfig({ ...oidc, APG_OIDC_ROLE_MAP: "{}" })).toThrow(/at least one/);
    expect(() => loadConfig({ ...oidc, APG_OIDC_ROLE_MAP: '{"x":{"role":"node"}}' })).toThrow(/admin, editor or viewer/);
    expect(() => loadConfig({ ...oidc, APG_OIDC_ROLE_MAP: '{"x":{"role":"viewer","workspaces":[]}}' })).toThrow(/workspaces/);
    expect(() => loadConfig({ ...oidc, APG_OIDC_ROLE_MAP: "not json" })).toThrow(/must be JSON/);
    expect(() => loadConfig({ ...oidc, APG_OIDC_ISSUER: "http://idp.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, APG_OIDC_CLIENT_ID: "apg" })).toThrow(/APG_OIDC_ISSUER is not/);
  });

  it("grants by the first matching entry of the map, and nothing when none matches", () => {
    const map = loadConfig(oidc).oidc!.roleMap;
    expect(grantFor(["staff", "acme-devs", "gw-admins"], map)).toEqual({ role: "admin", workspaces: ["*"] });
    expect(grantFor("acme-devs", map)).toEqual({ role: "editor", workspaces: ["acme"] });
    expect(grantFor(["staff"], map)).toBeNull();
    expect(grantFor(undefined, map)).toBeNull();
    expect(grantFor([{ name: "gw-admins" }], map)).toBeNull();
  });
});

describe("the UI host", () => {

  it("nobody may frame the UI unless an origin is listed", () => {
    expect(securityHeaders({ embedOrigins: [], logoUrl: null })["content-security-policy"]).toContain("frame-ancestors 'none'");
    const csp = securityHeaders({ embedOrigins: ["https://portal.example.com"], logoUrl: "https://cdn.example.com/logo.svg" })["content-security-policy"]!;
    expect(csp).toContain("frame-ancestors https://portal.example.com");
    expect(csp).toContain("img-src 'self' data: https://cdn.example.com");
  });

  it("reads one cookie out of a header", () => {
    expect(cookieOf("a=1; apg_session=abc; b=2", "apg_session")).toBe("abc");
    expect(cookieOf("xapg_session=abc", "apg_session")).toBeUndefined();
    expect(cookieOf(undefined, "apg_session")).toBeUndefined();
  });

  it("checks its settings at start", () => {
    const base = { APG_DATABASE_URL: "postgres://x/y", APG_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") };
    expect(loadConfig(base).ui).toMatchObject({ enabled: true, brandName: "valkv-apg", embedOrigins: [] });
    expect(loadConfig({ ...base, APG_UI_EMBED_ORIGINS: "https://a.example.com, https://b.example.com/" }).ui.embedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(() => loadConfig({ ...base, APG_UI_EMBED_ORIGINS: "https://a.example.com/portal" })).toThrow(/origin only/);
    expect(() => loadConfig({ ...base, APG_UI_PRIMARY_COLOR: "blue" })).toThrow(/APG_UI_PRIMARY_COLOR/);
    expect(() => loadConfig({ ...base, APG_UI_LOGO_URL: "javascript:alert(1)" })).toThrow(/APG_UI_LOGO_URL/);
    expect(() => loadConfig({ ...base, APG_DEBUG_NODE_URL: "node:9100" })).toThrow(/APG_DEBUG_NODE_URL/);
  });
});
