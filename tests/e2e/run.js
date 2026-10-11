// Entry point for `make integ` / `make e2e`. Each suite registers its steps on
// import; suites are added here as build phases land.
//
// MODE picks the stack under test:
//   file      a standalone node (deploy/compose/standalone.yml)
//   api_poll  control plane and nodes (deploy/compose/database.yml)
//
// SUITE, when set, runs only the named suites, comma-separated (used by the
// resilience script, which stops and starts containers between suites).

import { run } from "./lib/harness.js";

const mode = process.env.MODE ?? "api_poll";
const all = {
  file: [
    ["routing", "./routing.js"],
    ["upstream", "./upstream.js"],
    ["tls", "./tls.js"],
    ["plugins", "./plugins.js"],
    ["usage", "./usage.js"],
  ],
  api_poll: [
    ["smoke", "./smoke.js"],
    ["control-plane", "./control-plane.js"],
    ["routing", "./routing.js"],
    ["upstream", "./upstream.js"],
    ["tls", "./tls.js"],
    ["plugins", "./plugins.js"],
    ["usage", "./usage.js"],
  ],
}[mode];

if (!all) {
  console.error(`no end-to-end suites exist for MODE=${mode} yet`);
  process.exit(2);
}

const only = process.env.SUITE;
const suites = only ? only.split(",").map((name) => [name, `./${name}.js`]) : all;

let failed = 0;
for (const [name, path] of suites) {
  await import(path);
  failed += await run(`${name} [mode=${mode}]`);
}

console.log(failed === 0 ? "\nall suites passed" : `\n${failed} step(s) failed`);
process.exit(failed === 0 ? 0 : 1);
