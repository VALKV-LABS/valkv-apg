/**
 * Declarative configuration (`/v1/config/*`, spec §14), browser sessions
 * (`/v1/session`, spec API-5) and the route tester (`/v1/debug/match`, spec RT-6).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Authenticator, SESSION_COOKIE, SESSION_HOURS, isAdmin } from "../auth.js";
import { Declarative } from "../declarative.js";
import { ApiError } from "../errors.js";
import { bodyOf, ctxOf } from "../http.js";
import type { Json, Store } from "../store.js";
import { ENDPOINTS, type EndpointDoc } from "./api.js";

type Q = Record<string, string | string[] | undefined>;

function labelOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.indexOf("=") < 1) throw new ApiError("BAD_REQUEST", "select_label must be key=value");
  const i = value.indexOf("=");
  return { [value.slice(0, i)]: value.slice(i + 1) };
}

export function registerConfig(app: FastifyInstance, store: Store, auth: Authenticator, opts: { debugNodeUrl: string | null; secureCookies: boolean }): void {
  const declarative = new Declarative(store);
  const doc = (d: EndpointDoc) => {
    if (!ENDPOINTS.some((e) => e.method === d.method && e.path === d.path)) ENDPOINTS.push(d);
  };
  const one = (q: Q, key: string): string | undefined => (Array.isArray(q[key]) ? (q[key] as string[])[0] : (q[key] as string | undefined));

  // ── Documents ──────────────────────────────────────────────────────────────

  const actions = {
    validate: { summary: "Check a document without changing anything", prune: false, dryRun: true },
    diff: { summary: "Show what applying a document would change (add ?prune=true for what sync would also delete)", prune: false, dryRun: true },
    apply: { summary: "Create and update what a document describes, atomically; never deletes", prune: false, dryRun: false },
    sync: { summary: "As apply, and delete what the document omits", prune: true, dryRun: false },
  } as const;

  for (const [name, action] of Object.entries(actions)) {
    doc({ method: "post", path: `/v1/config/${name}`, summary: action.summary, tag: "config", success: 200, roles: "editor" });
    app.post(`/v1/config/${name}`, async (request) => {
      const body = bodyOf(request);
      const q = request.query as Q;
      if (body["document"] === undefined) throw new ApiError("BAD_REQUEST", "the body must be { \"document\": { … } }");
      if (body["message"] !== undefined && (typeof body["message"] !== "string" || body["message"].length > 1000)) throw new ApiError("BAD_REQUEST", "message must be a string of at most 1000 characters");
      const result = await declarative.apply(ctxOf(request), body["document"], {
        prune: action.prune || (name === "diff" && one(q, "prune") === "true"),
        selectLabel: labelOf(body["select_label"] ?? one(q, "select_label")),
        dryRun: action.dryRun || one(q, "dry_run") === "true",
        message: body["message"],
        workspace: one(q, "workspace"),
      });
      return name === "validate" ? { valid: true, summary: result.summary } : result;
    });
  }

  doc({ method: "get", path: "/v1/config/dump", summary: "Export a workspace as a document that sync accepts unchanged; secrets are placeholders", tag: "config", success: 200, roles: "viewer" });
  app.get("/v1/config/dump", async (request) => {
    const ctx = ctxOf(request);
    const ws = await store.workspace(store.deps.sql, one(request.query as Q, "workspace") ?? "default", ctx.actor);
    return declarative.dump(store.deps.sql, ws);
  });

  doc({ method: "get", path: "/v1/config/revisions", summary: "Revisions of a workspace, newest first, and whether it has drifted from the newest", tag: "config", success: 200, roles: "viewer" });
  app.get("/v1/config/revisions", async (request) => {
    const q = request.query as Q;
    const limit = Math.min(500, Math.max(1, Number(one(q, "limit") ?? 50) || 50));
    return declarative.revisions(ctxOf(request), one(q, "workspace") ?? "default", limit);
  });

  doc({ method: "get", path: "/v1/config/revisions/{id}", summary: "One revision with its document; secrets are placeholders", tag: "config", success: 200, roles: "viewer" });
  app.get("/v1/config/revisions/:id", async (request) => {
    const { row } = await declarative.revision(ctxOf(request), (request.params as Record<string, string>)["id"]!);
    return declarative.revisionApi(row, true);
  });

  doc({ method: "post", path: "/v1/config/revisions/{id}/rollback", summary: "Apply a stored revision again, as a new revision", tag: "config", success: 200, roles: "editor" });
  app.post("/v1/config/revisions/:id/rollback", async (request) => {
    const body = (request.body ?? {}) as Json;
    return declarative.rollback(ctxOf(request), (request.params as Record<string, string>)["id"]!, {
      dryRun: one(request.query as Q, "dry_run") === "true",
      message: typeof body["message"] === "string" ? body["message"] : undefined,
    });
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  const cookie = (request: FastifyRequest, value: string, maxAge: number): string => {
    const secure = opts.secureCookies || request.headers["x-forwarded-proto"] === "https";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  };
  const who = (request: FastifyRequest): Json => {
    const { actor } = ctxOf(request);
    return { kind: actor.kind, id: actor.id, name: actor.name, role: actor.role, workspaces: actor.workspaces, fleet_admin: isAdmin(actor) };
  };

  doc({ method: "post", path: "/v1/session", summary: "Exchange an admin token for a browser session cookie and a CSRF token", tag: "session", success: 201, roles: "any" });
  app.post("/v1/session", async (request, reply: FastifyReply) => {
    const session = await auth.openSession(ctxOf(request).actor);
    reply.header("set-cookie", cookie(request, session.id, SESSION_HOURS * 3600));
    return reply.status(201).send({ actor: who(request), csrf_token: session.csrf, expires_at: session.expiresAt });
  });

  doc({ method: "get", path: "/v1/session", summary: "Who the caller is; with a session cookie, also its CSRF token", tag: "session", success: 200, roles: "any" });
  app.get("/v1/session", async (request) => ({
    actor: who(request),
    ...(request.session ? { csrf_token: request.session.csrf, expires_at: request.session.expiresAt } : {}),
  }));

  doc({ method: "delete", path: "/v1/session", summary: "End the browser session", tag: "session", success: 204, roles: "any" });
  app.delete("/v1/session", async (request, reply: FastifyReply) => {
    ctxOf(request);
    if (request.session) await auth.closeSession(request.session.cookie);
    reply.header("set-cookie", cookie(request, "", 0));
    return reply.status(204).send();
  });

  // ── Route tester ───────────────────────────────────────────────────────────

  doc({ method: "get", path: "/v1/debug/match", summary: "Which route a request would hit on a node, and why not the others", tag: "debug", success: 200, roles: "viewer" });
  app.get("/v1/debug/match", async (request) => {
    const { actor } = ctxOf(request);
    const q = request.query as Q;
    if (!one(q, "host") || !one(q, "path")) throw new ApiError("BAD_REQUEST", "host and path are required");
    if (!opts.debugNodeUrl) {
      throw new ApiError("UNAVAILABLE", "the route tester is not configured: set APG_DEBUG_NODE_URL to the management address of a node");
    }
    const params = new URLSearchParams();
    for (const key of ["host", "path", "method", "query"]) if (one(q, key) !== undefined) params.set(key, one(q, key)!);
    for (const h of [q["header"]].flat()) if (typeof h === "string") params.append("header", h);

    let answer: Json;
    try {
      const res = await fetch(`${opts.debugNodeUrl}/debug/match?${params.toString()}`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 400) throw new ApiError("BAD_REQUEST", ((await res.json()) as Json)["error"] ?? "the node refused the request");
      if (!res.ok) throw new Error(`status ${res.status}`);
      answer = (await res.json()) as Json;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("UNAVAILABLE", "the node at APG_DEBUG_NODE_URL did not answer the route tester");
    }

    // A scoped caller learns nothing about other workspaces' routes (spec API-6).
    const visible = (workspaceId: unknown) => actor.workspaces === "*" || (typeof workspaceId === "string" && actor.workspaces.includes(workspaceId));
    const hiddenWinner = answer["selected"] && !visible(answer["selected"]["workspace_id"]);
    const redact = (c: Json | null): Json | null =>
      c === null ? c
      : visible(c["workspace_id"]) ? (hiddenWinner && c["matches"] && !c["selected"] ? { ...c, reason: "matches, but a route of another workspace is ahead of it in match order" } : c)
      : { ...c, route_id: null, route: "(a route of another workspace)", workspace_id: null, path: "", reason: c["selected"] ? "" : "not shown" };
    return {
      ...answer,
      host_owner: visible(answer["host_owner"]) ? answer["host_owner"] : null,
      selected: redact(answer["selected"] ?? null),
      candidates: ((answer["candidates"] ?? []) as Json[]).map((c) => redact(c)),
    };
  });
}
