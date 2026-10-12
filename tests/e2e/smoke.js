// Smoke suite: the stack `make up` starts is actually serving.
// Grows into the per-feature suites of spec §21 as each phase lands.

import { assert, http, step } from "./lib/harness.js";

const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
const ECHO = process.env.ECHO_URL ?? "http://echo:8080";
const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

step("admin is live", async () => {
  const res = await http("GET", `${ADMIN}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });
});

step("admin is ready, which proves it reaches Postgres", async () => {
  const res = await http("GET", `${ADMIN}/readyz`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ready" });
});

step("unknown admin path answers in the standard error shape with a request id", async () => {
  const res = await http("GET", `${ADMIN}/v1/does-not-exist`, { headers: { ...admin, "x-request-id": "smoke-1" } });
  assert.equal(res.status, 404);
  assert.equal(res.json?.error?.code, "NOT_FOUND");
  assert.equal(res.json?.error?.request_id, "smoke-1");
  assert.equal(res.headers.get("x-request-id"), "smoke-1");
});

step("malformed JSON to the admin is a 400, not a 500", async () => {
  const res = await http("POST", `${ADMIN}/v1/workspaces`, { headers: admin, body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal(res.json?.error?.code, "BAD_REQUEST");
});

step("the sample upstream echoes what it receives", async () => {
  const res = await http("GET", `${ECHO}/hello?x=1`, { headers: { "x-probe": "abc" } });
  assert.equal(res.status, 200);
  assert.equal(res.json?.path, "/hello");
  assert.equal(res.json?.headers?.["x-probe"], "abc");
});
