/**
 * The resource store: every write to a resource table goes through here.
 *
 * One transaction per change writes the resource row, the changelog event
 * that tells nodes about it, and the audit row (spec CFG-1, API-9). There is
 * no code path that writes one without the others.
 */

import type { BlockList } from "node:net";
import { type Actor, isAdmin, requireAdmin, requireRead, requireWrite } from "./auth.js";
import { SecretBox, uuidv7 } from "./crypto.js";
import type { Db, Sql, Tx } from "./db.js";
import type { Resolver } from "./egress.js";
import { ApiError, type ErrorDetail } from "./errors.js";
import { KINDS, type KindDef, type KindName } from "./kinds.js";
import type { SchemaRegistry } from "./schemas.js";
import { templateFault } from "./template.js";
import { loadUnbuilt, unbuiltFaults } from "./unbuilt.js";

const UNBUILT_SETTINGS = loadUnbuilt().settings;

/** A database row, loosely typed: each kind's definition knows its columns. */
export type Row = Record<string, any>;
/** A JSON object. */
export type Json = Record<string, any>;

/** Per-request context. */
export interface Ctx {
  actor: Actor;
  requestId?: string | undefined;
  sourceIp?: string | undefined;
}

/** What the store and the kind definitions need from the process. */
export interface StoreDeps {
  sql: Sql;
  schemas: SchemaRegistry;
  box: SecretBox;
  domainVerification: "none" | "dns_txt";
  egressAllow: BlockList;
  backendAllow: BlockList;
  /** DNS resolution; replaced in tests. */
  resolve?: Resolver;
  /** TXT lookup for domain verification; replaced in tests. */
  resolveTxt?: (name: string) => Promise<string[][]>;
}

/** Options common to writes. */
export interface WriteOptions {
  /** Validate and compute the result, then roll back. */
  dryRun?: boolean;
  /** Required revision of the existing resource (`If-Match`). */
  ifMatch?: number | undefined;
}

/** Thrown inside a transaction to roll it back while still returning a value. */
class DryRun {
  constructor(readonly value: unknown) {}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVELOPE = ["id", "workspace_id", "revision", "created_at", "updated_at"];

/** True when the string is shaped like a UUID. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class Store {
  constructor(readonly deps: StoreDeps) {}

  private get sql(): Sql {
    return this.deps.sql;
  }

  // ── Transactions, events, audit ────────────────────────────────────────────

  private async transact<T>(opts: WriteOptions, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return (await this.sql.begin(async (tx) => {
        const result = await fn(tx);
        if (opts.dryRun) throw new DryRun(result);
        return result;
      })) as T;
    } catch (err) {
      if (err instanceof DryRun) return err.value as T;
      throw translate(err);
    }
  }

  /** Appends one changelog event and wakes long-polling readers. Must be called inside the change's transaction. */
  async emit(tx: Tx, event: { kind: string; op: "upsert" | "delete"; id: string; workspace_id?: string; revision?: number; data?: Json }): Promise<number> {
    const body: Json = { v: 2, kind: event.kind, op: event.op, id: event.id };
    if (event.workspace_id !== undefined) body["workspace_id"] = event.workspace_id;
    if (event.op === "upsert") {
      body["revision"] = event.revision;
      body["data"] = event.data;
    }
    const faults = this.deps.schemas.validate("changelog-event.json", body);
    if (faults.length > 0) {
      // A bug in this service, not in the caller's input: never emit an event nodes would skip.
      throw new Error(`refusing to emit an invalid ${event.kind} event: ${faults.map((f) => `${f.pointer} ${f.message}`).join("; ")}`);
    }
    // Lock the watermark first. Sequence values are handed out before commit, so
    // without this a transaction holding a lower seq could commit after a reader
    // had already moved past it. Holding the row lock until commit makes commit
    // order equal sequence order.
    await tx`SELECT 1 FROM apg_meta WHERE key = 'last_seq' FOR UPDATE`;
    const [row] = await tx<{ seq: number }[]>`INSERT INTO apg_changes (data) VALUES (${tx.json(body)}) RETURNING seq`;
    await tx`UPDATE apg_meta SET value = ${String(row!.seq)} WHERE key = 'last_seq'`;
    await tx`SELECT pg_notify('apg_changes', ${String(row!.seq)})`;
    return row!.seq;
  }

