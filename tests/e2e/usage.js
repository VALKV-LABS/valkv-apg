// Usage metering and observability, end to end (spec §11, §12): requests
// through a real node, then what the node counted, exported and reported.
//
// With a control plane the node reports usage windows to it and the suite
// reads them back through the Admin API. From a file the node writes windows
// to its file sink, on a volume this suite can read.
//
// The stacks under test cut usage windows every five seconds.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { ADMIN, MGMT, MODE, NODE, admin, adminCall, apply, metric } from "./lib/driver.js";
import { assert, http, step } from "./lib/harness.js";
import { send, until } from "./lib/raw.js";

const FLEET = MODE !== "file";
const OUT = process.env.USAGE_OUT ?? "/usage-out";
const ROUTE = "usage-route";
const labels = { route: ROUTE, service: "echo" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function config({ metering = true } = {}) {
  return {
    version: 1,
    flags: { usage_metering: metering },
    settings: { access_log: { sink: "stdout", custom_fields: { tenant: "{{ workspace.slug }}" } } },
    services: [{ name: "echo", shared: true, backends: [{ target: "echo:8080" }] }],
    routes: [{ name: ROUTE, service: "echo", hosts: ["usage.test"] }],
  };
}

const call = (opts = {}) => send(NODE, { host: "usage.test", path: "/", ...opts });

/** Every usage row the node wrote to its file sink. */
function fileRows() {
  if (!existsSync(OUT)) return [];
  return readdirSync(OUT)
    .filter((name) => name.startsWith("usage."))
    .flatMap((name) => readFileSync(`${OUT}/${name}`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)))
    .flatMap((window) => window.rows.map((row) => ({ ...row, window_start: window.window_start, interval_secs: window.interval_secs })));
}

let routeId = "";

/** Totals counted for this suite's route, wherever this mode keeps them. */
async function counted() {
  const sum = (rows) => rows.reduce((t, r) => ({ requests: t.requests + r.requests, bytes_in: t.bytes_in + r.bytes_in, bytes_out: t.bytes_out + r.bytes_out, ok: t.ok + r.status_2xx, latency: t.latency + r.latency_ms_sum }), { requests: 0, bytes_in: 0, bytes_out: 0, ok: 0, latency: 0 });
  if (!FLEET) return sum(fileRows().filter((r) => r.route_id === routeId || routeId === ""));
  const res = await adminCall("GET", `/v1/usage?granularity=minute&group_by=route&workspace=default&route=${routeId}`);
  return sum(res.json.data);
}

let before = { requests: 0, bytes_in: 0, bytes_out: 0, ok: 0, latency: 0 };
let metricsBefore = 0;

step("requests are served while usage is being counted", async () => {
  await apply(config());
  if (FLEET) routeId = (await adminCall("GET", `/v1/workspaces/default/routes/${ROUTE}`)).json.id;
  // From a file the rows cannot be told apart by route name, so let the windows of earlier suites be written first.
  else await sleep(7000);
  before = await counted();
  metricsBefore = (await metric(MGMT, "apg_requests_total", { ...labels, status_class: "2xx" })) ?? 0;
  for (let i = 0; i < 7; i++) assert.equal((await call({ path: `/item/${i}` })).status, 200);
  // Bodies with and without a declared length: both are counted as transferred (USG-3).
  const body = "x".repeat(100);
  assert.equal((await call({ method: "POST", body, headers: { "content-length": "100" } })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await call({ method: "POST", body, headers: { "transfer-encoding": "chunked" } })).status, 200);
  // A request no route matches belongs to nobody and is not usage.
  assert.equal((await send(NODE, { host: "nobody.usage.test", path: "/" })).status, 404);
});

step("request metrics carry the route and service, and bytes and upstream time are measured (OBS-1)", async () => {
  const ok = await metric(MGMT, "apg_requests_total", { ...labels, status_class: "2xx" });
  assert.equal(ok - metricsBefore, 10);
  assert.ok((await metric(MGMT, "apg_request_bytes_total", labels)) >= 300);
  assert.ok((await metric(MGMT, "apg_response_bytes_total", labels)) > 0);
  assert.ok((await metric(MGMT, "apg_upstream_duration_seconds_count", labels)) >= 10);
  assert.ok((await metric(MGMT, "apg_request_duration_seconds_count", labels)) >= 10);
  assert.equal(await metric(MGMT, "apg_active_requests"), 0);
  const text = (await http("GET", `${MGMT}/metrics`)).text;
  for (const name of ["apg_usage_windows_pending", "apg_usage_windows_dropped_total", "apg_usage_flush_failures_total", "apg_access_log_dropped_total"]) {
    assert.ok(text.includes(name), name);
  }
});

