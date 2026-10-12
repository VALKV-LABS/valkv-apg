#!/usr/bin/env node
// Requirement traceability (spec TST-3), for maintainers: for every requirement
// id in the specification, where the code names it and which tests name it.
// The specification is not part of the published tree; without it this prints
// a note and exits.
//
//   node tools/trace-requirements.mjs            # a Markdown table on standard output
//
// An id counts as implemented where a non-test source file mentions it, and
// as tested where a test file does. Ids nobody mentions are listed at the end:
// they are either untested, or tested by something that does not say so.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "spec.md"))) {
  console.log("spec.md is not present; nothing to trace.");
  process.exit(0);
}

const spec = readFileSync(join(root, "spec.md"), "utf8");
const requirements = new Map();
for (const m of spec.matchAll(/^- \*\*([A-Z]{2,4}-\d+[a-z]?)(?: ([^*]+?))?\.?\*\*\s*(.*)$/gm)) {
  if (!requirements.has(m[1])) requirements.set(m[1], (m[2] ?? m[3]).replace(/\*\*|`/g, "").slice(0, 70).trim());
}

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (["node_modules", "dist", "target", "book", "seed", "seed-reference", ".git"].includes(name)) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(rs|ts|tsx|js|mjs|sh|sql|yaml|yml|tf|json)$/.test(name) && !/package-lock|openapi\.json/.test(name)) out.push(rel);
  }
  return out;
}

const isTest = (f) => /(^tests\/|\/test\/|\.test\.tsx?$|^ui\/e2e\/)/.test(f);
const mentions = new Map(); // id -> { code: Set, tests: Set }
const note = (id, file, test) => {
  if (!requirements.has(id)) return;
  const e = mentions.get(id) ?? { code: new Set(), tests: new Set() };
  (test ? e.tests : e.code).add(file);
  mentions.set(id, e);
};
for (const file of ["crates", "admin", "cli", "ui", "tests", "deploy", "schemas", "tools"].flatMap((d) => walk(d))) {
  const text = readFileSync(join(root, file), "utf8");
  if (file.endsWith(".rs")) {
    // A Rust file holds its unit tests after #[cfg(test)].
    const at = text.indexOf("#[cfg(test)]");
    for (const [part, test] of [[at < 0 ? text : text.slice(0, at), false], [at < 0 ? "" : text.slice(at), true]]) {
      for (const m of part.matchAll(/\b([A-Z]{2,4}-\d+[a-z]?)\b/g)) note(m[1], file, test);
    }
  } else {
    for (const m of text.matchAll(/\b([A-Z]{2,4}-\d+[a-z]?)\b/g)) note(m[1], file, isTest(file));
  }
}

const short = (set) => [...set].sort().slice(0, 3).map((f) => `\`${f.replace(/^crates\/apg-/, "").replace(/\/src\//, "/")}\``).join(", ") + (set.size > 3 ? ` +${set.size - 3}` : "");
const rows = [...requirements.keys()];
const both = rows.filter((id) => mentions.get(id)?.code.size && mentions.get(id)?.tests.size);
const codeOnly = rows.filter((id) => mentions.get(id)?.code.size && !mentions.get(id)?.tests.size);
const testOnly = rows.filter((id) => !mentions.get(id)?.code.size && mentions.get(id)?.tests.size);
const neither = rows.filter((id) => !mentions.has(id));

console.log(`${rows.length} requirement ids in the specification: ${both.length} named in code and in a test, ${testOnly.length} in a test only, ${codeOnly.length} in code only, ${neither.length} named nowhere.\n`);
console.log("| Requirement | About | Code | Tests |\n|---|---|---|---|");
for (const id of rows.filter((x) => mentions.has(x))) {
  const e = mentions.get(id);
  console.log(`| ${id} | ${requirements.get(id).replace(/\|/g, "/")} | ${short(e.code)} | ${short(e.tests)} |`);
}
console.log(`\n**Named in code but in no test:** ${codeOnly.join(", ") || "none"}\n`);
console.log(`**Named nowhere in code or tests** (covered implicitly, by documentation or process, or not built): ${neither.join(", ") || "none"}`);
