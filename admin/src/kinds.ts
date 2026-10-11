/**
 * Definitions of the workspace-scoped resource kinds.
 *
 * Each definition says how a validated document becomes a row, how a row
 * becomes the API representation and the changelog event, and what depends on
 * a row when it is deleted. The generic flow (transaction, revision, event,
 * audit) lives in `store.ts`.
 *
 * Reference fields (`service`, `scope_ref`, `consumer`, `tls.certificate`, …)
 * accept a name or an id on write and always hold the id once stored, so what
 * a `GET` returns can be sent back in a `PUT`, and nodes only ever see ids.
 */

import { X509Certificate, createPrivateKey } from "node:crypto";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateToken, sha256, uuidv7 } from "./crypto.js";
import type { Tx } from "./db.js";
import { egressViolation } from "./egress.js";
import { ApiError } from "./errors.js";
import { type Ctx, type Json, type Row, type Store, isUuid } from "./store.js";
import { UNBUILT_MESSAGE, type UnbuiltKey, loadUnbuilt, unbuiltFaults } from "./unbuilt.js";

const UNBUILT = loadUnbuilt();

export type KindName = "domain" | "certificate" | "ca_certificate" | "service" | "route" | "consumer" | "credential" | "plugin";

interface Dep {
  kind: KindName;
  id: string;
  name: string;
}

/** What must go, or what stands in the way, when a row is deleted. */
export interface Dependents {
  /** Children that cannot exist without the row. Always deleted with it. */
  owned: Dep[];
  /** Other resources that reference the row. Block the delete unless `cascade`. */
  referrers: Dep[];
  /** References that `cascade` does not remove. Always block. */
  blockers: Dep[];
}

export interface PrepareArgs {
  store: Store;
  tx: Tx;
  ws: Row;
  parent: Row | undefined;
  existing: Row | null;
  id: string;
  /** The validated document with defaults filled in. */
  body: Json;
  ctx: Ctx;
}

export interface Prepared {
  /** Kind-specific columns to write. */
  columns: Record<string, unknown>;
  /** Runs after the row is written, inside the same transaction. */
  after?: (row: Row) => Promise<void>;
  /** Extra fields for this one response only (a generated secret). */
  reveal?: Json;
}

