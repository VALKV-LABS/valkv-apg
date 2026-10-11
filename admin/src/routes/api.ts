/**
 * The Admin API, `/v1/*` (spec §13.1 to §13.3, §13.5).
 *
 * Route handlers are thin: they parse the request and call the store, which
 * owns validation, authorisation against the workspace, the transaction, the
 * changelog event and the audit row.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { createToken, requireAdmin, requireRead, requireWrite } from "../auth.js";
import { ApiError } from "../errors.js";
import { bodyOf, ctxOf, pageOf, sendResource, writeOptions } from "../http.js";
import { KINDS, type KindName, verifyDomain } from "../kinds.js";
import type { SchemaRegistry } from "../schemas.js";
import { type Json, type Row, type Store, isUuid, workspaceApi } from "../store.js";
import { PLUGIN_TYPES } from "../plugin-types.js";

/** Endpoint descriptions, collected as routes are registered; the OpenAPI document is built from them. */
export interface EndpointDoc {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  tag: string;
  /** Schema path (relative to schemas/) of the request body, if any. */
  body?: string;
  /** Schema path of the 2xx response body, if it is one resource. */
  response?: string;
  list?: boolean;
  success: number;
  roles: string;
}

export const ENDPOINTS: EndpointDoc[] = [];

type P = Record<string, string>;

