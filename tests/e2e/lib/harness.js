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
const ADMIN_URL = process.env.ADMIN_URL ?? "http://admin:9000";

export async function http(method, url, { headers = {}, body } = {}) {
  const send = () => fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let res = await send();
  // The Admin API limits each caller's rate and says when to come back. Every
  // suite shares one token, so on a fast machine they reach the limit; they
  // wait as any client should. A 429 from a node is a plugin's answer and is
  // what a test is looking for, so it is never retried.
  for (let tries = 0; res.status === 429 && url.startsWith(ADMIN_URL) && tries < 30; tries++) {
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, Math.min(1000, (Number(res.headers.get("retry-after")) || 1) * 250)));
    res = await send();
  }
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