export interface KindDef {
  kind: KindName;
  /** URL path segment and the plural used in messages. */
  segment: string;
  table: string;
  schema: string;
  /** Server-managed fields dropped from input before validation. */
  readOnly: string[];
  hasMetadata: boolean;
  limitKey?: string;
  parent?: { kind: KindName; column: string };
  defaultName?: (body: Json, id: string) => string;
  prepare: (args: PrepareArgs) => Promise<Prepared>;
  toApi: (row: Row) => Json;
  toEvent: (row: Row) => Json;
  dependents?: (tx: Tx, row: Row) => Promise<Dependents>;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function fail(pointer: string, message: string, code: "VALIDATION_FAILED" | "HOST_NOT_OWNED" | "EGRESS_NOT_ALLOWED" = "VALIDATION_FAILED"): never {
  throw new ApiError(code, message, [{ pointer, message }]);
}

/** Refuses keys nodes would ignore (spec property 5: everything accepted is enforced). */
function refuseUnbuilt(body: Json, keys: UnbuiltKey[]): void {
  const faults = unbuiltFaults(body, keys);
  if (faults.length > 0) throw new ApiError("VALIDATION_FAILED", faults[0]!.message, faults);
}

function envelope(row: Row): Json {
  return { id: row["id"], workspace_id: row["workspace_id"], name: row["name"] };
}

function tail(row: Row, metadata = true): Json {
  return {
    labels: row["labels"],
    ...(metadata ? { metadata: row["metadata"] } : {}),
    revision: row["revision"],
    created_at: row["created_at"],
    updated_at: row["updated_at"],
  };
}

/** Resolves a name-or-id reference to a row of `table` in the workspace. */
async function resolveRef(tx: Tx, table: string, ws: Row, ref: string, what: string, pointer: string): Promise<Row> {
  const [row] = await tx<Row[]>`
    SELECT * FROM ${tx(table)} WHERE workspace_id = ${ws["id"]} AND ${isUuid(ref) ? tx`id = ${ref}` : tx`name = ${ref}`}`;
  if (!row) fail(pointer, `${what} '${ref}' does not exist in this workspace`);
  return row!;
}

async function systemWorkspace(tx: Tx): Promise<Row> {
  const [row] = await tx<Row[]>`SELECT * FROM apg_workspaces WHERE system`;
  return row!;
}

function rejectNested(body: Json, key: string): void {
  if (body[key] !== undefined) fail(`/${key}`, `nested '${key}' is accepted only in apg.yaml; use the ${key} endpoints`);
}

function hostOf(target: string): string {
  return target.slice(0, target.lastIndexOf(":"));
}

/** True when `pattern` (exact or `*.suffix`) covers `host` (exact or itself a wildcard). */
export function hostCovered(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (!pattern.startsWith("*.") || host.startsWith("*.")) return false;
  const suffix = pattern.slice(1); // ".example.com"
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes(".");
}

function checkRegex(pattern: string, pointer: string): void {
  // The node compiles patterns with a linear-time engine that has no
  // look-around or back-references; refuse those here so a route the admin
  // accepts is one every node can load.
  if (/\(\?[=!<]|\\[1-9]/.test(pattern)) fail(pointer, "look-around and back-references are not supported in patterns");
  try {
    new RegExp(pattern);
  } catch (err) {
    fail(pointer, `not a valid regular expression: ${(err as Error).message}`);
  }
}

// ── Domain ───────────────────────────────────────────────────────────────────

const domain: KindDef = {
  kind: "domain",
  segment: "domains",
  table: "apg_domains",
  schema: "resources/domain.json",
  readOnly: ["verification", "status", "status_reason"],
  hasMetadata: true,
  limitKey: "max_domains",
  defaultName: (body) => String(body["hostname"] ?? "").replace(/^\*\./, "wildcard.").slice(0, 128),

  async prepare({ store, tx, ws, existing, body, ctx }) {
    const hostname = String(body["hostname"]).toLowerCase();
    const tls = body["tls"] ?? {};
    const mode: string = tls["mode"] ?? "acme";
    let certificateId: string | null = null;
    if (mode === "manual") {
      certificateId = (await resolveRef(tx, "apg_certificates", ws, tls["certificate"], "certificate", "/tls/certificate"))["id"];
    }

    // A tenant may not claim a name inside a base domain: those hosts belong to
    // whichever workspace has the matching slug (spec DOM-2).
    if (!ws["system"]) {
      const bases = await store.setting<Array<{ domain: string }>>(tx, "workspace_base_domains", []);
      for (const b of bases) {
        if (hostname === b.domain || hostname.endsWith(`.${b.domain}`)) {
          fail("/hostname", `'${hostname}' is inside the base domain '${b.domain}' and cannot be claimed`, "HOST_NOT_OWNED");
        }
      }
    }

    const sameHost = existing && existing["hostname"] === hostname;
    let status = "active";
    let verification: Json = { method: "none" };
    if (sameHost) {
      status = existing!["status"];
      verification = existing!["verification"];
    } else if (store.deps.domainVerification === "dns_txt" && !store.trusted(ctx)) {
      status = "pending";
      verification = { method: "dns_txt", record: `_apg-challenge.${hostname.replace(/^\*\./, "")}`, token: generateToken("apg-verify-") };
    }

    return {
      columns: {
        hostname,
        tls_mode: mode,
        tls_challenge: tls["challenge"] ?? "http01",
        certificate_id: certificateId,
        status,
        status_reason: status === "pending" ? "waiting for DNS verification" : null,
        verification: tx.json(verification),
      },
    };
  },

  toApi: (row) => ({
    ...envelope(row),
    hostname: row["hostname"],
    tls: { mode: row["tls_mode"], challenge: row["tls_challenge"], ...(row["certificate_id"] ? { certificate: row["certificate_id"] } : {}) },
    verification: row["verification"],
    status: row["status"],
    ...(row["status_reason"] ? { status_reason: row["status_reason"] } : {}),
    ...tail(row),
  }),

  toEvent: (row) => ({
    name: row["name"],
    hostname: row["hostname"],
    tls: { mode: row["tls_mode"], challenge: row["tls_challenge"], ...(row["certificate_id"] ? { certificate: row["certificate_id"] } : {}) },
    status: row["status"],
  }),

  async dependents(tx, row) {
    // Routes of this workspace whose hosts this domain covers would be left
    // routing a host nobody owns.
    const routes = await tx<Row[]>`SELECT id, name, spec FROM apg_routes WHERE workspace_id = ${row["workspace_id"]}`;
    const [ws] = await tx<Row[]>`SELECT system FROM apg_workspaces WHERE id = ${row["workspace_id"]}`;
    const referrers = ws?.["system"]
      ? []
      : routes
          .filter((r) => ((r["spec"]["hosts"] ?? []) as string[]).some((h) => hostCovered(row["hostname"], h)))
          .map((r) => ({ kind: "route" as const, id: r["id"], name: r["name"] }));
    return { owned: [], referrers, blockers: [] };
  },
};

/** Checks the DNS TXT record of a pending domain and activates it when the token is there. */
export async function verifyDomain(store: Store, ctx: Ctx, wsRef: string, ref: string): Promise<Json> {
  const lookup = store.deps.resolveTxt ?? dnsResolveTxt;
  return store.deps.sql.begin(async (tx) => {
    const ws = await store.workspace(tx, wsRef, ctx.actor);
    const row = await store.find(tx, domain, ws, ref, undefined, true);
    if (!["admin", "editor"].includes(ctx.actor.role)) throw new ApiError("FORBIDDEN", `role '${ctx.actor.role}' cannot change resources`);
    const v = row["verification"] as Json;
    if (row["status"] === "active" || v["method"] !== "dns_txt") return domain.toApi(row);

    let found = false;
    try {
      found = (await lookup(v["record"])).some((chunks) => chunks.join("") === v["token"]);
    } catch {
      found = false;
    }
    const [updated] = found
      ? await tx<Row[]>`UPDATE apg_domains SET status = 'active', status_reason = NULL,
          verification = ${tx.json({ ...v, verified_at: new Date().toISOString() })}, revision = revision + 1, updated_at = now()
          WHERE id = ${row["id"]} RETURNING *`
      : await tx<Row[]>`UPDATE apg_domains SET status_reason = ${`TXT record ${v["record"]} does not contain the token`}, updated_at = now()
          WHERE id = ${row["id"]} RETURNING *`;
    if (found) {
      await store.emit(tx, { kind: "domain", op: "upsert", id: row["id"], workspace_id: row["workspace_id"], revision: updated!["revision"], data: domain.toEvent(updated!) });
      await store.audit(tx, ctx, { action: "verify", kind: "domain", resource_id: row["id"], resource_name: row["name"], workspace_id: row["workspace_id"], before: domain.toApi(row), after: domain.toApi(updated!) });
    }
    return domain.toApi(updated!);
  }) as Promise<Json>;
}

// ── Certificate ──────────────────────────────────────────────────────────────

function parseCertificate(pem: string, pointer: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    return fail(pointer, "not a PEM-encoded X.509 certificate");
  }
}

const certificate: KindDef = {
  kind: "certificate",
  segment: "certificates",
  table: "apg_certificates",
  schema: "resources/certificate.json",
  readOnly: ["hosts", "not_before", "not_after", "issuer", "fingerprint_sha256", "source"],
  hasMetadata: true,

  async prepare({ store, existing, id, body }) {
    if (body["cert_file"] !== undefined || body["key_file"] !== undefined) {
      fail("/cert_file", "cert_file and key_file are for file mode; send cert_pem and key_pem");
    }
    const certPem: string = body["cert_pem"];
    const leaf = parseCertificate(certPem, "/cert_pem");

    let keyCiphertext: string;
    if (typeof body["key_pem"] === "string") {
      let matches = false;
      try {
        matches = leaf.checkPrivateKey(createPrivateKey(body["key_pem"]));
      } catch {
        fail("/key_pem", "not a PEM-encoded private key");
      }
      if (!matches) fail("/key_pem", "the private key does not match the certificate");
      keyCiphertext = store.deps.box.seal(body["key_pem"], `certificate:${id}`);
    } else if (existing && existing["cert_pem"] === certPem) {
      keyCiphertext = existing["key_ciphertext"]; // unchanged certificate: keep the stored key
    } else {
      return fail("/key_pem", "key_pem is required when the certificate changes");
    }

    const hosts = (leaf.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("DNS:"))
      .map((s) => s.slice(4).toLowerCase());
    return {
      columns: {
        cert_pem: certPem,
        key_ciphertext: keyCiphertext,
        hosts,
        not_before: new Date(leaf.validFrom),
        not_after: new Date(leaf.validTo),
        issuer: leaf.issuer.replace(/\n/g, ", "),
        fingerprint_sha256: leaf.fingerprint256,
        source: existing ? existing["source"] : "manual",
      },
    };
  },

  // The key is write-only: neither the key nor its ciphertext is ever returned.
  toApi: (row) => ({
    ...envelope(row),
    cert_pem: row["cert_pem"],
    hosts: row["hosts"],
    not_before: row["not_before"],
    not_after: row["not_after"],
    issuer: row["issuer"],
    fingerprint_sha256: row["fingerprint_sha256"],
    source: row["source"],
    ...tail(row),
  }),

  toEvent: (row) => ({
    name: row["name"],
    cert_pem: row["cert_pem"],
    key_ciphertext: row["key_ciphertext"],
    hosts: row["hosts"],
    not_after: row["not_after"],
  }),

  async dependents(tx, row) {
    const domains = await tx<Row[]>`SELECT id, name FROM apg_domains WHERE certificate_id = ${row["id"]}`;
    const services = await tx<Row[]>`SELECT id, name FROM apg_services WHERE spec->'tls'->>'client_certificate' = ${row["id"]}`;
    return {
      owned: [],
      referrers: domains.map((d) => ({ kind: "domain" as const, id: d["id"], name: d["name"] })),
      blockers: services.map((s) => ({ kind: "service" as const, id: s["id"], name: s["name"] })),
    };
  },
};

const caCertificate: KindDef = {
  kind: "ca_certificate",
  segment: "ca-certificates",
  table: "apg_ca_certificates",
  schema: "resources/ca-certificate.json",
  readOnly: [],
  hasMetadata: true,

  async prepare({ body }) {
    if (body["cert_file"] !== undefined) fail("/cert_file", "cert_file is for file mode; send cert_pem");
    parseCertificate(body["cert_pem"], "/cert_pem");
    return { columns: { cert_pem: body["cert_pem"] } };
  },

  toApi: (row) => ({ ...envelope(row), cert_pem: row["cert_pem"], ...tail(row) }),
  toEvent: (row) => ({ name: row["name"], cert_pem: row["cert_pem"] }),

  async dependents(tx, row) {
    const services = await tx<Row[]>`SELECT id, name FROM apg_services WHERE spec->'tls'->'ca_certificates' ? ${row["id"]}`;
    return { owned: [], referrers: [], blockers: services.map((s) => ({ kind: "service" as const, id: s["id"], name: s["name"] })) };
  },
};

// ── Service ──────────────────────────────────────────────────────────────────

const service: KindDef = {
  kind: "service",
  segment: "services",
  table: "apg_services",
  schema: "resources/service.json",
  readOnly: ["egress_restricted"],
  hasMetadata: true,
  limitKey: "max_services",

  async prepare({ store, tx, ws, existing, body, ctx }) {
    rejectNested(body, "plugins");
    if (body["shared"] && !ws["system"]) fail("/shared", "only a service in the system workspace can be shared");
    refuseUnbuilt(body, [...UNBUILT.service, ...UNBUILT.service_database_mode]);
    for (const [i, on] of ((body["retries"]?.["on"] ?? []) as unknown[]).entries()) {
      // A node cannot replay a request once the upstream has answered.
      if (typeof on === "number") fail(`/retries/on/${i}`, `retrying on a response status ${UNBUILT_MESSAGE}; use connect_failure and timeout`);
    }

    // Keep a backend's id across updates so nodes keep its health state.
    const previous = new Map<string, string>(((existing?.["spec"]?.["backends"] ?? []) as Json[]).map((b) => [b["target"], b["id"]]));
    const seen = new Set<string>();
    const backends = (body["backends"] as Json[]).map((b, i): Json => {
      if (seen.has(b["target"])) fail(`/backends/${i}/target`, `duplicate backend '${b["target"]}'`);
      seen.add(b["target"]);
      return { ...b, id: previous.get(b["target"]) ?? uuidv7() };
    });

    if (!store.trusted(ctx)) {
      for (const [i, b] of backends.entries()) {
        const reason = await egressViolation(hostOf(b["target"]), store.deps.backendAllow, store.deps.resolve);
        if (reason) fail(`/backends/${i}/target`, reason, "EGRESS_NOT_ALLOWED");
      }
    }

    const tls: Json = { ...(body["tls"] ?? {}) };
    if (Array.isArray(tls["ca_certificates"])) {
      tls["ca_certificates"] = await Promise.all(
        (tls["ca_certificates"] as string[]).map(async (ref, i) => (await resolveRef(tx, "apg_ca_certificates", ws, ref, "CA certificate", `/tls/ca_certificates/${i}`))["id"]),
      );
    }
    if (tls["client_certificate"] !== undefined) {
      tls["client_certificate"] = (await resolveRef(tx, "apg_certificates", ws, tls["client_certificate"], "certificate", "/tls/client_certificate"))["id"];
    }

    const { name: _n, labels: _l, metadata: _m, shared: _s, ...rest } = body;
    // Nodes check the address again on every connection for a service written
    // by someone who may not reach private addresses (spec SEC-4).
    const spec = { ...rest, backends, ...(body["tls"] !== undefined ? { tls } : {}), egress_restricted: !store.trusted(ctx) };
    return { columns: { shared: body["shared"] ?? false, spec: tx.json(spec) } };
  },

  toApi: (row) => ({ ...envelope(row), shared: row["shared"], ...row["spec"], ...tail(row) }),
  toEvent: (row) => ({ name: row["name"], shared: row["shared"], labels: row["labels"], ...row["spec"] }),

  async dependents(tx, row) {
    const plugins = await tx<Row[]>`SELECT id, name FROM apg_plugins WHERE service_id = ${row["id"]}`;
    const routes = await tx<Row[]>`
      SELECT r.id, r.name FROM apg_routes r JOIN apg_route_services rs ON rs.route_id = r.id WHERE rs.service_id = ${row["id"]}`;
    return {
      owned: plugins.map((p) => ({ kind: "plugin" as const, id: p["id"], name: p["name"] })),
      referrers: routes.map((r) => ({ kind: "route" as const, id: r["id"], name: r["name"] })),
      blockers: [],
    };
  },
};

// ── Route ────────────────────────────────────────────────────────────────────

async function resolveService(tx: Tx, ws: Row, ref: string, pointer: string): Promise<string> {
  const byRef = isUuid(ref) ? tx`id = ${ref}` : tx`name = ${ref}`;
  const [own] = await tx<Row[]>`SELECT id FROM apg_services WHERE workspace_id = ${ws["id"]} AND ${byRef}`;
  if (own) return own["id"];
  // A shared service of the system workspace may be used from any workspace.
  const [shared] = await tx<Row[]>`
    SELECT s.id FROM apg_services s JOIN apg_workspaces w ON w.id = s.workspace_id WHERE w.system AND s.shared AND ${isUuid(ref) ? tx`s.id = ${ref}` : tx`s.name = ${ref}`}`;
  if (shared) return shared["id"];
  return fail(pointer, `service '${ref}' does not exist in this workspace and is not a shared service`);
}

const route: KindDef = {
  kind: "route",
  segment: "routes",
  table: "apg_routes",
  schema: "resources/route.json",
  readOnly: ["cache_epoch"],
  hasMetadata: true,
  limitKey: "max_routes",

  async prepare({ store, tx, ws, id, body }) {
    rejectNested(body, "plugins");
    refuseUnbuilt(body, UNBUILT.route);

    const targets: Array<{ service: string; weight: number }> = [];
    if (body["service"] !== undefined) {
      targets.push({ service: await resolveService(tx, ws, body["service"], "/service"), weight: 1 });
    } else {
      for (const [i, s] of (body["split"] as Json[]).entries()) {
        targets.push({ service: await resolveService(tx, ws, s["service"], `/split/${i}/service`), weight: s["weight"] });
      }
      if (new Set(targets.map((t) => t.service)).size !== targets.length) fail("/split", "a service appears more than once in the split");
      if (targets.every((t) => t.weight === 0)) fail("/split", "at least one side of the split needs a weight above 0");
    }

    const hosts = ((body["hosts"] ?? []) as string[]).map((h) => h.toLowerCase());
    if (!ws["system"]) {
      // Host ownership (spec DOM-1): what stops one tenant routing another tenant's hosts.
      if (hosts.length === 0) fail("/hosts", "a route outside the system workspace must list at least one host", "HOST_NOT_OWNED");
      const owned = (await tx<Row[]>`SELECT hostname FROM apg_domains WHERE workspace_id = ${ws["id"]} AND status = 'active'`).map((d) => d["hostname"] as string);
      const bases = await store.setting<Array<{ domain: string }>>(tx, "workspace_base_domains", []);
      owned.push(...bases.map((b) => `${ws["slug"]}.${b.domain}`));
      for (const [i, h] of hosts.entries()) {
        if (!owned.some((o) => hostCovered(o, h))) {
          fail(`/hosts/${i}`, `'${h}' is not covered by an active domain of this workspace`, "HOST_NOT_OWNED");
        }
      }
    }

    const paths = ((body["paths"] ?? []) as Array<string | Json>).map((p, i) => {
      const norm = typeof p === "string" ? { type: "prefix", value: p } : p;
      if (norm["type"] === "regex") checkRegex(norm["value"], `/paths/${i}/value`);
      else if (!String(norm["value"]).startsWith("/")) fail(`/paths/${i}/value`, "a path must start with '/'");
      return norm;
    });
    for (const key of ["headers", "query"] as const) {
      for (const [i, p] of ((body[key] ?? []) as Json[]).entries()) {
        if (p["type"] === "regex") checkRegex(p["value"], `/${key}/${i}/value`);
      }
    }
    if (body["rewrite"]?.["regex"] !== undefined) checkRegex(body["rewrite"]["regex"], "/rewrite/regex");

    const { name: _n, labels: _l, metadata: _m, priority, enabled, service: _s, split: _sp, hosts: _h, paths: _p, ...rest } = body;
    const spec: Json = {
      ...rest,
      ...(body["service"] !== undefined ? { service: targets[0]!.service } : { split: targets }),
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(paths.length > 0 ? { paths } : {}),
    };
    return {
      columns: { priority: priority ?? 0, enabled: enabled ?? true, spec: tx.json(spec) },
      after: async () => {
        await tx`DELETE FROM apg_route_services WHERE route_id = ${id}`;
        for (const t of targets) {
          await tx`INSERT INTO apg_route_services (route_id, service_id, weight) VALUES (${id}, ${t.service}, ${t.weight})`;
        }
      },
    };
  },

  toApi: (row) => ({ ...envelope(row), ...row["spec"], priority: row["priority"], enabled: row["enabled"], cache_epoch: row["cache_epoch"], ...tail(row) }),
  toEvent: (row) => ({ name: row["name"], ...row["spec"], priority: row["priority"], enabled: row["enabled"], cache_epoch: row["cache_epoch"], labels: row["labels"] }),

  async dependents(tx, row) {
    const plugins = await tx<Row[]>`SELECT id, name FROM apg_plugins WHERE route_id = ${row["id"]}`;
    return { owned: plugins.map((p) => ({ kind: "plugin" as const, id: p["id"], name: p["name"] })), referrers: [], blockers: [] };
  },
};

// ── Consumer and credential ──────────────────────────────────────────────────

const consumer: KindDef = {
  kind: "consumer",
  segment: "consumers",
  table: "apg_consumers",
  schema: "resources/consumer.json",
  readOnly: [],
  hasMetadata: true,
  limitKey: "max_consumers",

  async prepare({ body }) {
    rejectNested(body, "credentials");
    return { columns: { custom_id: body["custom_id"] ?? null, groups: body["groups"] ?? [] } };
  },

  toApi: (row) => ({
    ...envelope(row),
    ...(row["custom_id"] !== null ? { custom_id: row["custom_id"] } : {}),
    groups: row["groups"],
    ...tail(row),
  }),
  toEvent: (row) => ({ name: row["name"], custom_id: row["custom_id"], groups: row["groups"], labels: row["labels"] }),

  async dependents(tx, row) {
    const creds = await tx<Row[]>`SELECT id, name FROM apg_credentials WHERE consumer_id = ${row["id"]}`;
    const plugins = await tx<Row[]>`SELECT id, name FROM apg_plugins WHERE consumer_id = ${row["id"]}`;
    return {
      owned: [
        ...creds.map((c) => ({ kind: "credential" as const, id: c["id"], name: c["name"] })),
        ...plugins.map((p) => ({ kind: "plugin" as const, id: p["id"], name: p["name"] })),
      ],
      referrers: [],
      blockers: [],
    };
  },
};

/** A secret given to the Admin API: a plain string or `{ $secret }`. Node-resolved forms cannot be hashed here. */
function clearSecret(value: unknown, pointer: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const v = value as Json;
  if (typeof v["$secret"] === "string") return v["$secret"];
  return fail(pointer, "$env and $file are resolved by nodes and cannot be used for a hashed credential through the Admin API");
}

const credential: KindDef = {
  kind: "credential",
  segment: "credentials",
  table: "apg_credentials",
  schema: "resources/credential.json",
  readOnly: ["consumer_id", "key_prefix"],
  hasMetadata: false,
  parent: { kind: "consumer", column: "consumer_id" },
  defaultName: (body, id) => `${String(body["type"] ?? "credential")}-${id.slice(-8)}`,

  async prepare({ parent, existing, body }) {
    const type: string = body["type"];
    if (existing && existing["type"] !== type) fail("/type", "the type of a credential cannot change; create a new one");
    const columns: Record<string, unknown> = {
      consumer_id: parent!["id"],
      type,
      enabled: body["enabled"] ?? true,
      expires_at: body["expires_at"] ?? null,
    };
    let reveal: Json | undefined;

    if (type === "key") {
      const supplied = clearSecret(body["key"], "/key");
      if (supplied !== undefined) {
        columns["key_hash"] = sha256(supplied);
        columns["key_prefix"] = supplied.slice(0, 8);
      } else if (!existing) {
        const generated = generateToken("apg_k_");
        columns["key_hash"] = sha256(generated);
        columns["key_prefix"] = generated.slice(0, 8);
        reveal = { key: generated };
      } // otherwise keep the stored key
    } else if (type === "basic") {
      columns["username"] = body["username"];
      const supplied = clearSecret(body["password"], "/password");
      if (supplied !== undefined) columns["password_hash"] = await argon2Hash(supplied, { algorithm: 2 /* Argon2id */ });
      else if (!existing) fail("/password", "password is required");
    } else {
      columns["identity"] = body["identity"];
    }
    return reveal ? { columns, reveal } : { columns };
  },

  // Hashes stay inside the database and the changelog; the API shows only what identifies the credential.
  toApi: (row) => ({
    id: row["id"],
    workspace_id: row["workspace_id"],
    consumer_id: row["consumer_id"],
    name: row["name"],
    type: row["type"],
    ...(row["type"] === "key" ? { key_prefix: row["key_prefix"] } : {}),
    ...(row["type"] === "basic" ? { username: row["username"] } : {}),
    ...(row["type"] === "mtls" ? { identity: row["identity"] } : {}),
    enabled: row["enabled"],
    ...(row["expires_at"] ? { expires_at: row["expires_at"] } : {}),
    ...tail(row, false),
  }),

  toEvent: (row) => ({
    name: row["name"],
    type: row["type"],
    consumer_id: row["consumer_id"],
    ...(row["type"] === "key" ? { key_hash: row["key_hash"] } : {}),
    ...(row["type"] === "basic" ? { username: row["username"], password_hash: row["password_hash"] } : {}),
    ...(row["type"] === "mtls" ? { identity: row["identity"] } : {}),
    enabled: row["enabled"],
    expires_at: row["expires_at"],
  }),
};

// ── Plugin ───────────────────────────────────────────────────────────────────

const MASK = "***";

/**
 * Replaces every `{ $secret: "clear" }` in a plugin config with
 * `{ $secret_ciphertext }`. A masked value (`"***"`, as the API returns it)
 * keeps whatever ciphertext is stored at the same place.
 */
function sealSecrets(value: unknown, previous: unknown, seal: (clear: string) => string, pointer: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => sealSecrets(v, Array.isArray(previous) ? previous[i] : undefined, seal, `${pointer}/${i}`));
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Json;
  if (typeof obj["$secret"] === "string" && Object.keys(obj).length === 1) {
    if (obj["$secret"] !== MASK) return { $secret_ciphertext: seal(obj["$secret"]) };
    const kept = (previous as Json | undefined)?.["$secret_ciphertext"];
    if (typeof kept !== "string") fail(pointer, "there is no stored secret here to keep; send the value");
    return { $secret_ciphertext: kept };
  }
  const prev = typeof previous === "object" && previous !== null ? (previous as Json) : {};
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sealSecrets(v, prev[k], seal, `${pointer}/${k}`)]));
}

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Json;
  if (typeof obj["$secret_ciphertext"] === "string") return { $secret: MASK };
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, maskSecrets(v)]));
}

