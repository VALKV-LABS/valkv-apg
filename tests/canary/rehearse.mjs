// A canary rehearsal on the Compose stack (spec §22, phase 5).
//
// `node` plays the stable track and `node-redirect` the canary. Both get the
// same traffic; then errors are injected on the canary only. The promotion
// check (deploy/canary/check.mjs) must say "promote" for the healthy stage and
// "rollback" for the faulty one. tests/canary/rehearse.sh then performs the
// rollback the runbook describes and times it.

import assert from "node:assert/strict";
import https from "node:https";
import { decide, delta, observe, parseMetrics, printDecision, quantile, summarise } from "../../deploy/canary/check.mjs";

const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
const TOKEN = process.env.ADMIN_TOKEN;
const STABLE = { traffic: "https://node:8443", mgmt: "http://node:9100" };
const CANARY = { traffic: "https://node-redirect:8443", mgmt: "http://node-redirect:9100" };
const HOST = "canary.rehearsal.test";

async function admin(method, path, body) {
  const res = await fetch(`${ADMIN}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function hit(base, path) {
  const url = new URL(base + path);
  return new Promise((resolve) => {
    const req = https.request({ hostname: url.hostname, port: url.port, path, headers: { host: HOST }, rejectUnauthorized: false, servername: HOST }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

/** `total` requests to one node, `faulty` of them to the route that answers 500. */
async function traffic(base, total, faulty = 0) {
  const codes = [];
  for (let i = 0; i < total; i += 10) {
    codes.push(...await Promise.all(Array.from({ length: Math.min(10, total - i) }, (_, j) => hit(base, i + j < faulty ? "/boom" : "/ok"))));
  }
  return codes;
}

// ── The decision logic on known numbers ──────────────────────────────────────

{
  const metrics = (requests, errors, slow) => summarise(parseMetrics([
    `apg_requests_total{route="r",service="s",status_class="2xx"} ${requests - errors}`,
    `apg_requests_total{route="r",service="s",status_class="5xx"} ${errors}`,
    `apg_request_duration_seconds_bucket{route="r",service="s",le="0.01"} ${requests - slow}`,
    `apg_request_duration_seconds_bucket{route="r",service="s",le="0.1"} ${requests}`,
    `apg_request_duration_seconds_bucket{route="r",service="s",le="+Inf"} ${requests}`,
  ].join("\n")));
  const zero = metrics(0, 0, 0);
  const ready = [{ url: "c", ready: true, stale: false }];
  const verdict = (stable, canary, r = ready) => decide(delta(zero, stable), delta(zero, canary), r).verdict;

  assert.equal(verdict(metrics(10_000, 10, 0), metrics(1000, 1, 0)), "promote", "equal error ratios");
  assert.equal(verdict(metrics(10_000, 10, 0), metrics(1000, 2, 0)), "promote", "0.1 points worse is the limit, not over it");
  assert.equal(verdict(metrics(10_000, 10, 0), metrics(1000, 5, 0)), "rollback", "0.4 points worse");
  assert.equal(verdict(metrics(10_000, 0, 0), metrics(1000, 0, 500)), "rollback", "p99 ten times worse");
  assert.equal(verdict(metrics(10_000, 0, 0), metrics(50, 0, 0)), "hold", "too little canary traffic to tell");
  assert.equal(verdict(metrics(10_000, 0, 0), metrics(50, 25, 0)), "rollback", "a failure needs no minimum traffic");
  assert.equal(verdict(metrics(10_000, 0, 0), metrics(1000, 0, 0), [{ url: "c", ready: true, stale: true }]), "rollback", "a stale canary");
  assert.equal(verdict(metrics(10_000, 0, 0), metrics(1000, 0, 0), []), "rollback", "no canary answered");
  assert.equal(quantile(new Map([[0.01, 90], [0.1, 100], [Infinity, 100]]), 0.99).toFixed(3), "0.091");
  // A node that restarted mid-window counts from zero instead of going negative.
  assert.equal(delta(metrics(500, 5, 0), metrics(40, 0, 0)).requests, 40);
  console.log("ok: the decision rules hold on known numbers");
}

// ── The rehearsal ────────────────────────────────────────────────────────────

const labels = { suite: "canary-rehearsal" };
await admin("POST", "/v1/config/apply", { message: "canary rehearsal", document: {
  version: 1,
  services: [{ name: "rehearsal-echo", labels, backends: [{ target: "echo:8080" }] }],
  routes: [
    { name: "rehearsal-ok", labels, service: "rehearsal-echo", hosts: [HOST], paths: ["/ok"] },
    { name: "rehearsal-boom", labels, service: "rehearsal-echo", hosts: [HOST], paths: ["/boom"], plugins: [{ type: "static_response", labels, config: { status: 500, body: "injected failure" } }] },
  ],
} });
try {
  // Both tracks must serve the new routes before the stages start.
  for (const node of [STABLE, CANARY]) {
    for (let i = 0; (await hit(node.traffic, "/ok")) !== 200 || (await hit(node.traffic, "/boom")) !== 500; i++) {
      assert.ok(i < 100, `${node.traffic} never served the rehearsal routes`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // Latency on one machine is noise at this scale; the rule itself is checked above on known numbers.
  const opts = { stable: [STABLE.mgmt], canary: [CANARY.mgmt], minRequests: 200, latencyFloorMs: 250 };

  console.log("\nstage 1: the canary behaves like the stable track");
  const healthy = await observe({ ...opts, during: async () => {
    const [s, c] = await Promise.all([traffic(STABLE.traffic, 400), traffic(CANARY.traffic, 400)]);
    assert.ok(s.every((x) => x === 200) && c.every((x) => x === 200), "healthy traffic must all succeed");
  } });
  printDecision(healthy);
  assert.equal(healthy.verdict, "promote");

  console.log("\nstage 2: errors are injected on the canary only (5 % of its requests fail)");
  const faulty = await observe({ ...opts, during: async () => {
    await Promise.all([traffic(STABLE.traffic, 400), traffic(CANARY.traffic, 400, 20)]);
  } });
  printDecision(faulty);
  assert.equal(faulty.verdict, "rollback");
  assert.match(faulty.reason, /server-error ratio/);

  console.log("\nok: the check promotes a healthy canary and rolls back a faulty one");
} finally {
  await admin("POST", "/v1/config/sync", { document: { version: 1 }, select_label: "suite=canary-rehearsal", message: "canary rehearsal cleanup" });
}
