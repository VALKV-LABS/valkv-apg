/**
 * Builds the OpenAPI 3.1 document for the Admin API (spec API-1).
 *
 * The paths come from the endpoint descriptions collected while routes are
 * registered, and the component schemas are the JSON Schemas in `schemas/`,
 * so the document cannot describe an endpoint or a field that does not exist.
 * The committed copy is `admin/openapi.json`; a test fails when it is stale.
 */

import type { EndpointDoc } from "./routes/api.js";
import type { SchemaRegistry } from "./schemas.js";
import { ERROR_STATUS } from "./errors.js";

type Json = Record<string, any>;

const BASE = "https://valkv-apg.dev/schemas/";

/** `resources/ca-certificate.json` → `CaCertificate`; `common.json` → `Common`. */
function componentName(path: string): string {
  const base = path.replace(/^.*\//, "").replace(/\.json$/, "");
  const name = base.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return path.startsWith("plugins/") ? `PluginConfig${name}` : name;
}

/** Rewrites `$ref`s between schema files into references between components. */
function rewriteRefs(node: unknown, fromPath: string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, fromPath));
  if (typeof node !== "object" || node === null) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$id" || key === "$schema") continue;
    if (key === "$ref" && typeof value === "string") {
      if (value.startsWith("#")) {
        out[key] = `#/components/schemas/${componentName(fromPath)}${value.slice(1)}`;
      } else {
        const resolved = new URL(value, BASE + fromPath);
        const target = resolved.href.slice(BASE.length).split("#")[0]!;
        out[key] = `#/components/schemas/${componentName(target)}${resolved.hash ? resolved.hash.slice(1) : ""}`;
      }
      continue;
    }
    out[key] = rewriteRefs(value, fromPath);
  }
  return out;
}

const errorResponse = (description: string): Json => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** Builds the document. Deterministic: same endpoints and schemas give byte-identical JSON. */
export function buildOpenApi(endpoints: readonly EndpointDoc[], schemas: SchemaRegistry, version: string): Json {
  const components: Json = {};
  for (const path of [...schemas.list()].sort()) {
    if (path === "changelog-event.json") continue; // data-plane contract, documented separately
    components[componentName(path)] = rewriteRefs(schemas.validator(path).schema, path);
  }
  components["Error"] = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { enum: Object.keys(ERROR_STATUS).sort() },
          message: { type: "string" },
          request_id: { type: "string" },
          details: { type: "array", items: { type: "object", required: ["pointer", "message"], properties: { pointer: { type: "string" }, message: { type: "string" } } } },
        },
      },
    },
  };

  const paths: Json = {};
  const sorted = [...endpoints].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const e of sorted) {
    const params = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
      description: m[1] === "ws" ? "Workspace id or name" : "Id or name",
    }));
    const query: Json[] = [];
    if (e.list) {
      query.push(
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
        { name: "name", in: "query", schema: { type: "string" } },
        { name: "label", in: "query", schema: { type: "string" }, description: "key=value" },
      );
    }
    if (e.method !== "get") query.push({ name: "dry_run", in: "query", schema: { type: "boolean" }, description: "Validate and return the result without writing" });
    if (e.method === "delete") query.push({ name: "cascade", in: "query", schema: { type: "boolean" }, description: "Also delete resources that reference this one" });

    const ref = e.response ? { $ref: `#/components/schemas/${componentName(e.response)}` } : { type: "object" };
    const okSchema = e.list ? { type: "object", required: ["data"], properties: { data: { type: "array", items: ref }, next_cursor: { type: ["string", "null"] } } } : ref;
    const op: Json = {
      operationId: `${e.method}_${e.path.replace(/^\/v1\//, "").replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")}`,
      summary: e.summary,
      tags: [e.tag],
      description: `Minimum role: ${e.roles}.`,
      parameters: [...params, ...query],
      responses: {
        [String(e.success)]: e.success === 204 ? { description: "Done" } : { description: "Success", content: { "application/json": { schema: okSchema } } },
        "400": errorResponse("Malformed request"),
        "401": errorResponse("Missing or invalid credentials"),
        "403": errorResponse("The caller's role does not allow this"),
        "404": errorResponse("Not found, or outside the caller's scope"),
        "429": errorResponse("Too many requests"),
      },
    };
    if (e.method !== "get") {
      op["responses"]["409"] = errorResponse("Conflict, or the resource is in use");
      op["responses"]["412"] = errorResponse("If-Match did not match the current revision");
      op["responses"]["422"] = errorResponse("Validation failed");
    }
    if (e.body) op["requestBody"] = { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${componentName(e.body)}` } } } };
    (paths[e.path] ??= {})[e.method] = op;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "valkv-apg Admin API",
      version,
      description: "Manage workspaces, domains, certificates, services, routes, plugins and consumers of a valkv-apg gateway.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }],
    tags: [...new Set(sorted.map((e) => e.tag))].sort().map((name) => ({ name })),
    paths,
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas: components },
  };
}
