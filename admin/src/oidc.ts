/**
 * Single sign-on for the console with OpenID Connect (spec API-5).
 *
 * Authorisation code flow with PKCE. The admin is the relying party:
 *
 *   GET /v1/session/oidc/login     redirects the browser to the identity provider
 *   GET /v1/session/oidc/callback  exchanges the code, checks the ID token, maps
 *                                  the person to a role, opens a session, and
 *                                  sends the browser to the console
 *
 * What a person may do comes from one claim of the ID token (by default
 * `groups`) looked up in `APG_OIDC_ROLE_MAP`. A person whose claim matches
 * nothing gets no session: there is no default role.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import { type Actor, type Authenticator, type Role, SESSION_COOKIE, SESSION_HOURS } from "./auth.js";
import type { SecretBox } from "./crypto.js";
import type { Sql } from "./db.js";
import { ApiError } from "./errors.js";
import { cookieOf } from "./server.js";
import { isUuid } from "./store.js";

/** One entry of the role map: what a claim value grants. */
export interface RoleGrant {
  role: Exclude<Role, "node">;
  /** `["*"]`, or workspace names or ids. */
  workspaces: string[];
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  /** Claim of the ID token that holds the person's groups or role; dots reach into nested objects. */
  roleClaim: string;
  /** Claim value to grant, tried in the order written. */
  roleMap: Array<[string, RoleGrant]>;
  /** How browsers reach this admin, for example https://admin.example.com. */
  publicUrl: string;
  scopes: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

const FLOW_COOKIE = "apg_oidc";
const FLOW_SECONDS = 600;
const b64url = (buf: Buffer) => buf.toString("base64url");

/** The grant for a claim value: the first entry of the map that the person's values contain. */
export function grantFor(claim: unknown, map: OidcConfig["roleMap"]): RoleGrant | null {
  const values = (Array.isArray(claim) ? claim : [claim]).filter((v): v is string => typeof v === "string");
  for (const [value, grant] of map) if (values.includes(value)) return grant;
  return null;
}

export class Oidc {
  private discovery: Promise<Discovery> | null = null;
  private keys: JWTVerifyGetKey | null = null;

