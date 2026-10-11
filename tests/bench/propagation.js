// Measures spec NFR-3: time from the Admin API accepting a change to a node
// serving it. Run inside the Compose network:
//
//   docker compose -f deploy/compose/database.yml -p valkv-apg run --rm \
//     -w /repo/tests/bench e2e node propagation.js
//
// Prints the distribution in milliseconds. The clock starts when the PUT
// returns (the change is committed) and stops at the first 200 from the node.

import { http } from "../e2e/lib/harness.js";
import { send } from "../e2e/lib/raw.js";

const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
const NODE = process.env.NODE_HTTP ?? "http://node:8080";
const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const N = Number(process.env.SAMPLES ?? 40);
const base = `${ADMIN}/v1/workspaces/default`;

await http("PUT", `${base}/services/bench-echo`, { headers: admin, body: { backends: [{ target: "echo:8080" }] } });

const samples = [];
for (let i = 0; i < N; i++) {
  const host = `bench-${Date.now().toString(36)}-${i}.test`;
  const put = await http("PUT", `${base}/routes/bench-${i}`, { headers: admin, body: { service: "bench-echo", hosts: [host] } });
  if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${put.text}`);
  const committed = performance.now();
  for (;;) {
    if ((await send(NODE, { host, path: "/" })).status === 200) break;
    if (performance.now() - committed > 20000) throw new Error("the change never reached the node");
  }
  samples.push(performance.now() - committed);
  // Let the node go back to waiting, so each sample measures a wake-up, not a busy loop.
  await new Promise((r) => setTimeout(r, 150));
}

for (let i = 0; i < N; i++) await http("DELETE", `${base}/routes/bench-${i}`, { headers: admin });
await http("DELETE", `${base}/services/bench-echo`, { headers: admin });

samples.sort((a, b) => a - b);
const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))].toFixed(1);
console.log(JSON.stringify({ samples: N, min_ms: samples[0].toFixed(1), p50_ms: pct(50), p95_ms: pct(95), max_ms: samples[N - 1].toFixed(1) }));
