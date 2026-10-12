/**
 * Reading `apg.yaml` documents (spec §14.1): environment substitution,
 * several files, and the checks that need no server.
 *
 * Substitution and merging follow the node's own loader rule for rule, so a
 * set of files means the same thing in file mode and in database mode.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";
import yaml from "js-yaml";
import { CliError } from "./args.js";

export type Json = Record<string, any>;

/** One problem in a document. `warning` problems do not fail validation. */
export interface Problem {
  pointer: string;
  message: string;
  warning?: boolean;
}

const LIST_SECTIONS = ["domains", "certificates", "ca_certificates", "services", "routes", "consumers", "plugins", "workspaces"];

/**
 * Replaces `${VAR}` and `${VAR:-default}`. An unset variable with no default
 * is an error, reported with its line (spec DEC-2). Anything that is not a
 * variable name between the braces is left as written.
 */
export function substituteEnv(source: string, env: Record<string, string | undefined>, file = ""): string {
  const problems: string[] = [];
  const out = source.replace(/\$\{([^}]*)\}/g, (whole, inner: string, offset: number) => {
    const i = inner.indexOf(":-");
    const name = i < 0 ? inner : inner.slice(0, i);
    if (!/^[A-Za-z0-9_]+$/.test(name)) return whole;
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (i >= 0) return inner.slice(i + 2);
    const line = source.slice(0, offset).split("\n").length;
    problems.push(`${file ? `${file}: ` : ""}line ${line}: environment variable ${name} is not set and has no default`);
    return "";
  });
  if (problems.length > 0) throw new CliError(problems.join("\n"));
  return out;
}

