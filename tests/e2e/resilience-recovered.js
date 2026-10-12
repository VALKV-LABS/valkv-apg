// The other half of the resilience checks: once the control plane is back, a
// node picks up changes again without being restarted.

import { assert, http, step } from "./lib/harness.js";
import { send, until } from "./lib/raw.js";

const NODE = process.env.NODE_HTTP ?? "http://node:8080";
const MGMT = process.env.NODE_MGMT ?? "http://node:9100";
const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const name = `recovered-${Date.now().toString(36)}`;

step("a change made after the outage reaches the node", async () => {
  const put = await http("PUT", `${ADMIN}/v1/workspaces/default/routes/${name}`, { headers: admin, body: { service: "echo", hosts: [`${name}.test`] } });
  assert.equal(put.status, 200, put.text);
  await until(async () => (await send(NODE, { host: `${name}.test`, path: "/" })).status === 200, { timeoutMs: 45000, what: "the new route to be served" });
});

step("the node is no longer stale and has caught up", async () => {
  const last = (await http("GET", `${ADMIN}/v1/nodes`, { headers: admin })).json.last_seq;
  await until(async () => (await http("GET", `${MGMT}/status`)).json.applied_seq >= last, { what: "the node to reach the newest change" });
  assert.equal((await http("GET", `${MGMT}/readyz`)).json.stale, false);
});

step("cleaning up", async () => {
  assert.equal((await http("DELETE", `${ADMIN}/v1/workspaces/default/routes/${name}`, { headers: admin })).status, 204);
  await until(async () => (await send(NODE, { host: `${name}.test`, path: "/" })).status === 404, { what: "the route to disappear" });
});
