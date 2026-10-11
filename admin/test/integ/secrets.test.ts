// No secret in any output (spec SEC-8), on the control plane's side: distinctive
// secret values are written through every door, and then every row of every
// table and every readable API response is searched for them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, fixture, start } from "./harness.js";

let h: Harness;

// Each one is unlike anything else the system produces, so a hit is a leak.
const SECRETS = {
  apiKey: "leak-canary-api-key-7f3a9c2e41d8",
  password: "leak-canary-password-51b0e6",
  jwtSecret: "leak-canary-jwt-shared-secret-9d2c",
  calloutToken: "leak-canary-callout-bearer-33aa",
  documentKey: "leak-canary-document-key-c4e1f0a9",
  adminToken: "apg_at_leak-canary-admin-token-88e1b2c3d4",
};
/** A line from the middle of the private key: it appears nowhere but in the key. */
let keyLine: string;
let sessionCookie: string;
let generatedKey: string;
let generatedToken: string;

beforeAll(async () => {
  h = await start("secrets");
  const D = "/v1/workspaces/default";
  const key = fixture("test-cert.key");
  keyLine = key.split("\n").filter((l) => l.length > 40 && !l.startsWith("-----"))[3]!;

  const ok = (res: { status: number; text: string }) => expect(res.status, res.text).toBeLessThan(300);
  ok(await h.call("POST", `${D}/certificates`, { body: { name: "leak-cert", cert_pem: fixture("test-cert.crt"), key_pem: key } }));
  ok(await h.call("POST", `${D}/services`, { body: { name: "leak-svc", backends: [{ target: "10.0.0.1:80" }] } }));
  ok(await h.call("POST", `${D}/routes`, { body: { name: "leak-route", service: "leak-svc", hosts: ["leak.example.com"] } }));
  ok(await h.call("POST", `${D}/plugins`, { body: { type: "jwt_auth", scope: "route", scope_ref: "leak-route", config: { issuer: "https://issuer.example.com", secret: { $secret: SECRETS.jwtSecret }, algorithms: ["HS256"] } } }));
  ok(await h.call("POST", `${D}/consumers`, { body: { name: "leak-app" } }));
  ok(await h.call("POST", `${D}/consumers/leak-app/credentials`, { body: { name: "given", type: "key", key: SECRETS.apiKey } }));
  ok(await h.call("POST", `${D}/consumers/leak-app/credentials`, { body: { name: "login", type: "basic", username: "leak-user", password: SECRETS.password } }));
  const generated = await h.call("POST", `${D}/consumers/leak-app/credentials`, { body: { name: "generated", type: "key" } });
  generatedKey = generated.json.key;

  // The same kinds of secret through the declarative door, which also stores a revision.
  ok(await h.call("POST", "/v1/config/apply", { body: { message: "leak test", document: {
    version: 1,
    consumers: [{ name: "leak-doc-app", credentials: [{ name: "k", type: "key", key: SECRETS.documentKey }] }],
    routes: [{ name: "leak-doc-route", service: "leak-svc", hosts: ["leak-doc.example.com"], plugins: [
      { type: "http_callout", config: { url: "https://hooks.example.com/x", secret: { $secret: SECRETS.calloutToken } } },
    ] }],
  } } }));

  const token = await h.call("POST", "/v1/tokens", { body: { name: "leak-token", role: "viewer" } });
  generatedToken = token.json.token;
  const session = await h.call("POST", "/v1/session", {});
  sessionCookie = String(session.headers["set-cookie"]).split(";")[0]!.split("=")[1]!;
  // Refused and failed calls are audited too.
  await h.call("POST", `${D}/consumers/leak-app/credentials`, { token: generatedToken, body: { type: "key", key: `${SECRETS.apiKey}-refused` } });
  await h.call("PUT", `${D}/consumers/leak-app/credentials/given`, { body: { type: "basic", username: "x", password: SECRETS.password } });
});
afterAll(async () => h.close());

const needles = () => ({ ...SECRETS, keyLine, sessionCookie, generatedKey, generatedToken, bootstrapAdmin: h.tokens.admin, bootstrapNode: h.tokens.node });

