// Delegated JWT authentication (spec API-4) and DNS domain verification,
// against a real Postgres.

import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Authenticator } from "../../src/auth.js";
import { buildServer } from "../../src/server.js";
import { type Harness, start } from "./harness.js";

let h: Harness;
let app: ReturnType<typeof buildServer>;
let sign: (claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string; key?: CryptoKey }) => Promise<string>;
let tenant: string;
let rival: string;

async function call(method: string, url: string, token: string, body?: unknown) {
  const res = await app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
}

beforeAll(async () => {
  h = await start("delegated", { domainVerification: "dns_txt" });
  tenant = (await h.call("POST", "/v1/workspaces", { body: { name: "acme" } })).json.id;
  rival = (await h.call("POST", "/v1/workspaces", { body: { name: "rival" } })).json.id;

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const auth = new Authenticator(h.sql, {
    jwksUrl: null,
    publicKeyPem: await exportSPKI(publicKey),
    issuer: "https://platform.example",
    audience: "valkv-apg",
    workspaceClaim: "tenant.id",
    roleClaim: "apg_role",
  });
  app = buildServer({ logLevel: "error" }, { pingDatabase: async () => {}, store: h.store, schemas: h.store.deps.schemas, auth, notifier: h.notifier });
  await app.ready();

  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user-1")
      .setIssuer(opts.issuer ?? "https://platform.example")
      .setAudience(opts.audience ?? "valkv-apg")
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(opts.key ?? privateKey);
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe("delegated JWT", () => {
  it("acts as an editor scoped to exactly the workspace in the claim", async () => {
    const token = await sign({ tenant: { id: tenant } });
    expect((await call("POST", `/v1/workspaces/${tenant}/consumers`, token, { name: "from-jwt" })).status).toBe(201);
    expect((await call("GET", "/v1/workspaces", token)).json.data.map((w: any) => w.id)).toEqual([tenant]);
    // another tenant's workspace does not exist as far as this caller can tell
    expect((await call("GET", `/v1/workspaces/${rival}/consumers`, token)).status).toBe(404);
    expect((await call("GET", "/v1/workspaces/default/services", token)).status).toBe(404);
  });

  it("is recorded in the audit log as the token's subject", async () => {
    const row = await h.sql`SELECT actor_kind, actor_id FROM apg_audit_log WHERE resource_name = 'from-jwt'`;
    expect(row[0]).toMatchObject({ actor_kind: "jwt", actor_id: "user-1" });
  });

  it("the role claim can lower the role but can never produce a node or a fleet admin", async () => {
    const viewer = await sign({ tenant: { id: tenant }, apg_role: "viewer" });
    expect((await call("POST", `/v1/workspaces/${tenant}/consumers`, viewer, { name: "x" })).status).toBe(403);
    const admin = await sign({ tenant: { id: tenant }, apg_role: "admin" });
    expect((await call("GET", "/v1/tokens", admin)).status).toBe(403); // admin of one workspace is not a fleet admin
    expect((await call("POST", "/v1/workspaces", admin, { name: "nope" })).status).toBe(403);
    const node = await sign({ tenant: { id: tenant }, apg_role: "node" });
    expect((await call("GET", "/dp/changes", node)).status).toBe(403);
  });

  it("refuses a token with no workspace claim, a wrong issuer or audience, an expired one, or a foreign signature", async () => {
    const other = await generateKeyPair("ES256");
    const bad = [
      await sign({}),
      await sign({ tenant: { id: "" } }),
      await sign({ tenant: { id: tenant } }, { issuer: "https://evil.example" }),
      await sign({ tenant: { id: tenant } }, { audience: "something-else" }),
      await sign({ tenant: { id: tenant } }, { expiresIn: "-10m" }),
      await sign({ tenant: { id: tenant } }, { key: other.privateKey }),
    ];
    for (const token of bad) expect((await call("GET", "/v1/workspaces", token)).status).toBe(401);
  });

  it("refuses an unsigned token (alg none)", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", iss: "https://platform.example", aud: "valkv-apg", tenant: { id: tenant }, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect((await call("GET", "/v1/workspaces", forged)).status).toBe(401);
  });

  it("admin tokens still work alongside JWTs", async () => {
    expect((await call("GET", "/v1/tokens", h.tokens.admin)).status).toBe(200);
  });
});

describe("domain verification by DNS (APG_DOMAIN_VERIFICATION=dns_txt)", () => {
  let editor: string;
  beforeAll(async () => {
    editor = await h.token("editor", [tenant]);
  });

  it("a tenant's domain starts pending, cannot back a route, and activates once the TXT record holds the token", async () => {
    const base = `/v1/workspaces/${tenant}`;
    h.dns.set("backend.example", ["93.184.216.34"]);
    await h.call("POST", `${base}/services`, { token: editor, body: { name: "app", backends: [{ target: "backend.example:80" }] } });

    const before = await h.lastSeq();
    const made = await h.call("POST", `${base}/domains`, { token: editor, body: { hostname: "shop.acme.test", tls: { mode: "none" } } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ status: "pending", verification: { method: "dns_txt", record: "_apg-challenge.shop.acme.test" } });
    const token: string = made.json.verification.token;

    // not usable until proven
    const early = await h.call("POST", `${base}/routes`, { token: editor, body: { name: "r", service: "app", hosts: ["shop.acme.test"] } });
    expect(early.json.error.code).toBe("HOST_NOT_OWNED");

    const notYet = await h.call("POST", `${base}/domains/shop.acme.test/verify`, { token: editor });
    expect(notYet.json).toMatchObject({ status: "pending" });
    expect(notYet.json.status_reason).toContain("_apg-challenge.shop.acme.test");

    h.txt.set("_apg-challenge.shop.acme.test", [["unrelated"], [token]]);
    const verified = await h.call("POST", `${base}/domains/shop.acme.test/verify`, { token: editor });
    expect(verified.json.status).toBe("active");
    expect((await h.call("POST", `${base}/routes`, { token: editor, body: { name: "r", service: "app", hosts: ["shop.acme.test"] } })).status).toBe(201);

    // nodes hear about the domain when created (pending) and again when it becomes active
    const statuses = (await h.events(before)).filter((e) => e.data["kind"] === "domain").map((e) => e.data["data"].status);
    expect(statuses).toEqual(["pending", "active"]);
  });

  it("a caller cannot set status or verification itself", async () => {
    const res = await h.call("POST", `/v1/workspaces/${tenant}/domains`, { token: editor, body: { hostname: "skip.acme.test", tls: { mode: "none" }, status: "active", verification: { method: "none" } } });
    expect(res.status).toBe(201);
    expect(res.json.status).toBe("pending");
  });

  it("the operator's own domains need no verification", async () => {
    const res = await h.call("POST", "/v1/workspaces/default/domains", { body: { hostname: "ops.example.com", tls: { mode: "none" } } });
    expect(res.json.status).toBe("active");
  });
});
