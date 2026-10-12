#!/usr/bin/env node
// Pulls every configuration example out of the documentation so that it can
// be checked (spec DOC-3): a fenced `yaml` block whose first line is
// `version: 1` is a complete apg.yaml, and must be accepted by the gateway.
//
//   node tools/extract-doc-examples.mjs <out-dir>
//
// Writes one file per example and prints how many. A block preceded by a line
// `<!-- no-validate: reason -->` is skipped; the reason is required.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error("usage: extract-doc-examples.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

function markdown(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "book" || name === "target" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdown(path, found);
    else if (name.endsWith(".md")) found.push(path);
  }
  return found;
}

// Generated plugin pages repeat their fragments; the fragments are the source.
const files = [join(root, "README.md"), join(root, "cli/README.md"), ...markdown(join(root, "docs")).filter((f) => !f.replace(/\\/g, "/").includes("/docs/src/reference/plugins/"))];
let count = 0;
let skipped = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```yaml" || lines[i + 1]?.trim() !== "version: 1") continue;
    const end = lines.indexOf("```", i + 1);
    if (/^<!-- no-validate: \S/.test(lines[i - 1] ?? "")) {
      skipped++;
      continue;
    }
    const name = `${relative(root, file).replace(/[\\/]/g, "__").replace(/\.md$/, "")}__line${i + 1}.yaml`;
    writeFileSync(join(out, name), lines.slice(i + 1, end).join("\n") + "\n");
    count++;
  }
}
// The files under examples/ are whole configurations already.
for (const name of readdirSync(join(root, "examples")).filter((f) => f.endsWith(".yaml"))) {
  writeFileSync(join(out, `examples__${name}`), readFileSync(join(root, "examples", name), "utf8"));
  count++;
}
console.log(`${count} examples extracted from ${files.length} files, ${skipped} marked no-validate`);
if (count === 0) process.exit(1);
