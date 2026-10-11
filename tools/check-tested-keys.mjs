#!/usr/bin/env node
// Every key is proven (spec TST-1): each configuration key of every plugin and
// each field of Service and Route must be exercised by at least one test, or
// be listed in schemas/unbuilt.yaml (where both loaders refuse it).
//
// This is what keeps "accepted but ignored" from creeping in: a key added to
// a schema with no test fails CI here.
//
// A key counts as exercised when a test file sets it: `key:` or `"key":` in a
// JavaScript or TypeScript test, or inside the test module of a Rust file.
// Keys that only ever hold other keys are judged by their children.
//
//   node tools/check-tested-keys.mjs            # exit 1 and a list when keys are untested
//   node tools/check-tested-keys.mjs --list     # print every key and where it is tested

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

function walk(dir, keep, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name === "dist" || name === "target" || name === "seed" || name === "seed-reference") continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, keep, out);
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

// ── What tests say ───────────────────────────────────────────────────────────

const corpus = [];
for (const file of [
  ...walk("tests", (f) => /\.(js|mjs|yaml)$/.test(f)),
  ...walk("admin/test", (f) => f.endsWith(".ts")),
  ...walk("admin/src", (f) => f.endsWith(".test.ts")),
  ...walk("cli", (f) => f.endsWith(".test.ts")),
  ...walk("ui/e2e", (f) => f.endsWith(".ts")),
]) corpus.push({ file, text: read(file) });
for (const file of walk("crates", (f) => f.endsWith(".rs"))) {
  const text = read(file);
  const at = text.indexOf("#[cfg(test)]");
  if (at >= 0) corpus.push({ file, text: text.slice(at) });
}

function testedIn(key) {
  // The key being set: `key:` (JavaScript, YAML), `"key":` (JSON, Rust json!).
  const pattern = new RegExp(`(?:^|[\\s{,(\\[])"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*:`, "m");
  return corpus.filter((c) => pattern.test(c.text)).map((c) => c.file);
}

// ── What the schemas offer ───────────────────────────────────────────────────

const BASE = "https://schemas.invalid/";
const cache = new Map();
const load = (file) => {
  if (!cache.has(file)) cache.set(file, json(`schemas/${file}`));
  return cache.get(file);
};
/** Follows `$ref`s. `file` is the schema file the reference is written in, relative to schemas/. */
const resolve = (schema, file) => {
  let s = schema;
  let at = file;
  for (let i = 0; i < 8 && typeof s?.$ref === "string"; i++) {
    const url = new URL(s.$ref, BASE + at);
    at = url.href.slice(BASE.length).split("#")[0];
    let doc = load(at);
    for (const part of url.hash.replace(/^#\/?/, "").split("/").filter(Boolean)) doc = doc?.[part];
    const { $ref: _r, ...siblings } = s;
    s = { ...doc, ...siblings };
  }
  return { schema: s ?? {}, file: at };
};

/** Leaf keys of an object schema, as dotted paths. A key with children is represented by them. */
function keys(schema, file, prefix = "", depth = 0) {
  const out = [];
  const { schema: s, file: at } = resolve(schema, file);
  const props = { ...(s.properties ?? {}) };
  for (const branch of [...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.allOf ?? [])]) Object.assign(props, resolve(branch, at).schema.properties ?? {});
  for (const [name, raw] of Object.entries(props)) {
    const p = resolve(raw, at);
    if (p.schema.readOnly === true) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const item = p.schema.type === "array" && p.schema.items ? resolve(p.schema.items, p.file) : null;
    const child = p.schema.properties ? p : item?.schema.properties ? item : null;
    if (child && depth < 3) out.push(...keys(child.schema, child.file, path, depth + 1));
    else out.push(path);
  }
  return out;
}

// schemas/unbuilt.yaml, read without a YAML library: sections, then `- { path: a.b, ... }` entries.
const unbuilt = new Set();
{
  let section = "";
  let plugin = "";
  for (const line of read("schemas/unbuilt.yaml").split("\n")) {
    const top = /^([a-z_]+):/.exec(line);
    const sub = /^  ([a-z_]+):/.exec(line);
    const entry = /^\s+-\s*\{\s*path:\s*([A-Za-z0-9_.]+)/.exec(line);
    if (top) { section = top[1]; plugin = ""; }
    else if (sub && section === "plugins") plugin = sub[1];
    else if (entry) unbuilt.add(`${section === "plugins" ? plugin : section}.${entry[1]}`);
  }
}
const isUnbuilt = (owner, path) => unbuilt.has(`${owner}.${path}`);

// Fields every resource shares, proven once by the admin's own suites.
const ENVELOPE = new Set(["id", "workspace_id", "name", "labels", "metadata", "revision", "created_at", "updated_at"]);

const subjects = [
  { owner: "service", file: "resources/service.json" },
  { owner: "route", file: "resources/route.json" },
  ...readdirSync(join(root, "schemas/plugins")).filter((f) => f.endsWith(".json")).sort().map((f) => ({ owner: f.replace(".json", ""), file: `plugins/${f}` })),
];

const rows = [];
for (const { owner, file } of subjects) {
  for (const path of keys(load(file), file)) {
    const leaf = path.split(".").pop();
    if (!path.includes(".") && ENVELOPE.has(leaf)) continue;
    // Nested plugin lists under a route or service are the plugin resource, checked on its own.
    if ((owner === "service" || owner === "route") && path.startsWith("plugins.")) continue;
    const where = testedIn(leaf);
    rows.push({ owner, path, where, unbuilt: isUnbuilt(owner, path) });
  }
}

const untested = rows.filter((r) => r.where.length === 0 && !r.unbuilt);
if (process.argv.includes("--list")) {
  for (const r of rows) console.log(`${r.owner}.${r.path}\t${r.unbuilt ? "(refused: not built)" : r.where.length === 0 ? "UNTESTED" : relative(root, join(root, r.where[0]))}`);
}
const refused = rows.filter((r) => r.unbuilt).length;
console.log(`${rows.length} keys across ${subjects.length} schemas: ${rows.length - refused - untested.length} set by a test, ${refused} refused as not built, ${untested.length} untested`);
if (untested.length > 0) {
  console.log("\nNo test sets these keys. Add a test that shows the key changes behaviour, or list it in schemas/unbuilt.yaml:");
  for (const r of untested) console.log(`  ${r.owner}.${r.path}`);
  process.exit(1);
}
