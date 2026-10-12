#!/usr/bin/env node
/** Entry point of `apgctl`. Everything it does is in `run.ts`. */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { run } from "./run.js";

const code = await run(process.argv.slice(2), {
  env: process.env,
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  stdin: () => readFileSync(0, "utf8"),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  },
});
process.exitCode = code;