  /** Writes one audit row. Inside the change's transaction for successes. */
  async audit(db: Db, ctx: Ctx, entry: { action: string; kind: string; resource_id?: string | null; resource_name?: string | null; workspace_id?: string | null; outcome?: "ok" | "refused"; before?: Json | null; after?: Json | null }): Promise<void> {
    await db`
      INSERT INTO apg_audit_log (actor_kind, actor_id, actor_name, action, kind, resource_id, resource_name,
                                 workspace_id, request_id, source_ip, outcome, before, after)
      VALUES (${ctx.actor.kind}, ${ctx.actor.id}, ${ctx.actor.name}, ${entry.action}, ${entry.kind},
              ${entry.resource_id ?? null}, ${entry.resource_name ?? null}, ${entry.workspace_id ?? null},
              ${ctx.requestId ?? null}, ${ctx.sourceIp ?? null}, ${entry.outcome ?? "ok"},
              ${entry.before ? db.json(entry.before) : null}, ${entry.after ? db.json(entry.after) : null})`;
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────

  /** Resolves `{ws}` from a path (an id, or a name such as `default`). Out of scope reads as not found. */
  async workspace(db: Db, ref: string, actor: Actor): Promise<Row> {
    const [row] = isUuid(ref)
      ? await db<Row[]>`SELECT * FROM apg_workspaces WHERE id = ${ref}`
      : await db<Row[]>`SELECT * FROM apg_workspaces WHERE name = ${ref}`;
    if (!row) throw new ApiError("NOT_FOUND", "workspace not found");
    requireRead(actor, row["id"]);
    return row;
  }

  async listWorkspaces(ctx: Ctx, page: Page): Promise<Listing> {
    const scope = ctx.actor.workspaces;
    const rows = await this.sql<Row[]>`
      SELECT * FROM apg_workspaces
      WHERE ${scope === "*" ? this.sql`true` : this.sql`id = ANY(${scope.filter(isUuid)}::uuid[])`}
        ${page.cursor ? this.sql`AND id > ${page.cursor}` : this.sql``}
        ${page.name ? this.sql`AND name = ${page.name}` : this.sql``}
        ${page.label ? this.sql`AND labels @> ${this.sql.json(page.label)}` : this.sql``}
      ORDER BY id LIMIT ${page.limit + 1}`;
    if (ctx.actor.role === "node") throw new ApiError("FORBIDDEN", "nodes cannot use the Admin API");
    return paginate(rows.map(workspaceApi), page.limit);
  }

  async createWorkspace(ctx: Ctx, input: Json, opts: WriteOptions = {}): Promise<Json> {
    requireAdmin(ctx.actor);
    const body = this.validated("resources/workspace.json", strip(input, ["system", ...ENVELOPE.filter((k) => k !== "id")]));
    return this.transact(opts, async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO apg_workspaces (id, name, slug, status, limits, labels, metadata)
        VALUES (${body["id"] ?? uuidv7()}, ${body["name"]}, ${body["slug"] ?? slugify(body["name"])}, ${body["status"] ?? "active"},
                ${tx.json(body["limits"] ?? {})}, ${tx.json(body["labels"] ?? {})}, ${tx.json(body["metadata"] ?? {})})
        RETURNING *`;
      await this.emit(tx, { kind: "workspace", op: "upsert", id: row!["id"], revision: 1, data: workspaceEvent(row!) });
      await this.audit(tx, ctx, { action: "create", kind: "workspace", resource_id: row!["id"], resource_name: row!["name"], workspace_id: row!["id"], after: workspaceApi(row!) });
      return workspaceApi(row!);
    });
  }

  async updateWorkspace(ctx: Ctx, ref: string, input: Json, opts: WriteOptions & { merge?: boolean } = {}): Promise<Json> {
    requireAdmin(ctx.actor);
    return this.transact(opts, async (tx) => {
      const [cur] = await tx<Row[]>`SELECT * FROM apg_workspaces WHERE ${isUuid(ref) ? tx`id = ${ref}` : tx`name = ${ref}`} FOR UPDATE`;
      if (!cur) throw new ApiError("NOT_FOUND", "workspace not found");
      checkRevision(cur, opts.ifMatch);
      const before = workspaceApi(cur);
      const merged = opts.merge ? mergePatch(before, input) : input;
      const body = this.validated("resources/workspace.json", strip(merged, ["system", ...ENVELOPE]));
      if (cur["system"] && (body["name"] !== cur["name"] || (body["status"] ?? "active") !== "active")) {
        throw new ApiError("VALIDATION_FAILED", "the system workspace cannot be renamed or suspended");
      }
      const [row] = await tx<Row[]>`
        UPDATE apg_workspaces SET name = ${body["name"]}, slug = ${body["slug"] ?? cur["slug"]}, status = ${body["status"] ?? "active"},
               limits = ${tx.json(body["limits"] ?? {})}, labels = ${tx.json(body["labels"] ?? {})},
               metadata = ${tx.json(body["metadata"] ?? {})}, revision = revision + 1, updated_at = now()
        WHERE id = ${cur["id"]} RETURNING *`;
      await this.emit(tx, { kind: "workspace", op: "upsert", id: row!["id"], revision: row!["revision"], data: workspaceEvent(row!) });
      await this.audit(tx, ctx, { action: "update", kind: "workspace", resource_id: row!["id"], resource_name: row!["name"], workspace_id: row!["id"], before, after: workspaceApi(row!) });
      return workspaceApi(row!);
    });
  }

  async deleteWorkspace(ctx: Ctx, ref: string, opts: WriteOptions & { cascade?: boolean } = {}): Promise<void> {
    requireAdmin(ctx.actor);
    await this.transact(opts, async (tx) => {
      const [cur] = await tx<Row[]>`SELECT * FROM apg_workspaces WHERE ${isUuid(ref) ? tx`id = ${ref}` : tx`name = ${ref}`} FOR UPDATE`;
      if (!cur) throw new ApiError("NOT_FOUND", "workspace not found");
      if (cur["system"]) throw new ApiError("VALIDATION_FAILED", "the system workspace cannot be deleted");
      checkRevision(cur, opts.ifMatch);
      // Delete children through the normal path so nodes get an event for each.
      // Order: things that reference before the things they reference.
      for (const kind of ["plugin", "consumer", "route", "service", "domain", "certificate", "ca_certificate"] as KindName[]) {
        const def = KINDS[kind];
        const rows = await tx<Row[]>`SELECT * FROM ${tx(def.table)} WHERE workspace_id = ${cur["id"]}`;
        if (rows.length > 0 && !opts.cascade) {
          throw new ApiError("IN_USE", `workspace '${cur["name"]}' still has ${rows.length} ${def.segment}; delete them first or pass cascade=true`);
        }
        for (const row of rows) {
          const [still] = await tx<Row[]>`SELECT * FROM ${tx(def.table)} WHERE id = ${row["id"]}`;
          if (still) await this.deleteRow(tx, ctx, def, cur, still, true);
        }
      }
      await tx`DELETE FROM apg_workspaces WHERE id = ${cur["id"]}`;
      await this.emit(tx, { kind: "workspace", op: "delete", id: cur["id"] });
      await this.audit(tx, ctx, { action: "delete", kind: "workspace", resource_id: cur["id"], resource_name: cur["name"], workspace_id: cur["id"], before: workspaceApi(cur) });
    });
  }

  // ── Workspace-scoped resources ─────────────────────────────────────────────

  /** Finds one resource by id or name. `parent` narrows credentials to a consumer. */
  async find(db: Db, def: KindDef, ws: Row, ref: string, parent?: Row, lock = false): Promise<Row> {
    const [row] = await db<Row[]>`
      SELECT * FROM ${db(def.table)}
      WHERE workspace_id = ${ws["id"]}
        AND ${isUuid(ref) ? db`id = ${ref}` : db`name = ${ref}`}
        ${parent && def.parent ? db`AND ${db(def.parent.column)} = ${parent["id"]}` : db``}
      ${lock ? db`FOR UPDATE` : db``}`;
    if (!row) throw new ApiError("NOT_FOUND", `${def.kind} '${ref}' not found`);
    return row;
  }

  private async parentRow(db: Db, def: KindDef, ws: Row, parentRef: string | undefined): Promise<Row | undefined> {
    if (!def.parent) return undefined;
    if (!parentRef) throw new ApiError("BAD_REQUEST", `${def.kind} must be addressed under its ${def.parent.kind}`);
    return this.find(db, KINDS[def.parent.kind], ws, parentRef);
  }

  async list(ctx: Ctx, kind: KindName, wsRef: string, page: Page, parentRef?: string): Promise<Listing> {
    const def = KINDS[kind];
    const ws = await this.workspace(this.sql, wsRef, ctx.actor);
    const parent = await this.parentRow(this.sql, def, ws, parentRef);
    const sql = this.sql;
    const rows = await sql<Row[]>`
      SELECT * FROM ${sql(def.table)}
      WHERE workspace_id = ${ws["id"]}
        ${parent && def.parent ? sql`AND ${sql(def.parent.column)} = ${parent["id"]}` : sql``}
        ${page.cursor ? sql`AND id > ${page.cursor}` : sql``}
        ${page.name ? sql`AND name = ${page.name}` : sql``}
        ${page.label ? sql`AND labels @> ${sql.json(page.label)}` : sql``}
      ORDER BY id LIMIT ${page.limit + 1}`;
    return paginate(rows.map((r) => def.toApi(r)), page.limit);
  }

  async get(ctx: Ctx, kind: KindName, wsRef: string, ref: string, parentRef?: string): Promise<Json> {
    const def = KINDS[kind];
    const ws = await this.workspace(this.sql, wsRef, ctx.actor);
    const parent = await this.parentRow(this.sql, def, ws, parentRef);
    return def.toApi(await this.find(this.sql, def, ws, ref, parent));
  }

  /** Creates a resource. Fails with `CONFLICT` if the name is taken. */
  async create(ctx: Ctx, kind: KindName, wsRef: string, input: Json, opts: WriteOptions = {}, parentRef?: string): Promise<Json> {
    return this.write(ctx, kind, wsRef, undefined, input, { ...opts, mode: "create" }, parentRef);
  }

  /** Replaces a resource, creating it if absent (`PUT` by name is an idempotent upsert, spec RES-1). */
  async put(ctx: Ctx, kind: KindName, wsRef: string, ref: string, input: Json, opts: WriteOptions = {}, parentRef?: string): Promise<Json> {
    return this.write(ctx, kind, wsRef, ref, input, { ...opts, mode: "put" }, parentRef);
  }

  /** Applies a JSON merge patch to a resource. */
  async patch(ctx: Ctx, kind: KindName, wsRef: string, ref: string, input: Json, opts: WriteOptions = {}, parentRef?: string): Promise<Json> {
    return this.write(ctx, kind, wsRef, ref, input, { ...opts, mode: "patch" }, parentRef);
  }

  private async write(ctx: Ctx, kind: KindName, wsRef: string, ref: string | undefined, input: Json,
                      opts: WriteOptions & { mode: "create" | "put" | "patch" }, parentRef?: string): Promise<Json> {
    const def = KINDS[kind];
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ApiError("BAD_REQUEST", "the request body must be a JSON object");

    return this.transact(opts, async (tx) => {
      const ws = await this.workspace(tx, wsRef, ctx.actor);
      requireWrite(ctx.actor, ws["id"]);
      const parent = await this.parentRow(tx, def, ws, parentRef);

      let existing: Row | null = null;
      if (ref !== undefined) {
        try {
          existing = await this.find(tx, def, ws, ref, parent, true);
        } catch (err) {
          if (!(err instanceof ApiError) || err.code !== "NOT_FOUND" || opts.mode === "patch" || isUuid(ref)) throw err;
        }
      }
      if (existing) checkRevision(existing, opts.ifMatch);
      else if (opts.ifMatch !== undefined) throw new ApiError("REVISION_CONFLICT", "the resource does not exist");

      // Work out the full document the caller means.
      let doc: Json = input;
      if (opts.mode === "patch") doc = mergePatch(def.toApi(existing!), input);
      doc = strip(doc, [...ENVELOPE, ...def.readOnly]);
      if (ref !== undefined && !isUuid(ref)) {
        if (doc["name"] !== undefined && doc["name"] !== ref && !existing) {
          throw new ApiError("VALIDATION_FAILED", "the name in the body does not match the name in the path", [{ pointer: "/name", message: `expected '${ref}'` }]);
        }
        doc["name"] ??= ref;
      }
      const id: string = existing ? existing["id"] : uuidv7();
      if (doc["name"] === undefined && def.defaultName) doc["name"] = def.defaultName(doc, id);

      const body = this.validated(def.schema, doc);
      if (!existing) await this.checkLimit(tx, def, ws);

      const prepared = await def.prepare({ store: this, tx, ws, parent, existing, id, body, ctx });
      const common = {
        name: body["name"],
        labels: tx.json(body["labels"] ?? {}),
        ...(def.hasMetadata ? { metadata: tx.json(body["metadata"] ?? {}) } : {}),
      };

      let row: Row;
      if (existing) {
        row = (await tx<Row[]>`
          UPDATE ${tx(def.table)} SET ${tx({ ...common, ...prepared.columns })}, revision = revision + 1, updated_at = now()
          WHERE id = ${id} RETURNING *`)[0]!;
      } else {
        row = (await tx<Row[]>`
          INSERT INTO ${tx(def.table)} ${tx({ id, workspace_id: ws["id"], ...common, ...prepared.columns })} RETURNING *`)[0]!;
      }
      if (prepared.after) await prepared.after(row);

      await this.emit(tx, { kind: def.kind, op: "upsert", id, workspace_id: ws["id"], revision: row["revision"], data: def.toEvent(row) });
      const api = def.toApi(row);
      await this.audit(tx, ctx, {
        action: existing ? "update" : "create", kind: def.kind, resource_id: id, resource_name: row["name"], workspace_id: ws["id"],
        before: existing ? def.toApi(existing) : null, after: api,
      });
      // A generated secret is shown exactly once, in this response, and never stored or audited.
      return prepared.reveal ? { ...api, ...prepared.reveal } : api;
    });
  }

  async remove(ctx: Ctx, kind: KindName, wsRef: string, ref: string, opts: WriteOptions & { cascade?: boolean } = {}, parentRef?: string): Promise<void> {
    const def = KINDS[kind];
    await this.transact(opts, async (tx) => {
      const ws = await this.workspace(tx, wsRef, ctx.actor);
      requireWrite(ctx.actor, ws["id"]);
      const parent = await this.parentRow(tx, def, ws, parentRef);
      const row = await this.find(tx, def, ws, ref, parent, true);
      checkRevision(row, opts.ifMatch);
      await this.deleteRow(tx, ctx, def, ws, row, opts.cascade ?? false);
    });
  }

  /**
   * Deletes one row and everything that cannot outlive it, emitting an event
   * for each so nodes drop exactly what the database dropped (spec RES-3).
   */
  async deleteRow(tx: Tx, ctx: Ctx, def: KindDef, ws: Row, row: Row, cascade: boolean): Promise<void> {
    const deps = def.dependents ? await def.dependents(tx, row) : { owned: [], referrers: [], blockers: [] };
    if (deps.blockers.length > 0) {
      throw new ApiError("IN_USE", `${def.kind} '${row["name"]}' is in use by ${describe(deps.blockers)}`);
    }
    if (deps.referrers.length > 0 && !cascade) {
      throw new ApiError("IN_USE", `${def.kind} '${row["name"]}' is in use by ${describe(deps.referrers)}; delete them first or pass cascade=true`);
    }
    for (const dep of [...deps.owned, ...deps.referrers]) {
      const childDef = KINDS[dep.kind];
      const [still] = await tx<Row[]>`SELECT * FROM ${tx(childDef.table)} WHERE id = ${dep.id} FOR UPDATE`;
      if (still) await this.deleteRow(tx, ctx, childDef, ws, still, true);
    }
    await tx`DELETE FROM ${tx(def.table)} WHERE id = ${row["id"]}`;
    await this.emit(tx, { kind: def.kind, op: "delete", id: row["id"], workspace_id: row["workspace_id"] });
    await this.audit(tx, ctx, { action: "delete", kind: def.kind, resource_id: row["id"], resource_name: row["name"], workspace_id: row["workspace_id"], before: def.toApi(row) });
  }

  private async checkLimit(tx: Tx, def: KindDef, ws: Row): Promise<void> {
    if (!def.limitKey) return;
    const max = (ws["limits"] ?? {})[def.limitKey];
    if (typeof max !== "number") return;
    const n = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tx(def.table)} WHERE workspace_id = ${ws["id"]}`)[0]!.n;
    if (n >= max) throw new ApiError("LIMIT_EXCEEDED", `workspace '${ws["name"]}' is limited to ${max} ${def.segment}`);
  }

  /** Validates `doc` and returns it with schema defaults filled in. Throws `VALIDATION_FAILED`. */
  validated(schema: string, doc: Json): Json {
    const faults = this.deps.schemas.validate(schema, doc);
    if (faults.length > 0) throw new ApiError("VALIDATION_FAILED", `${faults.length} validation fault(s)`, dedupe(faults));
    return this.deps.schemas.withDefaults(schema, doc);
  }

  // ── Flags and settings ─────────────────────────────────────────────────────

  async listFlags(ctx: Ctx): Promise<Json[]> {
    requireAdmin(ctx.actor);
    return this.sql<Json[]>`SELECT name, enabled, revision, updated_at FROM apg_flags ORDER BY name`;
  }

  async putFlag(ctx: Ctx, name: string, input: Json, opts: WriteOptions = {}): Promise<Json> {
    requireAdmin(ctx.actor);
    const body = this.validated("resources/flag.json", { name, enabled: input?.["enabled"] });
    return this.transact(opts, async (tx) => {
      const [before] = await tx<Row[]>`SELECT name, enabled, revision FROM apg_flags WHERE name = ${name} FOR UPDATE`;
      const [row] = await tx<Row[]>`
        INSERT INTO apg_flags (name, enabled) VALUES (${name}, ${body["enabled"]})
        ON CONFLICT (name) DO UPDATE SET enabled = EXCLUDED.enabled, revision = apg_flags.revision + 1, updated_at = now()
        RETURNING name, enabled, revision, updated_at`;
      await this.emit(tx, { kind: "flag", op: "upsert", id: name, revision: row!["revision"], data: { enabled: row!["enabled"] } });
      await this.audit(tx, ctx, { action: before ? "update" : "create", kind: "flag", resource_id: name, resource_name: name, before: before ?? null, after: row! });
      return row!;
    });
  }

  async listSettings(ctx: Ctx): Promise<Json[]> {
    requireAdmin(ctx.actor);
    return this.sql<Json[]>`SELECT name, value, revision, updated_at FROM apg_settings ORDER BY name`;
  }

  async putSetting(ctx: Ctx, name: string, input: Json, opts: WriteOptions = {}): Promise<Json> {
    requireAdmin(ctx.actor);
    if (input === null || typeof input !== "object" || !("value" in input)) {
      throw new ApiError("VALIDATION_FAILED", "the body must be { \"value\": … }", [{ pointer: "/value", message: "is required" }]);
    }
    // Each setting is one property of settings.json; validating a one-property
    // object checks both that the name exists and that the value fits it.
    const faults = this.deps.schemas.validate("resources/settings.json", { [name]: input["value"] });
    if (faults.length > 0) {
      throw new ApiError("VALIDATION_FAILED", `invalid setting '${name}'`, faults.map((f) => ({ pointer: f.pointer.replace(`/${name}`, "/value"), message: f.message })));
    }
    if (name === "access_log") {
      // Shipping lines to an HTTP endpoint is not built; stdout, a file and off are.
      if (String(input["value"]?.["sink"] ?? "").startsWith("http")) {
        throw new ApiError("VALIDATION_FAILED", "an http sink is not enforced by this build yet; use stdout, off or file:<path>", [{ pointer: "/value/sink", message: "not available in this build" }]);
      }
      for (const [field, template] of Object.entries((input["value"]?.["custom_fields"] ?? {}) as Record<string, unknown>)) {
        const fault = typeof template === "string" ? templateFault(template) : null;
        if (fault) throw new ApiError("VALIDATION_FAILED", fault, [{ pointer: `/value/custom_fields/${field}`, message: fault }]);
      }
    }
    const unbuilt = unbuiltFaults({ [name]: input["value"] }, UNBUILT_SETTINGS);
    if (unbuilt.length > 0) {
      throw new ApiError("VALIDATION_FAILED", unbuilt[0]!.message, [{ pointer: "/value", message: unbuilt[0]!.message }]);
    }
    return this.transact(opts, async (tx) => {
      const [before] = await tx<Row[]>`SELECT name, value, revision FROM apg_settings WHERE name = ${name} FOR UPDATE`;
      const [row] = await tx<Row[]>`
        INSERT INTO apg_settings (name, value) VALUES (${name}, ${tx.json(input["value"])})
        ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, revision = apg_settings.revision + 1, updated_at = now()
        RETURNING name, value, revision, updated_at`;
      await this.emit(tx, { kind: "setting", op: "upsert", id: name, revision: row!["revision"], data: { value: row!["value"] } });
      await this.audit(tx, ctx, { action: before ? "update" : "create", kind: "setting", resource_id: name, resource_name: name, before: before ?? null, after: row! });
      return row!;
    });
  }

  /** The value of one setting, or `fallback` when it has never been set. */
  async setting<T>(db: Db, name: string, fallback: T): Promise<T> {
    const [row] = await db<{ value: T }[]>`SELECT value FROM apg_settings WHERE name = ${name}`;
    return row ? row.value : fallback;
  }

  /** True when the caller is a fleet-wide admin; kind definitions use it to skip tenant-only checks. */
  trusted(ctx: Ctx): boolean {
    return isAdmin(ctx.actor);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Pagination and filter parameters of a list call. */
export interface Page {
  limit: number;
  cursor?: string | undefined;
  name?: string | undefined;
  label?: Record<string, string> | undefined;
}

/** One page of results. */
export interface Listing {
  data: Json[];
  next_cursor: string | null;
}

function paginate(items: Json[], limit: number): Listing {
  const data = items.slice(0, limit);
  return { data, next_cursor: items.length > limit ? (data[data.length - 1]!["id"] as string) : null };
}

/** The API representation of a workspace row. */
export function workspaceApi(row: Row): Json {
  return {
    id: row["id"], name: row["name"], slug: row["slug"], system: row["system"], status: row["status"],
    limits: row["limits"], labels: row["labels"], metadata: row["metadata"],
    revision: row["revision"], created_at: row["created_at"], updated_at: row["updated_at"],
  };
}

function workspaceEvent(row: Row): Json {
  return { name: row["name"], slug: row["slug"], system: row["system"], status: row["status"], labels: row["labels"] };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "ws";
}

function strip(doc: Json, keys: readonly string[]): Json {
  const out: Json = { ...doc };
  for (const k of keys) delete out[k];
  return out;
}

function checkRevision(row: Row, ifMatch: number | undefined): void {
  if (ifMatch !== undefined && row["revision"] !== ifMatch) {
    throw new ApiError("REVISION_CONFLICT", `the resource is at revision ${row["revision"]}, not ${ifMatch}`);
  }
}

/** JSON merge patch (RFC 7386). */
export function mergePatch(target: unknown, patch: unknown): any {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const out: Json = typeof target === "object" && target !== null && !Array.isArray(target) ? { ...(target as Json) } : {};
  for (const [k, v] of Object.entries(patch as Json)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

function dedupe(faults: ErrorDetail[]): ErrorDetail[] {
  const seen = new Set<string>();
  return faults.filter((f) => {
    const key = `${f.pointer}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describe(deps: Array<{ kind: string; name: string }>): string {
  const shown = deps.slice(0, 5).map((d) => `${d.kind} '${d.name}'`).join(", ");
  return deps.length > 5 ? `${shown} and ${deps.length - 5} more` : shown;
}

/** Maps database constraint violations onto API errors, so callers never see SQL. */
function translate(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  const e = err as { code?: string; constraint_name?: string; detail?: string };
  if (e.code === "23505") {
    if (e.constraint_name === "apg_domains_hostname_key") return new ApiError("CONFLICT", "that hostname is already claimed");
    if (e.constraint_name === "apg_plugins_attachment") return new ApiError("CONFLICT", "a plugin of this type is already attached at exactly this scope");
    if (e.constraint_name === "apg_credentials_key_hash_key") return new ApiError("CONFLICT", "that key is already in use");
    return new ApiError("CONFLICT", "a resource with that name or unique value already exists");
  }
  if (e.code === "23503") return new ApiError("IN_USE", "the resource is referenced by another resource");
  if (e.code === "23514") return new ApiError("VALIDATION_FAILED", `the resource violates a database rule (${e.constraint_name ?? "check"})`);
  if (e.code === "22P02") return new ApiError("BAD_REQUEST", "malformed identifier");
  return err;
}
