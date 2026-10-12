// One half of the resilience checks: "the node is serving the routing suite's
// configuration right now". tests/e2e/resilience.sh runs this between stopping
// and starting containers, to prove serving does not depend on the control plane.

import { assert, http, step } from "./lib/harness.js";
import { send } from "./lib/raw.js";

const NODE = process.env.NODE_HTTP ?? "http://node:8080";
const MGMT = process.env.NODE_MGMT ?? "http://node:9100";
const expectStale = process.env.EXPECT_STALE === "true";

step("the node routes traffic", async () => {
  const res = await send(NODE, { host: "api.test", path: "/api/resilience" });
  assert.equal(res.status, 200);
  assert.equal(res.json.path, "/api/resilience");
  assert.equal((await send(NODE, { host: "shop.acme.test", path: "/" })).status, 200);
  assert.equal((await send(NODE, { host: "unknown.test", path: "/" })).status, 404);
});

step("the node is ready whatever the state of its config source (CFG-21)", async () => {
  const ready = await http("GET", `${MGMT}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ready, true);
  if (expectStale) assert.equal(ready.json.stale, true, "with the control plane down for a while the source is reported stale");
});

step("the node holds a complete configuration", async () => {
  const status = (await http("GET", `${MGMT}/status`)).json;
  assert.ok(status.counts.routes >= 14, `routes=${status.counts.routes}`);
  assert.ok(status.applied_seq > 0);
});
