// Minimal end-to-end harness: named steps, run in order, first failure reported
// with its name, non-zero exit if any step failed. No dependencies.

import assert from "node:assert/strict";

const steps = [];

/** Registers one named check. */
export function step(name, fn) {
  steps.push({ name, fn });
}

/** Runs every registered step. Returns the number that failed. */
export async function run(suite) {
  let failed = 0;
  console.log(`\n── ${suite} (${steps.length} steps) ──`);
  for (const { name, fn } of steps.splice(0)) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${String(err?.message ?? err).split("\n").join("\n        ")}`);
    }
  }
  return failed;
}

/** fetch that never throws on HTTP status and always returns parsed JSON when there is any. */
export async function http(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export { assert };
