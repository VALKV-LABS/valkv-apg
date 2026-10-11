/**
 * Authentication and authorisation for the Admin API and data-plane API
 * (spec §13.2).
 *
 * Two ways in: an admin token (`Authorization: Bearer apg_at_…`, stored as a
 * SHA-256 hash), or a delegated JWT from an embedding platform (API-4), which
 * is always scoped to exactly one workspace.
 */

import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload, type JWTVerifyGetKey, type KeyLike } from "jose";
import type { JwtConfig } from "./config.js";
import { generateToken, safeEqual, sha256, uuidv7 } from "./crypto.js";
import type { Db, Sql } from "./db.js";
import { ApiError } from "./errors.js";

/** Roles, least to most privileged for resource work. `node` is separate: it may call `/dp/*` only. */
export type Role = "admin" | "editor" | "viewer" | "node";

/** Who is making a request. */
export interface Actor {
  kind: "token" | "jwt" | "oidc" | "system";
  id: string;
  name: string;
  role: Role;
  /** Workspace ids this actor may touch, or "*" for all. */
  workspaces: "*" | string[];
}

/** The actor used for changes the admin makes on its own (jobs, bootstrap). */
export const SYSTEM_ACTOR: Actor = { kind: "system", id: "system", name: "system", role: "admin", workspaces: "*" };

const TOKEN_PREFIX = "apg_at_";
/** Longest life of a browser session. */
export const SESSION_HOURS = 12;
/** Name of the session cookie. */
export const SESSION_COOKIE = "apg_session";
const JWT_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "EdDSA"];

// ── Decisions (pure; unit-tested without a database) ─────────────────────────

/** True when the actor's scope covers the workspace. */
export function inScope(actor: Actor, workspaceId: string): boolean {
  return actor.workspaces === "*" || actor.workspaces.includes(workspaceId);
}

/** May the actor read resources of this workspace? */
export function canRead(actor: Actor, workspaceId: string): boolean {
  return actor.role !== "node" && inScope(actor, workspaceId);
}

/** May the actor change resources of this workspace? */
export function canWrite(actor: Actor, workspaceId: string): boolean {
  return (actor.role === "admin" || actor.role === "editor") && inScope(actor, workspaceId);
}

/** May the actor use fleet-wide endpoints (tokens, flags, settings, nodes, workspaces)? */
export function isAdmin(actor: Actor): boolean {
  return actor.role === "admin" && actor.workspaces === "*";
}

/**
 * Throws the right error for a workspace the actor cannot use.
 * Out of scope is `NOT_FOUND`, so the existence of other tenants' resources
 * is never revealed (spec API-6). In scope but read-only is `FORBIDDEN`.
 */
export function requireWrite(actor: Actor, workspaceId: string): void {
  if (!canRead(actor, workspaceId)) throw new ApiError("NOT_FOUND", "workspace not found");
  if (!canWrite(actor, workspaceId)) throw new ApiError("FORBIDDEN", `role '${actor.role}' cannot change resources`);
}

/** As {@link requireWrite}, for reads. */
export function requireRead(actor: Actor, workspaceId: string): void {
  if (!canRead(actor, workspaceId)) throw new ApiError("NOT_FOUND", "workspace not found");
}

/** Throws unless the actor is a fleet-wide admin. */
export function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ApiError("FORBIDDEN", "this endpoint needs the admin role with access to all workspaces");
}

/** Throws unless the actor is a node (or an admin, for diagnosis). */
export function requireNode(actor: Actor): void {
  if (actor.role !== "node" && !isAdmin(actor)) throw new ApiError("FORBIDDEN", "this endpoint is for data-plane nodes");
}

// ── Tokens ───────────────────────────────────────────────────────────────────

