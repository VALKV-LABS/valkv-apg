#!/usr/bin/env node
// Every relative link in the documentation points at a file that exists, every
// `#anchor` at a heading that exists, and every page is in the table of contents.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "docs", "src");

function pages(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, found);
    else if (name.endsWith(".md")) found.push(path);
  }
  return found;
}

/** The anchor mdBook gives a heading. */
const anchor = (heading) => heading.trim().toLowerCase().replace(/`/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");
const anchors = (file) => new Set(readFileSync(file, "utf8").split(/\r?\n/).filter((l) => /^#{1,6} /.test(l)).map((l) => anchor(l.replace(/^#+ /, ""))));

const problems = [];
const all = pages(src);
const files = [...all, join(root, "README.md"), join(root, "cli", "README.md"), join(root, "deploy", "lightsail", "README.md"), join(root, "deploy", "terraform", "aws", "README.md")];
for (const file of files) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, hash] = target.split("#");
    const to = path === "" ? file : resolve(dirname(file), path);
    if (!existsSync(to)) problems.push(`${relative(root, file)}: link to ${target}, which does not exist`);
    else if (hash && to.endsWith(".md") && !anchors(to).has(hash)) problems.push(`${relative(root, file)}: link to ${target}, but that page has no such heading`);
  }
}

const summary = readFileSync(join(src, "SUMMARY.md"), "utf8");
for (const page of all) {
  const rel = relative(src, page).replace(/\\/g, "/");
  if (rel !== "SUMMARY.md" && !summary.includes(`(${rel})`)) problems.push(`docs/src/${rel} is not in SUMMARY.md`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${files.length} files checked: every link resolves and every page is in the table of contents`);