step("the trace context is continued when one arrives and started otherwise (§12.3)", async () => {
  const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
  const continued = (await call({ headers: { traceparent: `00-${trace}-00f067aa0ba902b7-01` } })).json.headers.traceparent;
  assert.match(continued, new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
  assert.notEqual(continued.split("-")[2], "00f067aa0ba902b7", "the upstream sees the gateway's span, not the caller's");
  const started = (await call()).json.headers.traceparent;
  assert.match(started, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  assert.match((await call({ headers: { traceparent: "not-a-trace" } })).json.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
});

step("the usage of the route is reported: requests, statuses, real bytes and latency (USG-1 to USG-4)", async () => {
  const total = await until(async () => {
    const now = await counted();
    return now.requests - before.requests >= 13 ? now : null;
  }, { timeoutMs: 45000, everyMs: 1000, what: "the usage windows to be delivered" });
  // Ten requests from the first step, three from the tracing step.
  assert.equal(total.requests - before.requests, 13);
  assert.equal(total.ok - before.ok, 13);
  assert.equal(total.bytes_in - before.bytes_in, 300, "request bodies, declared and chunked");
  assert.ok(total.bytes_out - before.bytes_out > 13 * 50, "response bodies as transferred");
  assert.ok(total.latency - before.latency >= 0);
});

if (FLEET) {
  step("the control plane rolls usage up by hour and day, and answers by workspace (USG-6, USG-7)", async () => {
    const hour = await until(async () => {
      const res = await adminCall("GET", `/v1/usage?granularity=hour&group_by=route,region&workspace=default&route=${routeId}`);
      return res.json.data.length > 0 && res.json.data.reduce((t, r) => t + r.requests, 0) >= 13 ? res.json : null;
    }, { timeoutMs: 45000, everyMs: 1000, what: "the hourly rollup" });
    assert.equal(hour.granularity, "hour");
    assert.equal(hour.data[0].route_id, routeId);
    const day = (await adminCall("GET", `/v1/usage?granularity=day&workspace=default&route=${routeId}`)).json;
    assert.ok(day.data.reduce((t, r) => t + r.requests, 0) >= 13);
    // No credential, no usage.
    assert.equal((await http("GET", `${ADMIN}/v1/usage`)).status, 401);
  });

  step("nodes report which backends they consider healthy (OBS-4)", async () => {
    const fleet = await until(async () => {
      const res = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json;
      const node = res.data.find((n) => n.node_id === "node-1");
      return node?.info?.backends?.some((b) => b.name === "echo") ? node : null;
    }, { timeoutMs: 30000, everyMs: 1000, what: "a heartbeat with backend health" });
    const echo = fleet.info.backends.find((b) => b.name === "echo");
    assert.deepEqual([echo.healthy, echo.unhealthy], [1, 0]);
  });

  step("an access-log sink that is not built is refused, not accepted and ignored", async () => {
    const res = await http("PUT", `${ADMIN}/v1/settings/access_log`, { headers: admin, body: { value: { sink: "https://logs.example.com/ingest" } } });
    assert.equal(res.status, 422);
    const bad = await http("PUT", `${ADMIN}/v1/settings/access_log`, { headers: admin, body: { value: { custom_fields: { broken: "{{ nobody.home }}" } } } });
    assert.equal(bad.status, 422);
  });
}

step("with the usage_metering flag off nothing is counted (USG-10)", async () => {
  await apply(config({ metering: false }));
  const frozen = await counted();
  for (let i = 0; i < 5; i++) assert.equal((await call()).status, 200);
  await sleep(8000);
  assert.equal((await counted()).requests, frozen.requests);
  // Metrics are a separate matter and keep counting.
  assert.ok((await metric(MGMT, "apg_requests_total", { ...labels, status_class: "2xx" })) - metricsBefore >= 18);
  await apply(config());
});