/** A token as returned by the API. The secret itself is returned only at creation. */
export interface TokenRecord {
  id: string;
  name: string;
  role: Role;
  workspaces: string[];
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** Creates a token. `secret` may be supplied (bootstrap); otherwise it is generated. */
export async function createToken(
  db: Db,
  input: { name: string; role: Role; workspaces?: string[]; expires_at?: string | null; secret?: string },
): Promise<{ record: TokenRecord; secret: string }> {
  const secret = input.secret ?? generateToken(TOKEN_PREFIX);
  if (secret.length < 24) throw new ApiError("VALIDATION_FAILED", "a token must be at least 24 characters");
  const workspaces = input.workspaces && input.workspaces.length > 0 ? input.workspaces : ["*"];
  try {
    const [row] = await db<TokenRecord[]>`
      INSERT INTO apg_admin_tokens (id, name, token_hash, token_prefix, role, workspaces, expires_at)
      VALUES (${uuidv7()}, ${input.name}, ${sha256(secret)}, ${secret.slice(0, 12)}, ${input.role},
              ${workspaces}, ${input.expires_at ?? null})
      RETURNING id, name, role, workspaces, token_prefix, expires_at, last_used_at, created_at`;
    return { record: row!, secret };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new ApiError("CONFLICT", `a token named '${input.name}' already exists`);
    throw err;
  }
}

/**
 * Makes sure a first admin token and a first node token exist (spec API-3).
 * Returns any secret that was generated, so the caller can log it exactly once.
 */
export async function bootstrapTokens(
  sql: Sql,
  opts: { adminToken: string | null; nodeToken: string | null },
): Promise<{ generatedAdmin?: string; generatedNode?: string }> {
  const out: { generatedAdmin?: string; generatedNode?: string } = {};
  await sql.begin(async (tx) => {
    // Serialise replicas starting together.
    await tx`SELECT pg_advisory_xact_lock(4271002)`;
    for (const [role, name, supplied] of [
      ["admin", "bootstrap-admin", opts.adminToken],
      ["node", "bootstrap-node", opts.nodeToken],
    ] as const) {
      const [existing] = await tx`SELECT 1 FROM apg_admin_tokens WHERE role = ${role} LIMIT 1`;
      if (existing) continue;
      const { secret } = await createToken(tx, supplied ? { name, role, secret: supplied } : { name, role });
      if (!supplied) out[role === "admin" ? "generatedAdmin" : "generatedNode"] = secret;
    }
  });
  return out;
}

// ── Authentication ───────────────────────────────────────────────────────────

/** Turns an `Authorization` header into an {@link Actor}. */
export class Authenticator {
  private readonly jwtKey: JWTVerifyGetKey | Promise<KeyLike> | null;
  // last_used_at is advisory; writing it on every request would turn reads into writes.
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly sql: Sql,
    private readonly jwt: JwtConfig | null,
  ) {
    if (!jwt) this.jwtKey = null;
    else if (jwt.jwksUrl) this.jwtKey = createRemoteJWKSet(new URL(jwt.jwksUrl));
    else this.jwtKey = importSPKI(jwt.publicKeyPem!, guessAlgorithm(jwt.publicKeyPem!)) as Promise<KeyLike>;
  }

  /** Resolves the caller, or throws `UNAUTHENTICATED`. The message never says which check failed. */
  async authenticate(header: string | undefined): Promise<Actor> {
    const denied = new ApiError("UNAUTHENTICATED", "missing or invalid credentials");
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    if (!m) throw denied;
    const presented = m[1]!;

    // A JWT has exactly two dots; an admin token has none.
    if (this.jwt && presented.split(".").length === 3) {
      try {
        return await this.fromJwt(presented);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw denied;
      }
    }

    const [row] = await this.sql<Array<{ id: string; name: string; role: Role; workspaces: string[]; expires_at: Date | null }>>`
      SELECT id, name, role, workspaces, expires_at FROM apg_admin_tokens WHERE token_hash = ${sha256(presented)}`;
    if (!row) throw denied;
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) throw denied;

