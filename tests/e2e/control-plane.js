// Control plane, end to end over real HTTP against the running stack: what an
// operator's script and a node's config client would actually do.

import { assert, http, step } from "./lib/harness.js";

const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const node = { authorization: `Bearer ${process.env.NODE_TOKEN}` };
const run = Date.now().toString(36); // keeps reruns against a live stack from colliding
const D = `${ADMIN}/v1/workspaces/default`;

let startSeq = 0;
let serviceId;

step("the Admin API refuses a caller with no token", async () => {
  assert.equal((await http("GET", `${ADMIN}/v1/workspaces`)).status, 401);
});

step("the bootstrap admin token works and sees the system workspace", async () => {
  const res = await http("GET", `${ADMIN}/v1/workspaces`, { headers: admin });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.some((w) => w.name === "default" && w.system === true));
});

step("a node token reads the config contract but not the Admin API", async () => {
  assert.equal((await http("GET", `${ADMIN}/v1/workspaces`, { headers: node })).status, 403);
  const snap = await http("GET", `${ADMIN}/dp/snapshot`, { headers: node });
  assert.equal(snap.status, 200);
  const header = JSON.parse(snap.text.split("\n")[0]);
  assert.match(header.cluster_id, /^[0-9a-f-]{36}$/);
  startSeq = header.seq;
});

step("creating a service and a route is visible to a polling node, in order", async () => {
  const svc = await http("PUT", `${D}/services/e2e-${run}`, { headers: admin, body: { backends: [{ target: "echo:8080" }] } });
  assert.equal(svc.status, 200, svc.text);
  serviceId = svc.json.id;
  const route = await http("PUT", `${D}/routes/e2e-${run}`, { headers: admin, body: { service: `e2e-${run}`, hosts: [`${run}.e2e.example.com`], paths: ["/"] } });
  assert.equal(route.status, 200, route.text);

  const res = await http("GET", `${ADMIN}/dp/changes?since=${startSeq}`, { headers: node });
  assert.equal(res.status, 200);
  const kinds = res.json.changes.map((c) => `${c.data.kind}:${c.data.op}`);
  assert.deepEqual(kinds, ["service:upsert", "route:upsert"]);
  assert.equal(res.json.changes[1].data.data.service, serviceId);
});

step("a long poll wakes when a change commits", async () => {
  const since = (await http("GET", `${ADMIN}/dp/changes?since=${startSeq}`, { headers: node })).json.last_seq;
  const started = Date.now();
  const pending = http("GET", `${ADMIN}/dp/changes?since=${since}&wait_ms=15000`, { headers: node });
  await new Promise((r) => setTimeout(r, 300));
  await http("PUT", `${ADMIN}/v1/flags/access_log`, { headers: admin, body: { enabled: true } });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.json.changes[0].data.kind, "flag");
  assert.ok(Date.now() - started < 8000, "returned promptly");
});

step("an invalid document is rejected with a pointer and changes nothing", async () => {
  const before = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.last_seq;
  const res = await http("POST", `${D}/routes`, { headers: admin, body: { name: `bad-${run}`, service: `e2e-${run}`, strip_prefix: true } });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, "VALIDATION_FAILED");
  assert.ok(JSON.stringify(res.json.error.details).includes("strip_prefix"));
  assert.equal((await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.last_seq, before);
});

// Issue #14: list endpoints filter by label.
step("routes and services are listed by label", async () => {
  const labels = { "valkv-name": `portal-${run}` };
  assert.equal((await http("PATCH", `${D}/routes/e2e-${run}`, { headers: admin, body: { labels } })).status, 200);
  assert.equal((await http("PATCH", `${D}/services/e2e-${run}`, { headers: admin, body: { labels } })).status, 200);
  const routes = await http("GET", `${D}/routes?label=valkv-name=portal-${run}`, { headers: admin });
  assert.deepEqual(routes.json.data.map((r) => [r.name, r.labels]), [[`e2e-${run}`, labels]]);
  const services = await http("GET", `${D}/services?label=valkv-name=portal-${run}`, { headers: admin });
  assert.deepEqual(services.json.data.map((s) => s.name), [`e2e-${run}`]);
  assert.deepEqual((await http("GET", `${D}/routes?label=valkv-name=nobody-${run}`, { headers: admin })).json.data, []);
});

step("a heartbeat makes the node visible with its lag", async () => {
  const last = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.last_seq;
  const hb = await http("POST", `${ADMIN}/dp/heartbeat`, { headers: node, body: { node_id: `e2e-${run}`, version: "test", source: "api_poll", applied_seq: last - 1 } });
  assert.equal(hb.status, 204);
  const nodes = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.data;
  const me = nodes.find((n) => n.node_id === `e2e-${run}`);
  assert.equal(me.lag, 1);
  assert.equal(me.live, true);
});

// Issue #13: a node that is gone for good can be removed; a live one cannot.
// The node beats once here and then stays silent, as a terminated instance would.
let goneAt = 0;
step("a live node cannot be removed", async () => {
  const hb = await http("POST", `${ADMIN}/dp/heartbeat`, { headers: node, body: { node_id: `gone-${run}`, version: "test", source: "api_poll", applied_seq: 0 } });
  assert.equal(hb.status, 204);
  goneAt = Date.now();
  const res = await http("DELETE", `${ADMIN}/v1/nodes/gone-${run}`, { headers: admin });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.code, "CONFLICT");
  assert.equal((await http("DELETE", `${ADMIN}/v1/nodes/gone-${run}`, { headers: node })).status, 403);
  assert.ok((await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.data.some((n) => n.node_id === `gone-${run}`));
});

step("cleaning up emits deletes in dependency order", async () => {
  const since = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.last_seq;
  assert.equal((await http("DELETE", `${D}/services/e2e-${run}?cascade=true`, { headers: admin })).status, 204);
  const res = await http("GET", `${ADMIN}/dp/changes?since=${since}`, { headers: node });
  assert.deepEqual(res.json.changes.map((c) => `${c.data.kind}:${c.data.op}`), ["route:delete", "service:delete"]);
});

step("a node that stopped reporting is removed and is gone from the list", async () => {
  // Live means heard from in the last 30 seconds.
  const wait = goneAt + 31_000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const listed = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.data.find((n) => n.node_id === `gone-${run}`);
  assert.equal(listed.live, false);
  const res = await http("DELETE", `${ADMIN}/v1/nodes/gone-${run}`, { headers: admin });
  assert.equal(res.status, 204, res.text);
  assert.ok(!(await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.data.some((n) => n.node_id === `gone-${run}`));
  assert.equal((await http("DELETE", `${ADMIN}/v1/nodes/gone-${run}`, { headers: admin })).status, 404);
});

step("the admin serves its OpenAPI document and metrics", async () => {
  const api = await http("GET", `${ADMIN}/v1/openapi.json`);
  assert.equal(api.json.openapi, "3.1.0");
  const metrics = await http("GET", `${ADMIN}/metrics`);
  assert.ok(metrics.text.includes("apg_changes_max_seq"));
});