export function registerApi(app: FastifyInstance, store: Store, schemas: SchemaRegistry): void {
  const sql = store.deps.sql;
  const doc = (d: EndpointDoc) => {
    if (!ENDPOINTS.some((e) => e.method === d.method && e.path === d.path)) ENDPOINTS.push(d);
  };

  // POST with an Idempotency-Key replays the stored response instead of acting twice (spec §13.1).
  async function idempotent(request: FastifyRequest, run: () => Promise<{ status: number; body: Json }>): Promise<{ status: number; body: Json }> {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) return run();
    if (key.length > 200) throw new ApiError("BAD_REQUEST", "Idempotency-Key is too long");
    const actorId = ctxOf(request).actor.id;
    const path = request.url.split("?")[0]!;
    const [seen] = await sql<Row[]>`SELECT method, path, status, body FROM apg_idempotency_keys WHERE actor_id = ${actorId} AND key = ${key}`;
    if (seen) {
      if (seen["method"] !== request.method || seen["path"] !== path) throw new ApiError("CONFLICT", "this Idempotency-Key was used for a different request");
      return { status: seen["status"], body: seen["body"] };
    }
    const result = await run();
    await sql`
      INSERT INTO apg_idempotency_keys (actor_id, key, method, path, status, body)
      VALUES (${actorId}, ${key}, ${request.method}, ${path}, ${result.status}, ${sql.json(result.body)})
      ON CONFLICT DO NOTHING`;
    return result;
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────

  const WS = "resources/workspace.json";
  doc({ method: "get", path: "/v1/workspaces", summary: "List workspaces in the caller's scope", tag: "workspaces", response: WS, list: true, success: 200, roles: "any" });
  app.get("/v1/workspaces", async (request) => store.listWorkspaces(ctxOf(request), pageOf(request)));

  doc({ method: "post", path: "/v1/workspaces", summary: "Create a workspace", tag: "workspaces", body: WS, response: WS, success: 201, roles: "admin" });
  app.post("/v1/workspaces", async (request, reply) => {
    const r = await idempotent(request, async () => ({ status: 201, body: await store.createWorkspace(ctxOf(request), bodyOf(request), writeOptions(request)) }));
    return sendResource(reply, r.body, r.status);
  });

  doc({ method: "get", path: "/v1/workspaces/{ws}", summary: "Get a workspace", tag: "workspaces", response: WS, success: 200, roles: "any" });
  app.get("/v1/workspaces/:ws", async (request, reply) => {
    return sendResource(reply, workspaceApi(await store.workspace(sql, (request.params as P)["ws"]!, ctxOf(request).actor)));
  });

  for (const method of ["put", "patch"] as const) {
    doc({ method, path: "/v1/workspaces/{ws}", summary: method === "put" ? "Replace a workspace" : "Patch a workspace", tag: "workspaces", body: WS, response: WS, success: 200, roles: "admin" });
    app[method]("/v1/workspaces/:ws", async (request, reply) =>
      sendResource(reply, await store.updateWorkspace(ctxOf(request), (request.params as P)["ws"]!, bodyOf(request), { ...writeOptions(request), merge: method === "patch" })));
  }

  doc({ method: "delete", path: "/v1/workspaces/{ws}", summary: "Delete a workspace", tag: "workspaces", success: 204, roles: "admin" });
  app.delete("/v1/workspaces/:ws", async (request, reply) => {
    await store.deleteWorkspace(ctxOf(request), (request.params as P)["ws"]!, writeOptions(request));
    return reply.status(204).send();
  });

  // ── Workspace-scoped kinds ─────────────────────────────────────────────────

  for (const def of Object.values(KINDS)) {
    const kind = def.kind as KindName;
    const parentDef = def.parent ? KINDS[def.parent.kind] : undefined;
    const base = parentDef
      ? `/v1/workspaces/:ws/${parentDef.segment}/:parent/${def.segment}`
      : `/v1/workspaces/:ws/${def.segment}`;
    const docBase = base.replace(/:(\w+)/g, "{$1}");
    const parentOf = (request: FastifyRequest) => (request.params as P)["parent"];
    const ws = (request: FastifyRequest) => (request.params as P)["ws"]!;
    const ref = (request: FastifyRequest) => (request.params as P)["ref"]!;

    doc({ method: "get", path: docBase, summary: `List ${def.segment}`, tag: def.segment, response: def.schema, list: true, success: 200, roles: "viewer" });
    app.get(base, async (request) => store.list(ctxOf(request), kind, ws(request), pageOf(request), parentOf(request)));

    doc({ method: "post", path: docBase, summary: `Create a ${def.kind}`, tag: def.segment, body: def.schema, response: def.schema, success: 201, roles: "editor" });
    app.post(base, async (request, reply) => {
      const r = await idempotent(request, async () => ({
        status: 201,
        body: await store.create(ctxOf(request), kind, ws(request), bodyOf(request), writeOptions(request), parentOf(request)),
      }));
      return sendResource(reply, r.body, r.status);
    });

    doc({ method: "get", path: `${docBase}/{ref}`, summary: `Get a ${def.kind} by id or name`, tag: def.segment, response: def.schema, success: 200, roles: "viewer" });
    app.get(`${base}/:ref`, async (request, reply) => sendResource(reply, await store.get(ctxOf(request), kind, ws(request), ref(request), parentOf(request))));

    doc({ method: "put", path: `${docBase}/{ref}`, summary: `Create or replace a ${def.kind} (idempotent by name)`, tag: def.segment, body: def.schema, response: def.schema, success: 200, roles: "editor" });
    app.put(`${base}/:ref`, async (request, reply) =>
      sendResource(reply, await store.put(ctxOf(request), kind, ws(request), ref(request), bodyOf(request), writeOptions(request), parentOf(request))));

    doc({ method: "patch", path: `${docBase}/{ref}`, summary: `Patch a ${def.kind} (JSON merge patch)`, tag: def.segment, body: def.schema, response: def.schema, success: 200, roles: "editor" });
    app.patch(`${base}/:ref`, async (request, reply) =>
      sendResource(reply, await store.patch(ctxOf(request), kind, ws(request), ref(request), bodyOf(request), writeOptions(request), parentOf(request))));

    doc({ method: "delete", path: `${docBase}/{ref}`, summary: `Delete a ${def.kind}`, tag: def.segment, success: 204, roles: "editor" });
    app.delete(`${base}/:ref`, async (request, reply) => {
      await store.remove(ctxOf(request), kind, ws(request), ref(request), writeOptions(request), parentOf(request));
      return reply.status(204).send();
    });
  }

  // ── Kind-specific actions ──────────────────────────────────────────────────

  doc({ method: "post", path: "/v1/workspaces/{ws}/domains/{ref}/verify", summary: "Check a pending domain's DNS record and activate it", tag: "domains", response: "resources/domain.json", success: 200, roles: "editor" });
  app.post("/v1/workspaces/:ws/domains/:ref/verify", async (request, reply) => {
    const p = request.params as P;
    return sendResource(reply, await verifyDomain(store, ctxOf(request), p["ws"]!, p["ref"]!));
  });

  // Backends are part of the service document; these endpoints edit that
  // document under its revision, so a concurrent change is a 412, never a lost update.
  async function editBackends(request: FastifyRequest, edit: (backends: Json[]) => Json[]): Promise<Json> {
    const p = request.params as P;
    const ctx = ctxOf(request);
    const current = await store.get(ctx, "service", p["ws"]!, p["ref"]!);
    const backends = edit(structuredClone(current["backends"]) as Json[]);
    return store.patch(ctx, "service", p["ws"]!, current["id"], { backends }, { ...writeOptions(request), ifMatch: current["revision"] });
  }
  const findBackend = (backends: Json[], bid: string): Json => {
    const b = backends.find((x) => x["id"] === bid || x["target"] === bid);
    if (!b) throw new ApiError("NOT_FOUND", `backend '${bid}' not found`);
    return b;
  };

  doc({ method: "post", path: "/v1/workspaces/{ws}/services/{ref}/backends", summary: "Add a backend", tag: "services", response: "resources/service.json", success: 200, roles: "editor" });
  app.post("/v1/workspaces/:ws/services/:ref/backends", async (request, reply) =>
    sendResource(reply, await editBackends(request, (backends) => [...backends, bodyOf(request)])));

  doc({ method: "patch", path: "/v1/workspaces/{ws}/services/{ref}/backends/{backend}", summary: "Change a backend's weight, status or labels", tag: "services", response: "resources/service.json", success: 200, roles: "editor" });
  app.patch("/v1/workspaces/:ws/services/:ref/backends/:backend", async (request, reply) =>
    sendResource(reply, await editBackends(request, (backends) => {
      const b = findBackend(backends, (request.params as P)["backend"]!);
      const patch = bodyOf(request);
      for (const key of Object.keys(patch)) {
        if (!["weight", "status", "labels"].includes(key)) throw new ApiError("VALIDATION_FAILED", `'${key}' cannot be changed on a backend`, [{ pointer: `/${key}`, message: "only weight, status and labels can be changed" }]);
      }
      Object.assign(b, patch);
      return backends;
    })));

  doc({ method: "delete", path: "/v1/workspaces/{ws}/services/{ref}/backends/{backend}", summary: "Remove a backend", tag: "services", response: "resources/service.json", success: 200, roles: "editor" });
  app.delete("/v1/workspaces/:ws/services/:ref/backends/:backend", async (request, reply) =>
    sendResource(reply, await editBackends(request, (backends) => {
      const b = findBackend(backends, (request.params as P)["backend"]!);
      return backends.filter((x) => x !== b);
    })));

  doc({ method: "post", path: "/v1/workspaces/{ws}/routes/{ref}/cache/purge", summary: "Invalidate cached responses of a route on every node", tag: "routes", response: "resources/route.json", success: 200, roles: "editor" });
  app.post("/v1/workspaces/:ws/routes/:ref/cache/purge", async (request, reply) => {
    const p = request.params as P;
    const ctx = ctxOf(request);
    const out = await sql.begin(async (tx) => {
      const ws = await store.workspace(tx, p["ws"]!, ctx.actor);
      requireWrite(ctx.actor, ws["id"]);
      const row = await store.find(tx, KINDS.route, ws, p["ref"]!, undefined, true);
      const [updated] = await tx<Row[]>`
        UPDATE apg_routes SET cache_epoch = cache_epoch + 1, revision = revision + 1, updated_at = now() WHERE id = ${row["id"]} RETURNING *`;
      await store.emit(tx, { kind: "route", op: "upsert", id: row["id"], workspace_id: ws["id"], revision: updated!["revision"], data: KINDS.route.toEvent(updated!) });
      await store.audit(tx, ctx, { action: "cache_purge", kind: "route", resource_id: row["id"], resource_name: row["name"], workspace_id: ws["id"] });
      return KINDS.route.toApi(updated!);
    });
    return sendResource(reply, out as Json);
  });

  // Which plugin instance applies to a route for each type, and why (spec PL-1).
  doc({ method: "get", path: "/v1/workspaces/{ws}/routes/{ref}/effective-plugins", summary: "Show which plugin instance wins per type on a route", tag: "plugins", success: 200, roles: "viewer" });
  app.get("/v1/workspaces/:ws/routes/:ref/effective-plugins", async (request) => {
    const p = request.params as P;
    const ctx = ctxOf(request);
    const ws = await store.workspace(sql, p["ws"]!, ctx.actor);
    const route = await store.find(sql, KINDS.route, ws, p["ref"]!);
    const spec = route["spec"] as Json;
    const serviceIds: string[] = spec["service"] ? [spec["service"]] : (spec["split"] as Json[]).map((s) => s["service"]);
    const rows = await sql<Row[]>`
      SELECT p.*, w.system AS ws_system FROM apg_plugins p JOIN apg_workspaces w ON w.id = p.workspace_id
      WHERE p.route_id = ${route["id"]}
         OR p.service_id = ANY(${serviceIds}::uuid[])
         OR (p.scope = 'workspace' AND p.workspace_id = ${ws["id"]})
         OR (p.scope = 'global' AND w.system)`;
    // Most specific first. Qualified instances apply only to their consumer or workspace.
    const rank = (r: Row) =>
      (r["scope"] === "route" ? 0 : r["scope"] === "service" ? 10 : r["scope"] === "workspace" ? 20 : 30) +
      (r["consumer_id"] ? 0 : r["target_workspace"] ? 1 : 2);
    const byType = new Map<string, Row[]>();
    for (const r of rows.sort((a, b) => rank(a) - rank(b))) byType.set(r["type"], [...(byType.get(r["type"]) ?? []), r]);
    const order = (t: string) => PLUGIN_TYPES.find((x) => x.name === t)?.default_priority ?? 0;
    return {
      data: [...byType.entries()]
        .sort((a, b) => order(b[0]) - order(a[0]))
        .map(([type, candidates]) => {
          const unconditional = candidates.find((c) => !c["consumer_id"] && !c["target_workspace"]);
          return {
            type,
            default_priority: order(type),
            applies: unconditional ? { ...summary(unconditional), runs: unconditional["enabled"] } : null,
            conditional: candidates.filter((c) => c["consumer_id"] || c["target_workspace"]).map((c) => ({
              ...summary(c),
              runs: c["enabled"],
              when: c["consumer_id"] ? { consumer: c["consumer_id"] } : { workspace: c["target_workspace"] },
            })),
            shadowed: candidates.filter((c) => c !== unconditional && !c["consumer_id"] && !c["target_workspace"]).map(summary),
          };
        }),
    };
  });
  const summary = (r: Row): Json => ({ id: r["id"], name: r["name"], scope: r["scope"], enabled: r["enabled"] });

  // ── Fleet-wide: flags, settings, tokens, nodes, audit ──────────────────────

  doc({ method: "get", path: "/v1/flags", summary: "List flags", tag: "flags", success: 200, roles: "admin" });
  app.get("/v1/flags", async (request) => ({ data: await store.listFlags(ctxOf(request)) }));
  doc({ method: "put", path: "/v1/flags/{name}", summary: "Set a flag", tag: "flags", success: 200, roles: "admin" });
  app.put("/v1/flags/:name", async (request) => store.putFlag(ctxOf(request), (request.params as P)["name"]!, bodyOf(request), writeOptions(request)));

  doc({ method: "get", path: "/v1/settings", summary: "List settings", tag: "settings", success: 200, roles: "admin" });
  app.get("/v1/settings", async (request) => ({ data: await store.listSettings(ctxOf(request)) }));
  doc({ method: "put", path: "/v1/settings/{name}", summary: "Set a setting", tag: "settings", success: 200, roles: "admin" });
  app.put("/v1/settings/:name", async (request) => store.putSetting(ctxOf(request), (request.params as P)["name"]!, bodyOf(request), writeOptions(request)));

  doc({ method: "get", path: "/v1/tokens", summary: "List admin tokens", tag: "tokens", list: true, success: 200, roles: "admin" });
  app.get("/v1/tokens", async (request) => {
    requireAdmin(ctxOf(request).actor);
    return { data: await sql`SELECT id, name, role, workspaces, token_prefix, expires_at, last_used_at, created_at FROM apg_admin_tokens ORDER BY created_at` };
  });

  doc({ method: "post", path: "/v1/tokens", summary: "Create an admin token; the secret is returned once", tag: "tokens", success: 201, roles: "admin" });
  app.post("/v1/tokens", async (request, reply) => {
    const ctx = ctxOf(request);
    requireAdmin(ctx.actor);
    const b = bodyOf(request);
    const faults: Array<{ pointer: string; message: string }> = [];
    if (typeof b["name"] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(b["name"])) faults.push({ pointer: "/name", message: "must be a resource name" });
    if (!["admin", "editor", "viewer", "node"].includes(b["role"])) faults.push({ pointer: "/role", message: "must be admin, editor, viewer or node" });
    const workspaces: unknown = b["workspaces"] ?? ["*"];
    if (!Array.isArray(workspaces) || workspaces.length === 0 || !workspaces.every((w) => w === "*" || (typeof w === "string" && isUuid(w)))) {
      faults.push({ pointer: "/workspaces", message: "must be [\"*\"] or a list of workspace ids" });
    }
    if (b["expires_at"] !== undefined && Number.isNaN(Date.parse(b["expires_at"]))) faults.push({ pointer: "/expires_at", message: "must be a date-time" });
    if (faults.length > 0) throw new ApiError("VALIDATION_FAILED", "invalid token request", faults);
    const out = await sql.begin(async (tx) => {
      const { record, secret } = await createToken(tx, { name: b["name"], role: b["role"], workspaces: workspaces as string[], expires_at: b["expires_at"] ?? null });
      await store.audit(tx, ctx, { action: "create", kind: "token", resource_id: record.id, resource_name: record.name, after: record as unknown as Json });
      return { ...record, token: secret };
    });
    return reply.status(201).send(out);
  });

  doc({ method: "delete", path: "/v1/tokens/{ref}", summary: "Revoke an admin token", tag: "tokens", success: 204, roles: "admin" });
  app.delete("/v1/tokens/:ref", async (request, reply) => {
    const ctx = ctxOf(request);
    requireAdmin(ctx.actor);
    const ref = (request.params as P)["ref"]!;
    await sql.begin(async (tx) => {
      const [row] = await tx<Row[]>`DELETE FROM apg_admin_tokens WHERE ${isUuid(ref) ? tx`id = ${ref}` : tx`name = ${ref}`} RETURNING id, name, role`;
      if (!row) throw new ApiError("NOT_FOUND", "token not found");
      // Refuse to lock everyone out.
      const [left] = await tx`SELECT 1 FROM apg_admin_tokens WHERE role = 'admin' AND workspaces @> ARRAY['*'] LIMIT 1`;
      if (!left) throw new ApiError("CONFLICT", "this is the last fleet-wide admin token; create another before revoking it");
      await store.audit(tx, ctx, { action: "delete", kind: "token", resource_id: row["id"], resource_name: row["name"], before: row });
    });
    return reply.status(204).send();
  });

  doc({ method: "get", path: "/v1/nodes", summary: "List data-plane nodes with their config lag", tag: "nodes", success: 200, roles: "admin" });
  app.get("/v1/nodes", async (request) => {
    requireAdmin(ctxOf(request).actor);
    const [meta] = await sql<{ value: string }[]>`SELECT value FROM apg_meta WHERE key = 'last_seq'`;
    const last = Number(meta?.value ?? 0);
    const rows = await sql<Row[]>`SELECT *, (last_seen > now() - interval '30 seconds') AS live FROM apg_nodes ORDER BY node_id`;
    return { data: rows.map((r) => ({ ...r, lag: Math.max(0, last - r["applied_seq"]) })), last_seq: last };
  });

  doc({ method: "get", path: "/v1/audit", summary: "Search the audit log", tag: "audit", list: true, success: 200, roles: "viewer" });
  app.get("/v1/audit", async (request) => {
    const ctx = ctxOf(request);
    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(500, Math.max(1, Number(q["limit"] ?? 50) || 50));
    const before = q["cursor"] !== undefined ? Number(q["cursor"]) : null;
    if (before !== null && !Number.isInteger(before)) throw new ApiError("BAD_REQUEST", "cursor is not valid");
    for (const key of ["from", "to"] as const) {
      if (q[key] !== undefined && Number.isNaN(Date.parse(q[key]!))) throw new ApiError("BAD_REQUEST", `${key} must be a date-time`);
    }
    // A scoped caller must name a workspace it can read; only a fleet admin may search across all.
    let workspaceId: string | null = null;
    if (q["workspace"] !== undefined) {
      const ws = await store.workspace(sql, q["workspace"], ctx.actor);
      requireRead(ctx.actor, ws["id"]);
      workspaceId = ws["id"];
    } else {
      requireAdmin(ctx.actor);
    }
    const rows = await sql<Row[]>`
      SELECT * FROM apg_audit_log
      WHERE true
        ${workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``}
        ${q["actor"] ? sql`AND (actor_id = ${q["actor"]} OR actor_name = ${q["actor"]})` : sql``}
        ${q["kind"] ? sql`AND kind = ${q["kind"]}` : sql``}
        ${q["from"] ? sql`AND ts >= ${q["from"]}` : sql``}
        ${q["to"] ? sql`AND ts < ${q["to"]}` : sql``}
        ${before !== null ? sql`AND id < ${before}` : sql``}
      ORDER BY id DESC LIMIT ${limit + 1}`;
    const data = rows.slice(0, limit);
    return { data, next_cursor: rows.length > limit ? String(data[data.length - 1]!["id"]) : null };
  });

  // ── Discovery ──────────────────────────────────────────────────────────────

  doc({ method: "get", path: "/v1/schemas/plugins", summary: "Plugin types: schema, phases, default priority", tag: "schemas", success: 200, roles: "any" });
  app.get("/v1/schemas/plugins", async () => ({
    data: PLUGIN_TYPES.map((t) => ({
      ...t,
      available: schemas.has(`plugins/${t.name}.json`),
      schema: schemas.has(`plugins/${t.name}.json`) ? schemas.validator(`plugins/${t.name}.json`).schema : null,
    })),
  }));

  doc({ method: "get", path: "/v1/schemas/resources", summary: "JSON Schemas of every resource", tag: "schemas", success: 200, roles: "any" });
  app.get("/v1/schemas/resources", async () => ({
    data: schemas.list().filter((p) => p.startsWith("resources/") || p === "common.json" || p === "apg-config.json")
      .map((p) => ({ path: p, schema: schemas.validator(p).schema })),
  }));
}
