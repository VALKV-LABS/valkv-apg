// How a suite's configuration reaches the nodes under test.
//
// A suite describes what it needs as one document in the apg.yaml shape and
// calls `apply`. The driver for the mode under test does the rest:
//   file      writes the document to the config file; the nodes reload it
//   api_poll  makes the control plane match it through the Admin API; the nodes poll
//
// Either way `apply` returns only once every node serves the new configuration.

import { writeFileSync } from "node:fs";
import { http } from "./harness.js";
import { until } from "./raw.js";

export const MODE = process.env.MODE ?? "file";
export const NODE = process.env.NODE_HTTP ?? "http://node:8080";
export const NODE_TLS = process.env.NODE_HTTPS ?? "https://node:8443";
export const MGMT = process.env.NODE_MGMT ?? "http://node:9100";
export const REDIRECT = process.env.REDIRECT_HTTP ?? "http://node-redirect:8080";
export const REDIRECT_TLS = process.env.REDIRECT_HTTPS ?? "https://node-redirect:8443";
export const REDIRECT_MGMT = REDIRECT.replace(":8080", ":9100");
export const CONFIG = process.env.CONFIG_FILE ?? "/etc/apg/apg.yaml";
export const ADMIN = process.env.ADMIN_URL ?? "http://admin:9000";
export const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

export const seq = async (mgmt) => (await http("GET", `${mgmt}/status`)).json?.applied_seq ?? 0;
export const nodes = [MGMT, REDIRECT_MGMT];

/** The value of the metric series with these labels on a node, or `undefined` when it is not exported. */
export async function metric(mgmt, name, labels = {}) {
  const text = (await http("GET", `${mgmt}/metrics`)).text;
  const line = text.split("\n").find((l) => (l.startsWith(`${name}{`) || l.startsWith(`${name} `)) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

let fileGeneration = 0;

/** File mode: write the document and wait until every node has reloaded it. */
async function applyFile(doc) {
  const before = await Promise.all(nodes.map(seq));
  // A comment that differs every time, so an unchanged document still counts as an edit.
  writeFileSync(CONFIG, `${JSON.stringify(doc, null, 2)}\n# generation ${++fileGeneration} ${Date.now()}\n`);
  await until(async () => (await Promise.all(nodes.map(seq))).every((s, i) => s > before[i]), { what: "every node to reload the file" });
}

export async function adminCall(method, path, body) {
  const res = await http(method, `${ADMIN}${path}`, { headers: admin, body });
  if (res.status >= 400 && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  }
  return res;
}

/** Makes one workspace's resources match the document. */
async function syncWorkspace(ws, section) {
  const base = `/v1/workspaces/${ws}`;
  for (const { name, ...rest } of section.certificates ?? []) await adminCall("PUT", `${base}/certificates/${name}`, rest);
  for (const { hostname, ...rest } of section.domains ?? []) {
    await adminCall("PUT", `${base}/domains/${hostname.replace("*.", "wildcard.")}`, { hostname, ...rest });
  }
  for (const { name, ...rest } of section.ca_certificates ?? []) await adminCall("PUT", `${base}/ca-certificates/${name}`, rest);
  for (const { name, ...rest } of section.services ?? []) await adminCall("PUT", `${base}/services/${name}`, rest);
  const wanted = new Set();
  for (const { name, plugins = [], ...rest } of section.routes ?? []) {
    wanted.add(name);
    await adminCall("PUT", `${base}/routes/${name}`, rest);
    for (const p of plugins) {
      await adminCall("PUT", `${base}/plugins/${name}-${p.type.replace("_", "-")}`, { type: p.type, scope: "route", scope_ref: name, config: p.config ?? {} });
    }
  }
  // Routes the document no longer has are removed, as a declarative sync would.
  const existing = (await adminCall("GET", `${base}/routes?limit=500`)).json.data;
  for (const r of existing) if (!wanted.has(r.name)) await adminCall("DELETE", `${base}/routes/${r.name}`);
}

/** Database mode: make the control plane match the document, then wait for every node to catch up. */
async function applyApi(doc) {
  for (const [name, value] of Object.entries(doc.settings ?? {})) await adminCall("PUT", `/v1/settings/${name}`, { value });
  for (const [name, enabled] of Object.entries(doc.flags ?? {})) await adminCall("PUT", `/v1/flags/${name}`, { enabled });
  await syncWorkspace("default", doc);
  for (const { name, status = "active", ...section } of doc.workspaces ?? []) {
    const found = await http("GET", `${ADMIN}/v1/workspaces/${name}`, { headers: admin });
    if (found.status === 404) await adminCall("POST", "/v1/workspaces", { name, status });
    else if (found.json.status !== status) await adminCall("PATCH", `/v1/workspaces/${name}`, { status });
    await syncWorkspace(name, section);
  }
  const target = (await adminCall("GET", "/v1/nodes")).json.last_seq;
  await until(async () => (await Promise.all(nodes.map(seq))).every((s) => s >= target), { what: `every node to reach seq ${target}` });
}

export const apply = MODE === "file" ? applyFile : applyApi;
