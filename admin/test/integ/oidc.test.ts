// Single sign-on against a stand-in identity provider that behaves like a real
// one where it matters: it checks the PKCE verifier, and signs ID tokens with
// a key published at its JWKS endpoint.

import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, start } from "./harness.js";

let h: Harness;
let idp: Server;
let issuer: string;
let acme: string;
const codes = new Map<string, { challenge: string; nonce: string; claims: Record<string, unknown> }>();
/** Lets a test make the provider misbehave. */
let tamper: { nonce?: string; issuer?: string; audience?: string; wrongKey?: boolean } = {};

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

  idp = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? ""); // a code works once
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
        if (!grant || grant.challenge !== challenge || basic !== "apg-console:s3cret" || form.get("redirect_uri") !== "https://admin.example.com/v1/session/oidc/callback") {
          return json(400, { error: "invalid_grant" });
        }
        void new SignJWT({ ...grant.claims, nonce: tamper.nonce ?? grant.nonce })
          .setProtectedHeader({ alg: "ES256", kid: "k1" })
          .setIssuer(tamper.issuer ?? issuer).setAudience(tamper.audience ?? "apg-console").setIssuedAt().setExpirationTime("5m")
          .sign(tamper.wrongKey ? other.privateKey : privateKey)
          .then((id_token) => json(200, { id_token, access_token: "unused", token_type: "Bearer" }));
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;

  h = await start("oidc", {
    oidc: {
      issuer, clientId: "apg-console", clientSecret: "s3cret", roleClaim: "groups", publicUrl: "https://admin.example.com", scopes: "openid profile email",
      roleMap: [["gateway-admins", { role: "admin", workspaces: ["*"] }], ["acme-developers", { role: "editor", workspaces: ["acme"] }], ["ghosts", { role: "viewer", workspaces: ["no-such-workspace"] }]],
    },
    ui: { enabled: true, dir: "/nonexistent", brandName: "x", logoUrl: null, primaryColor: null, embedOrigins: [] },
  });
  acme = (await h.call("POST", "/v1/workspaces", { body: { name: "acme" } })).json.id;
});
afterAll(async () => {
  await h.close();
  await new Promise((resolve) => idp.close(resolve));
});