    const now = Date.now();
    if (now - (this.lastTouched.get(row.id) ?? 0) > 60_000) {
      this.lastTouched.set(row.id, now);
      void this.sql`UPDATE apg_admin_tokens SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {});
    }
    return {
      kind: "token",
      id: row.id,
      name: row.name,
      role: row.role,
      workspaces: row.workspaces.includes("*") ? "*" : row.workspaces,
    };
  }

  // ── Browser sessions (spec API-5) ──────────────────────────────────────────

  /**
   * Opens a session for an admin token. The cookie value is random and only
   * its hash is stored; the session lasts as long as the token does, at most
   * {@link SESSION_HOURS}.
   */
  async openSession(actor: Actor): Promise<{ id: string; csrf: string; expiresAt: Date }> {
    if (actor.kind === "oidc") {
      // Signed in through the identity provider: the session holds what was granted then.
      const id = generateToken("apg_s_");
      const csrf = generateToken("");
      const [row] = await this.sql<Array<{ expires_at: Date }>>`
        INSERT INTO apg_sessions (id_hash, actor, csrf, expires_at)
        VALUES (${sha256(id)}, ${this.sql.json(actor as never)}, ${csrf}, now() + make_interval(hours => ${SESSION_HOURS}))
        RETURNING expires_at`;
      return { id, csrf, expiresAt: row!.expires_at };
    }
    if (actor.kind !== "token") {
      throw new ApiError("BAD_REQUEST", "sessions are opened with an admin token; send a delegated token as a bearer on each request");
    }
    const id = generateToken("apg_s_");
    const csrf = generateToken("");
    const [row] = await this.sql<Array<{ expires_at: Date }>>`
      INSERT INTO apg_sessions (id_hash, token_id, csrf, expires_at)
      SELECT ${sha256(id)}, t.id, ${csrf}, LEAST(now() + make_interval(hours => ${SESSION_HOURS}), COALESCE(t.expires_at, 'infinity'))
      FROM apg_admin_tokens t WHERE t.id = ${actor.id}
      RETURNING expires_at`;
    if (!row) throw new ApiError("UNAUTHENTICATED", "missing or invalid credentials");
    return { id, csrf, expiresAt: row.expires_at };
  }

  /** Resolves a session cookie. A request that changes something must carry the session's CSRF token. */
  async fromSession(cookie: string, method: string, csrfHeader: string | undefined): Promise<{ actor: Actor; csrf: string; expiresAt: Date }> {
    const denied = new ApiError("UNAUTHENTICATED", "missing or invalid credentials");
    const [row] = await this.sql<Array<{ id: string; name: string; role: Role; workspaces: string[]; csrf: string; expires_at: Date; actor: Actor | null }>>`
      SELECT t.id, t.name, t.role, t.workspaces, s.csrf, s.expires_at, s.actor
      FROM apg_sessions s LEFT JOIN apg_admin_tokens t ON t.id = s.token_id
      WHERE s.id_hash = ${sha256(cookie)} AND s.expires_at > now()
        AND (s.token_id IS NULL OR t.expires_at IS NULL OR t.expires_at > now())`;
    if (!row) throw denied;
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !(typeof csrfHeader === "string" && safeEqual(csrfHeader, row.csrf))) {
      throw new ApiError("FORBIDDEN", "the X-Apg-Csrf header is missing or does not match this session");
    }
    return {
      actor: row.actor ?? { kind: "token", id: row.id, name: row.name, role: row.role, workspaces: row.workspaces.includes("*") ? "*" : row.workspaces },
      csrf: row.csrf,
      expiresAt: row.expires_at,
    };
  }

  async closeSession(cookie: string): Promise<void> {
    await this.sql`DELETE FROM apg_sessions WHERE id_hash = ${sha256(cookie)}`;
  }

  private async fromJwt(token: string): Promise<Actor> {

    const jwt = this.jwt!;
    const options = {
      algorithms: JWT_ALGORITHMS,
      ...(jwt.issuer ? { issuer: jwt.issuer } : {}),
      ...(jwt.audience ? { audience: jwt.audience } : {}),
      clockTolerance: 60,
    };
    const key = this.jwtKey!;
    const { payload } = typeof key === "function" ? await jwtVerify(token, key, options) : await jwtVerify(token, await key, options);

    const workspace = claim(payload, jwt.workspaceClaim);
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new ApiError("UNAUTHENTICATED", "missing or invalid credentials");
    }
    // A delegated token can never be a node and never spans workspaces.
    const roleValue = jwt.roleClaim ? claim(payload, jwt.roleClaim) : undefined;
    const role: Role = roleValue === "admin" || roleValue === "viewer" ? roleValue : "editor";
    return {
      kind: "jwt",
      id: typeof payload.sub === "string" ? payload.sub : "jwt",
      name: typeof payload.sub === "string" ? payload.sub : "jwt",
      role,
      workspaces: [workspace],
    };
  }
}

function claim(payload: JWTPayload, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function guessAlgorithm(pem: string): string {
  // importSPKI needs an algorithm hint; the verified token's own `alg` must
  // still be in JWT_ALGORITHMS and match the key type.
  return pem.includes("BEGIN PUBLIC KEY") && pem.length < 300 ? "ES256" : "RS256";
}

// ── Rate limiting (spec API-7) ───────────────────────────────────────────────

/** A token bucket per caller. In memory: each admin replica limits independently. */
export class CallerRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond = 50,
    private readonly burst = 100,
    private readonly maxCallers = 10_000,
  ) {}

  /** Takes one token for `caller`. False means the caller is over its limit. */
  take(caller: string, now = Date.now()): boolean {
    let b = this.buckets.get(caller);
    if (!b) {
      // Bound memory: when full, drop the least recently created entry.
      if (this.buckets.size >= this.maxCallers) this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: this.burst, at: now };
      this.buckets.set(caller, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