  constructor(
    private readonly config: OidcConfig,
    private readonly sql: Sql,
    private readonly box: SecretBox,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private get redirectUri(): string {
    return `${this.config.publicUrl}/v1/session/oidc/callback`;
  }

  /** The provider's endpoints, read once. A failed read is tried again on the next sign-in. */
  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await this.fetcher(`${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`discovery answered ${res.status}`);
      const doc = (await res.json()) as Discovery;
      // The document must be the issuer's own: otherwise anyone who can answer for that URL could name other endpoints.
      if (doc.issuer !== this.config.issuer) throw new Error(`discovery names issuer '${doc.issuer}', not '${this.config.issuer}'`);
      return doc;
    })().catch((err) => {
      this.discovery = null;
      throw new ApiError("UNAVAILABLE", `the identity provider cannot be reached: ${(err as Error).message}`);
    });
    return this.discovery;
  }

  /** Where to send the browser, and the cookie that ties the answer to this browser. */
  async begin(): Promise<{ location: string; cookie: string }> {
    const d = await this.discover();
    const flow = { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), at: Date.now() };
    const url = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: this.config.clientId, redirect_uri: this.redirectUri, scope: this.config.scopes,
      state: flow.state, nonce: flow.nonce,
      code_challenge: b64url(createHash("sha256").update(flow.verifier).digest()), code_challenge_method: "S256",
    })) url.searchParams.set(k, v);
    // Sealed, so the verifier and the expected nonce never travel in clear and cannot be forged.
    return { location: url.href, cookie: this.box.seal(JSON.stringify(flow), "oidc-flow") };
  }

  /** Finishes a sign-in. Returns who the person is; throws when anything does not check out. */
  async finish(query: { code?: string; state?: string; error?: string; error_description?: string }, sealedFlow: string | undefined): Promise<Actor> {
    if (query.error) throw new ApiError("FORBIDDEN", `the identity provider refused the sign-in: ${query.error_description ?? query.error}`);
    let flow: { state: string; nonce: string; verifier: string; at: number };
    try {
      flow = JSON.parse(this.box.open(sealedFlow ?? "", "oidc-flow"));
    } catch {
      throw new ApiError("BAD_REQUEST", "this sign-in was not started in this browser, or it took too long; start again");
    }
    if (!query.code || !query.state || query.state !== flow.state || Date.now() - flow.at > FLOW_SECONDS * 1000) {
      throw new ApiError("BAD_REQUEST", "this sign-in was not started in this browser, or it took too long; start again");
    }

    const d = await this.discover();
    const form = new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: this.redirectUri, client_id: this.config.clientId, code_verifier: flow.verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (this.config.clientSecret) headers["authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString("base64")}`;
    let tokens: { id_token?: string };
    try {
      const res = await this.fetcher(d.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      tokens = (await res.json()) as { id_token?: string };
    } catch (err) {
      throw new ApiError("UNAUTHENTICATED", `the identity provider did not accept the sign-in (${(err as Error).message})`);
    }
    if (typeof tokens.id_token !== "string") throw new ApiError("UNAUTHENTICATED", "the identity provider returned no ID token");

    this.keys ??= createRemoteJWKSet(new URL(d.jwks_uri));
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(tokens.id_token, this.keys, {
        issuer: this.config.issuer, audience: this.config.clientId, clockTolerance: 60,
        algorithms: ["RS256", "RS384", "RS512", "PS256", "ES256", "ES384", "EdDSA"],
      }));
    } catch {
      throw new ApiError("UNAUTHENTICATED", "the ID token did not pass verification");
    }
    if (claims["nonce"] !== flow.nonce) throw new ApiError("UNAUTHENTICATED", "the ID token did not pass verification");

    let claim: unknown = claims;
    for (const part of this.config.roleClaim.split(".")) claim = typeof claim === "object" && claim !== null ? (claim as Record<string, unknown>)[part] : undefined;
    const grant = grantFor(claim, this.config.roleMap);
    const name = [claims["email"], claims["preferred_username"], claims["name"], claims["sub"]].find((v): v is string => typeof v === "string" && v !== "") ?? "unknown";
    if (!grant) throw new ApiError("FORBIDDEN", `${name} is signed in, but is in no group that has access to this gateway`);

    // Workspaces are written by name in the map and held by id in a session.
    let workspaces: "*" | string[] = "*";
    if (!grant.workspaces.includes("*")) {
      const names = grant.workspaces.filter((w) => !isUuid(w));
      const rows = names.length > 0 ? await this.sql<Array<{ id: string }>>`SELECT id FROM apg_workspaces WHERE name = ANY(${names})` : [];
      workspaces = [...grant.workspaces.filter(isUuid), ...rows.map((r) => r.id)];
      if (workspaces.length === 0) throw new ApiError("FORBIDDEN", `${name} is signed in, but none of the workspaces granted to them exists`);
    }
    return { kind: "oidc", id: String(claims["sub"]), name, role: grant.role, workspaces };
  }
}

/** The two browser-facing endpoints. They are reached without credentials; everything they accept is checked above. */
export function registerOidc(app: FastifyInstance, oidc: Oidc, auth: Authenticator, opts: { secureCookies: boolean }): void {
  const secure = (request: FastifyRequest) => (opts.secureCookies || request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");
  // A plain page, not JSON: a person lands here in a browser when sign-in fails.
  const page = (reply: FastifyReply, status: number, message: string) =>
    reply.status(status).header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").send(
      `<!doctype html><meta charset="utf-8"><title>Sign-in did not complete</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.25rem">Sign-in did not complete</h1><p>${message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="/ui/">Back to sign-in</a></p></body>`);

  app.get("/v1/session/oidc/login", async (request, reply) => {
    const { location, cookie } = await oidc.begin();
    // Lax, not Strict: this cookie must come back on the redirect from the identity provider's site.
    reply.header("set-cookie", `${FLOW_COOKIE}=${cookie}; Path=/v1/session/oidc; HttpOnly; SameSite=Lax; Max-Age=${FLOW_SECONDS}${secure(request)}`);
    return reply.redirect(location);
  });

  app.get("/v1/session/oidc/callback", async (request, reply) => {
    const clear = `${FLOW_COOKIE}=; Path=/v1/session/oidc; HttpOnly; SameSite=Lax; Max-Age=0${secure(request)}`;
    try {
      const actor = await oidc.finish(request.query as Record<string, string>, cookieOf(request.headers.cookie, FLOW_COOKIE));
      const session = await auth.openSession(actor);
      reply.header("set-cookie", [clear, `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure(request)}`]);
      return reply.redirect("/ui/");
    } catch (err) {
      reply.header("set-cookie", clear);
      if (err instanceof ApiError) return page(reply, err.status, err.message);
      throw err;
    }
  });
}