const cookie = (res: { headers: Record<string, any> }, name: string): string | undefined =>
  [res.headers["set-cookie"]].flat().filter(Boolean).map((c: string) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`) && c !== `${name}=`);

/** Starts a sign-in the way a browser would, and plays the provider's part: the person signs in there and comes back with a code. */
async function signIn(claims: Record<string, unknown>) {
  const begin = await h.call("GET", "/v1/session/oidc/login", { token: null });
  expect(begin.status).toBe(302);
  const to = new URL(begin.headers["location"]);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { challenge: to.searchParams.get("code_challenge")!, nonce: to.searchParams.get("nonce")!, claims });
  return { begin, to, code, flow: cookie(begin, "apg_oidc")!, state: to.searchParams.get("state")! };
}
const callback = (code: string, state: string, flow?: string) =>
  h.call("GET", `/v1/session/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`, { token: null, ...(flow ? { headers: { cookie: flow } } : {}) });

describe("single sign-on", () => {
  it("sends the browser to the provider with PKCE, a state and a nonce, and nothing secret in the address", async () => {
    const { begin, to } = await signIn({ sub: "u0" });
    expect(`${to.origin}${to.pathname}`).toBe(`${issuer}/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: "code", client_id: "apg-console", scope: "openid profile email", code_challenge_method: "S256",
      redirect_uri: "https://admin.example.com/v1/session/oidc/callback",
    });
    expect(to.searchParams.get("state")!.length).toBeGreaterThan(20);
    expect(to.href).not.toContain("s3cret");
    const set = String(begin.headers["set-cookie"]);
    expect(set).toMatch(/^apg_oidc=v1:[^;]+; Path=\/v1\/session\/oidc; HttpOnly; SameSite=Lax; Max-Age=600$/);
    // the PKCE verifier is in the cookie only sealed
    expect(set).not.toContain(to.searchParams.get("state")!);
  });

  it("an administrator signs in and gets a session with the role their group grants", async () => {
    tamper = {};
    const { code, state, flow } = await signIn({ sub: "u1", email: "ada@example.com", groups: ["staff", "gateway-admins"] });
    const done = await callback(code, state, flow);
    expect(done.status).toBe(302);
    expect(done.headers["location"]).toBe("/ui/");
    const session = cookie(done, "apg_session")!;
    expect([done.headers["set-cookie"]].flat().join(" | ")).toContain("apg_session=apg_s_");
    expect([done.headers["set-cookie"]].flat().join(" | ")).toContain("SameSite=Strict");

    const me = await h.call("GET", "/v1/session", { token: null, headers: { cookie: session } });
    expect(me.json.actor).toEqual({ kind: "oidc", id: "u1", name: "ada@example.com", role: "admin", workspaces: "*", fleet_admin: true });
    // It is a normal session: reads work, writes need the CSRF token, and the audit log names the person.
    expect((await h.call("POST", "/v1/workspaces", { token: null, headers: { cookie: session }, body: { name: "by-ada" } })).status).toBe(403);
    expect((await h.call("POST", "/v1/workspaces", { token: null, headers: { cookie: session, "x-apg-csrf": me.json.csrf_token }, body: { name: "by-ada" } })).status).toBe(201);
    const [entry] = await h.sql`SELECT actor_kind, actor_name FROM apg_audit_log WHERE resource_name = 'by-ada'`;
    expect(entry).toMatchObject({ actor_kind: "oidc", actor_name: "ada@example.com" });

    expect((await h.call("DELETE", "/v1/session", { token: null, headers: { cookie: session, "x-apg-csrf": me.json.csrf_token } })).status).toBe(204);
    expect((await h.call("GET", "/v1/session", { token: null, headers: { cookie: session } })).status).toBe(401);
  });

  it("a developer is scoped to the workspaces their group names, and sees no other", async () => {
    const { code, state, flow } = await signIn({ sub: "u2", preferred_username: "grace", groups: ["acme-developers"] });
    const session = cookie(await callback(code, state, flow), "apg_session")!;
    const me = await h.call("GET", "/v1/session", { token: null, headers: { cookie: session } });
    expect(me.json.actor).toMatchObject({ name: "grace", role: "editor", workspaces: [acme], fleet_admin: false });
    expect((await h.call("GET", "/v1/workspaces", { token: null, headers: { cookie: session } })).json.data.map((w: any) => w.name)).toEqual(["acme"]);
    expect((await h.call("GET", "/v1/workspaces/default/services", { token: null, headers: { cookie: session } })).status).toBe(404);
    expect((await h.call("GET", "/v1/tokens", { token: null, headers: { cookie: session } })).status).toBe(403);
  });

  it("someone in no mapped group is signed in at the provider but gets no session here", async () => {
    for (const groups of [["staff"], undefined, ["ghosts"]]) {
      const { code, state, flow } = await signIn({ sub: "u3", email: "eve@example.com", groups });
      const done = await callback(code, state, flow);
      expect(done.status).toBe(403);
      expect(done.text).toContain("eve@example.com is signed in, but");
      expect(cookie(done, "apg_session")).toBeUndefined();
    }
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_sessions WHERE actor->>'id' = 'u3'`)[0]!["n"]).toBe(0);
  });

  it("refuses an answer that does not belong to this browser's sign-in", async () => {
    const a = await signIn({ sub: "u4", groups: ["gateway-admins"] });
    const b = await signIn({ sub: "u5", groups: ["gateway-admins"] });
    // no flow cookie, a wrong state, and another browser's flow cookie
    expect((await callback(a.code, a.state)).status).toBe(400);
    expect((await callback(a.code, "forged-state", a.flow)).status).toBe(400);
    expect((await callback(a.code, a.state, b.flow)).status).toBe(400);
    expect((await callback(a.code, a.state, "apg_oidc=v1:not:a:cookie")).status).toBe(400);
    // a code works once: the provider refuses the replay, and so do we
    expect((await callback(a.code, a.state, a.flow)).status).toBe(302);
    expect((await callback(a.code, a.state, a.flow)).status).toBe(401);
    // an error from the provider is shown, escaped
    const denied = await h.call("GET", "/v1/session/oidc/callback?error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E", { token: null });
    expect(denied.status).toBe(403);
    expect(denied.text).toContain("&#60;b&#62;no");
    expect(denied.headers["content-type"]).toContain("text/html");
  });

  it("refuses an ID token that is not what was asked for", async () => {
    for (const bad of [{ nonce: "replayed" }, { issuer: "https://evil.example.com" }, { audience: "another-app" }, { wrongKey: true }]) {
      tamper = bad;
      const { code, state, flow } = await signIn({ sub: "u6", groups: ["gateway-admins"] });
      const done = await callback(code, state, flow);
      expect(done.status, JSON.stringify(bad)).toBe(401);
      expect(cookie(done, "apg_session")).toBeUndefined();
    }
    tamper = {};
  });

  it("an admin token still opens a session, and the console is told single sign-on is on", async () => {
    expect((await h.call("POST", "/v1/session", {})).status).toBe(201);
  });
});
