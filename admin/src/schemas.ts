/**
 * Loads the JSON Schemas in `schemas/` (the single source of truth for every
 * resource, the changelog event and apg.yaml) and exposes validators.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { ErrorDetail } from "./errors.js";

const BASE = "https://valkv-apg.dev/schemas/";

// ajv-formats ships CommonJS; under NodeNext the callable is on `.default`.
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

/** Where the schemas live: `APG_SCHEMAS_DIR`, or `schemas/` at the repository root. */
export function defaultSchemasDir(): string {
  return process.env["APG_SCHEMAS_DIR"] ?? fileURLToPath(new URL("../../schemas/", import.meta.url));
}

/** A set of compiled schemas, addressed by path relative to `schemas/` (for example `resources/route.json`). */
export class SchemaRegistry {
  private readonly ajv: InstanceType<typeof Ajv2020>;
  private readonly filler: InstanceType<typeof Ajv2020>;
  private readonly ids: string[] = [];

  constructor(dir: string = defaultSchemasDir()) {
    // `x-apg-secret` marks secret-typed fields (spec §9.6); it is an annotation, not a constraint.
    // Unknown keywords stay an error (they are usually typos). `strictRequired` and
    // `strictTypes` are off because conditional sub-schemas (if/then/not) legitimately
    // name properties and keywords whose type is declared by the parent schema.
    this.ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictRequired: false,
      strictTypes: false,
      allowUnionTypes: true,
      keywords: ["x-apg-secret"],
    });
    (addFormats as unknown as (a: unknown) => void)(this.ajv);
    // A second instance fills in schema defaults. It is separate so that plain
    // validation never mutates what it is given.
    this.filler = new Ajv2020({
      allErrors: true,
      strict: false,
      useDefaults: true,
      allowUnionTypes: true,
      keywords: ["x-apg-secret"],
    });
    (addFormats as unknown as (a: unknown) => void)(this.filler);
    for (const file of listJson(dir)) {
      const schema = JSON.parse(readFileSync(join(dir, file), "utf8")) as { $id?: string };
      const expected = BASE + file;
      if (schema.$id !== expected) {
        throw new Error(`schema ${file} has $id '${schema.$id ?? ""}', expected '${expected}'`);
      }
      this.ajv.addSchema(schema);
      this.filler.addSchema(schema);
      this.ids.push(file);
    }
    // Compile everything now so a broken $ref fails at start, not on first use.
    for (const id of this.ids) this.validator(id);
  }

  /** Paths of every loaded schema. */
  list(): readonly string[] {
    return this.ids;
  }

  /** The compiled validator for one schema. Throws if it is unknown or does not compile. */
  validator(path: string): ValidateFunction {
    const fn = this.ajv.getSchema(BASE + path);
    if (!fn) throw new Error(`unknown schema '${path}'`);
    return fn;
  }

  /** True when a schema with this path is loaded. */
  has(path: string): boolean {
    return this.ids.includes(path);
  }

  /**
   * Returns a deep copy of `value` with schema defaults filled in (the normal
   * form of spec DEC-5). Call only on a value that already validates.
   */
  withDefaults<T>(path: string, value: T): T {
    const fn = this.filler.getSchema(BASE + path);
    if (!fn) throw new Error(`unknown schema '${path}'`);
    const copy = structuredClone(value);
    fn(copy);
    return copy;
  }

  /** Validates a value. Returns the faults, each located by JSON pointer; empty means valid. */
  validate(path: string, value: unknown): ErrorDetail[] {
    const fn = this.validator(path);
    if (fn(value)) return [];
    return (fn.errors ?? []).map(toDetail);
  }
}

function toDetail(e: ErrorObject): ErrorDetail {
  const extra =
    e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties"
      ? ` '${String((e.params as Record<string, unknown>)["additionalProperty"] ?? (e.params as Record<string, unknown>)["unevaluatedProperty"])}'`
      : "";
  return { pointer: e.instancePath || "/", message: `${e.message ?? "invalid"}${extra}` };
}

function listJson(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listJson(dir, rel));
    else if (name.endsWith(".json")) out.push(rel);
  }
  return out;
}