/** Parses several sources and merges them into one document (spec DEC-3). */
export function parseAndMerge(sources: Array<{ name: string; text: string }>): Json {
  const merged: Json = {};
  const problems: string[] = [];
  for (const { name, text } of sources) {
    let doc: unknown;
    try {
      doc = yaml.load(text);
    } catch (err) {
      problems.push(`${name}: not valid YAML: ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      problems.push(`${name}: the document must be a mapping`);
      continue;
    }
    for (const [key, value] of Object.entries(doc as Json)) {
      const have = merged[key];
      if (have === undefined) merged[key] = value;
      else if (LIST_SECTIONS.includes(key) && Array.isArray(have)) {
        if (Array.isArray(value)) have.push(...value);
        else problems.push(`${name}: ${key} must be a list`);
      } else if ((key === "settings" || key === "flags") && typeof have === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) problems.push(`${name}: ${key} must be a mapping`);
        else {
          for (const [k, v] of Object.entries(value as Json)) {
            if (k in have) problems.push(`${name}: ${key}.${k} is defined in more than one file`);
            have[k] = v;
          }
        }
      } else if (JSON.stringify(have) !== JSON.stringify(value)) problems.push(`${name}: ${key} conflicts with another file`);
    }
  }
  if (problems.length > 0) throw new CliError(problems.join("\n"));
  return merged;
}

/** Expands `-f` arguments: a file, a directory of `.yaml`/`.yml`/`.json` files, or `-` for standard input. */
export function loadDocument(paths: string[], env: Record<string, string | undefined>, stdin: () => string): Json {
  if (paths.length === 0) throw new CliError("give at least one document with -f <file or directory>");
  const sources: Array<{ name: string; text: string }> = [];
  for (const path of paths) {
    if (path === "-") {
      sources.push({ name: "standard input", text: stdin() });
      continue;
    }
    if (!existsSync(path)) throw new CliError(`${path}: no such file or directory`);
    const files = statSync(path).isDirectory()
      ? readdirSync(path).filter((f) => /\.(ya?ml|json)$/.test(f)).sort().map((f) => join(path, f))
      : [path];
    if (files.length === 0) throw new CliError(`${path}: the directory holds no .yaml, .yml or .json file`);
    for (const file of files) sources.push({ name: file, text: readFileSync(file, "utf8") });
  }
  return parseAndMerge(sources.map((s) => ({ name: s.name, text: substituteEnv(s.text, env, s.name) })));
}

// ── Offline validation ───────────────────────────────────────────────────────

const BASE = "https://valkv-apg.dev/schemas/";
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

/** Where the bundled schemas are: `APG_SCHEMAS_DIR`, the package, or the repository. */
export function schemasDir(env: Record<string, string | undefined>): string {
  const candidates = [env["APG_SCHEMAS_DIR"], fileURLToPath(new URL("../schemas/", import.meta.url)), fileURLToPath(new URL("../../schemas/", import.meta.url))];
  const found = candidates.find((d) => d && existsSync(join(d, "apg-config.json")));
  if (!found) throw new CliError("the bundled schemas are missing; set APG_SCHEMAS_DIR to the schemas directory");
  return found;
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

function detail(e: ErrorObject, prefix = ""): Problem {
  const p = e.params as Record<string, unknown>;
  const extra = e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties" ? ` '${String(p["additionalProperty"] ?? p["unevaluatedProperty"])}'` : "";
  return { pointer: `${prefix}${e.instancePath}` || "/", message: `${e.message ?? "invalid"}${extra}` };
}

/**
 * Checks a document without a server: its shape against the schemas the node
 * and the admin use, each plugin's configuration, duplicate names, and
 * references between resources. A reference to something the document does
 * not define is a warning, because it may already exist in the workspace.
 */
export function validateOffline(doc: Json, dir: string): Problem[] {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, allowUnionTypes: true, keywords: ["x-apg-secret"] });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  const files = listJson(dir);
  for (const file of files) ajv.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")));

  const problems: Problem[] = [];
  const root = ajv.getSchema(`${BASE}apg-config.json`)!;
  if (!root(doc)) {
    const seen = new Set<string>();
    for (const p of (root.errors ?? []).map((e) => detail(e))) {
      const key = `${p.pointer}|${p.message}`;
      if (!seen.has(key)) problems.push(p);
      seen.add(key);
    }
    return problems; // the rest assumes the shape is right
  }

  const part = (at: string, body: Json) => {
    const names = (section: string) => new Set(((body[section] ?? []) as Json[]).map((r) => r["name"]).filter(Boolean));
    const defined = { services: names("services"), routes: names("routes"), consumers: names("consumers"), certificates: names("certificates"), ca_certificates: names("ca_certificates") };
    const missing = (pointer: string, kind: string, ref: unknown, set: Set<string>) => {
      if (typeof ref === "string" && !set.has(ref)) problems.push({ pointer, message: `${kind} '${ref}' is not defined in this document; it must already exist in the workspace`, warning: true });
    };
    for (const section of ["domains", "certificates", "ca_certificates", "services", "routes", "consumers"]) {
      const seen = new Set<string>();
      for (const [i, r] of ((body[section] ?? []) as Json[]).entries()) {
        const key = r["name"] ?? r["hostname"];
        if (key !== undefined && seen.has(key)) problems.push({ pointer: `${at}/${section}/${i}`, message: `'${key}' is defined more than once` });
        seen.add(key);
      }
    }
    const plugin = (pointer: string, p: Json) => {
      const schema = ajv.getSchema(`${BASE}plugins/${p["type"]}.json`);
      if (!schema) problems.push({ pointer: `${pointer}/type`, message: `plugin type '${p["type"]}' is not available in this build` });
      else if (!schema(p["config"] ?? {})) problems.push(...(schema.errors ?? []).map((e) => detail(e, `${pointer}/config`)));
      missing(`${pointer}/consumer`, "consumer", p["consumer"], defined.consumers);
    };
    for (const [i, d] of ((body["domains"] ?? []) as Json[]).entries()) missing(`${at}/domains/${i}/tls/certificate`, "certificate", d["tls"]?.["certificate"], defined.certificates);
    for (const [i, s] of ((body["services"] ?? []) as Json[]).entries()) {
      for (const [j, ca] of ((s["tls"]?.["ca_certificates"] ?? []) as unknown[]).entries()) missing(`${at}/services/${i}/tls/ca_certificates/${j}`, "CA certificate", ca, defined.ca_certificates);
      missing(`${at}/services/${i}/tls/client_certificate`, "certificate", s["tls"]?.["client_certificate"], defined.certificates);
      for (const [j, p] of ((s["plugins"] ?? []) as Json[]).entries()) plugin(`${at}/services/${i}/plugins/${j}`, p);
    }
    for (const [i, r] of ((body["routes"] ?? []) as Json[]).entries()) {
      missing(`${at}/routes/${i}/service`, "service", r["service"], defined.services);
      for (const [j, s] of ((r["split"] ?? []) as Json[]).entries()) missing(`${at}/routes/${i}/split/${j}/service`, "service", s["service"], defined.services);
      for (const [j, p] of ((r["plugins"] ?? []) as Json[]).entries()) plugin(`${at}/routes/${i}/plugins/${j}`, p);
    }
    for (const [i, p] of ((body["plugins"] ?? []) as Json[]).entries()) {
      plugin(`${at}/plugins/${i}`, p);
      if (p["scope"] === "service") missing(`${at}/plugins/${i}/scope_ref`, "service", p["scope_ref"], defined.services);
      if (p["scope"] === "route") missing(`${at}/plugins/${i}/scope_ref`, "route", p["scope_ref"], defined.routes);
    }
  };
  part("", doc);
  for (const [i, w] of ((doc["workspaces"] ?? []) as Json[]).entries()) part(`/workspaces/${i}`, w);
  return problems;
}