describe("no secret in any output", () => {
  it("the plugins store their secret settings sealed, so the test above means something", async () => {
    // If the plugin stopped treating this value as a secret, the sweep below would catch it in the plugins table.
    const plugins = await h.sql`SELECT config FROM apg_plugins WHERE type IN ('http_callout', 'jwt_auth')`;
    expect(plugins).toHaveLength(2);
    expect(JSON.stringify(plugins)).toContain("$secret_ciphertext");
  });

  it("no table holds one in clear: not the resources, the changelog, the audit log, the revisions or the sessions", async () => {
    const tables = (await h.sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'apg\_%' ORDER BY 1`).map((t) => t.table_name);
    expect(tables).toEqual(expect.arrayContaining(["apg_changes", "apg_audit_log", "apg_config_revisions", "apg_sessions", "apg_credentials", "apg_plugins", "apg_certificates", "apg_admin_tokens", "apg_idempotency_keys"]));
    const leaks: string[] = [];
    for (const table of tables) {
      const [row] = await h.sql.unsafe<Array<{ text: string | null; n: number }>>(`SELECT string_agg(to_jsonb(t)::text, E'\\n') AS text, count(*)::int AS n FROM ${table} t`);
      for (const [name, value] of Object.entries(needles())) {
        if (row!.text?.includes(value)) leaks.push(`${table} holds ${name}`);
      }
    }
    expect(leaks).toEqual([]);
    // The tables were not simply empty.
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_changes`)[0]!["n"]).toBeGreaterThan(8);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_audit_log`)[0]!["n"]).toBeGreaterThan(8);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_config_revisions`)[0]!["n"]).toBe(1);
  });

  it("nodes receive hashes and ciphertext, which is what they need and all they get", async () => {
    const events = JSON.stringify(await h.events());
    expect(events).toContain("key_hash");
    expect(events).toContain("password_hash");
    expect(events).toContain("key_ciphertext");
    expect(events).toContain("$secret_ciphertext");
    for (const [name, value] of Object.entries(needles())) expect(events.includes(value), name).toBe(false);
  });

  it("no API response shows one after the response that created it", async () => {
    const D = "/v1/workspaces/default";
    const revisions = (await h.call("GET", "/v1/config/revisions")).json.data;
    const paths = [
      `${D}/certificates`, `${D}/certificates/leak-cert`, `${D}/plugins`, `${D}/consumers`, `${D}/consumers/leak-app/credentials`,
      `${D}/consumers/leak-app/credentials/given`, `${D}/consumers/leak-app/credentials/login`, `${D}/consumers/leak-doc-app/credentials`,
      `${D}/routes`, `${D}/services`, "/v1/tokens", "/v1/audit?limit=500", "/v1/config/dump", "/v1/config/revisions",
      `/v1/config/revisions/${revisions[0].id}`, "/v1/session", "/v1/settings", "/v1/flags", "/v1/nodes", "/metrics",
    ];
    const leaks: string[] = [];
    for (const path of paths) {
      const res = await h.call("GET", path);
      expect(res.status, path).toBe(200);
      for (const [name, value] of Object.entries(needles())) if (res.text.includes(value)) leaks.push(`GET ${path} shows ${name}`);
    }
    expect(leaks).toEqual([]);
    // A diff of a document that changes a secret says that it changed, not what to.
    const diff = await h.call("POST", "/v1/config/diff", { body: { document: { version: 1, consumers: [{ name: "leak-doc-app", credentials: [{ name: "k", type: "key", key: `${SECRETS.documentKey}-rotated` }] }] } } });
    expect(diff.json.changes[0].fields).toEqual([{ pointer: "/key", before: "***", after: "*** (changed)" }]);
    expect(diff.text).not.toContain(SECRETS.documentKey);
  });

  it("an error message never repeats a secret it was sent", async () => {
    const D = "/v1/workspaces/default";
    const attempts = [
      await h.call("POST", `${D}/consumers/leak-app/credentials`, { body: { name: "given", type: "key", key: SECRETS.apiKey } }), // duplicate
      await h.call("POST", `${D}/consumers/leak-app/credentials`, { body: { name: "bad", type: "basic", username: "has:colon", password: SECRETS.password } }),
      await h.call("POST", `${D}/certificates`, { body: { name: "bad-cert", cert_pem: fixture("test-cert.crt"), key_pem: fixture("other.key") } }),
      await h.call("POST", `${D}/plugins`, { body: { type: "jwt_auth", scope: "workspace", config: { issuer: 5, secret: { $secret: SECRETS.jwtSecret } } } }),
      await h.call("GET", `${D}/services`, { token: SECRETS.adminToken }),
    ];
    for (const res of attempts) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      for (const [name, value] of Object.entries(needles())) expect(res.text.includes(value), `${res.status} ${name}`).toBe(false);
      expect(res.text).not.toContain(fixture("other.key").split("\n")[4]!);
    }
  });
});