/** URLs in a plugin config that make the gateway call out. Checked by the egress guard. */
function configUrls(config: Json): Array<{ pointer: string; url: string }> {
  return ["url", "jwks_url"].filter((k) => typeof config[k] === "string").map((k) => ({ pointer: `/config/${k}`, url: config[k] as string }));
}

const plugin: KindDef = {
  kind: "plugin",
  segment: "plugins",
  table: "apg_plugins",
  schema: "resources/plugin.json",
  readOnly: [],
  hasMetadata: true,
  defaultName: (body, id) => `${String(body["type"] ?? "plugin")}-${id.slice(-8)}`,

  async prepare({ store, tx, ws, existing, id, body, ctx }) {
    const type: string = body["type"];
    const configSchema = `plugins/${type}.json`;
    // Accepting a type whose configuration nothing enforces would break the
    // "everything documented is enforced" rule, so an unbuilt type is refused.
    if (!store.deps.schemas.has(configSchema)) fail("/type", `plugin type '${type}' is not available in this build`);

    const scope: string = body["scope"];
    if (scope === "global" && !ws["system"]) fail("/scope", "a global plugin belongs to the system workspace");
    if (body["target_workspace"] !== undefined && !ws["system"]) fail("/target_workspace", "only a plugin in the system workspace can target another workspace");

    if (!store.trusted(ctx)) {
      const allowed = await store.setting<string[] | null>(tx, "workspace_plugin_types", null);
      // Default: every type except wasm (spec PL-7).
      if (allowed ? !allowed.includes(type) : type === "wasm") fail("/type", `plugin type '${type}' may be created only by an admin`);
    }

    let serviceId: string | null = null;
    let routeId: string | null = null;
    if (scope === "service") serviceId = (await resolveRef(tx, "apg_services", ws, body["scope_ref"], "service", "/scope_ref"))["id"];
    if (scope === "route") routeId = (await resolveRef(tx, "apg_routes", ws, body["scope_ref"], "route", "/scope_ref"))["id"];
    const consumerId = body["consumer"] !== undefined ? (await resolveRef(tx, "apg_consumers", ws, body["consumer"], "consumer", "/consumer"))["id"] : null;

    let targetWorkspace: string | null = null;
    if (body["target_workspace"] !== undefined) {
      const ref: string = body["target_workspace"];
      const [target] = await tx<Row[]>`SELECT id FROM apg_workspaces WHERE ${isUuid(ref) ? tx`id = ${ref}` : tx`name = ${ref}`}`;
      if (!target) fail("/target_workspace", `workspace '${ref}' does not exist`);
      targetWorkspace = target!["id"];
    }

    const faults = store.deps.schemas.validate(configSchema, body["config"] ?? {});
    if (faults.length > 0) {
      throw new ApiError("VALIDATION_FAILED", `invalid ${type} configuration`, faults.map((f) => ({ pointer: `/config${f.pointer === "/" ? "" : f.pointer}`, message: f.message })));
    }
    let config = store.deps.schemas.withDefaults(configSchema, body["config"] ?? {}) as Json;

    if (!store.trusted(ctx)) {
      for (const { pointer, url } of configUrls(config)) {
        let host: string;
        try {
          host = new URL(url).hostname;
        } catch {
          return fail(pointer, "not a valid URL");
        }
        const reason = await egressViolation(host, store.deps.egressAllow, store.deps.resolve);
        if (reason) fail(pointer, reason, "EGRESS_NOT_ALLOWED");
      }
    }
    config = sealSecrets(config, existing?.["config"], (clear) => store.deps.box.seal(clear, `plugin:${id}`), "/config") as Json;

    return {
      columns: {
        type,
        scope,
        service_id: serviceId,
        route_id: routeId,
        consumer_id: consumerId,
        target_workspace: targetWorkspace,
        enabled: body["enabled"] ?? true,
        priority: body["priority"] ?? null,
        config: tx.json(config),
      },
    };
  },

  toApi: (row) => ({
    ...envelope(row),
    type: row["type"],
    scope: row["scope"],
    ...(row["service_id"] || row["route_id"] ? { scope_ref: row["service_id"] ?? row["route_id"] } : {}),
    ...(row["consumer_id"] ? { consumer: row["consumer_id"] } : {}),
    ...(row["target_workspace"] ? { target_workspace: row["target_workspace"] } : {}),
    enabled: row["enabled"],
    ...(row["priority"] !== null ? { priority: row["priority"] } : {}),
    config: maskSecrets(row["config"]),
    ...tail(row),
  }),

  // Nodes receive ciphertext for secrets, never clear text (spec CFG-6).
  toEvent: (row) => ({
    name: row["name"],
    type: row["type"],
    scope: row["scope"],
    service_id: row["service_id"],
    route_id: row["route_id"],
    consumer_id: row["consumer_id"],
    target_workspace: row["target_workspace"],
    enabled: row["enabled"],
    priority: row["priority"],
    config: row["config"],
  }),
};

/** Every workspace-scoped kind, by name. */
export const KINDS: Record<KindName, KindDef> = {
  domain,
  certificate,
  ca_certificate: caCertificate,
  service,
  route,
  consumer,
  credential,
  plugin,
};

/** Kinds in the order a snapshot must list them: referenced before referrer (spec CFG-3). */
export const SNAPSHOT_ORDER: KindName[] = ["ca_certificate", "certificate", "domain", "service", "route", "consumer", "credential", "plugin"];
