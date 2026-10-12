// A stand-in for the admin, for component tests: `fetch` is replaced by a
// table of handlers, and the schemas it serves are the real ones from schemas/.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { Json } from "./api";

const SCHEMAS = join(__dirname, "..", "..", "schemas");

export function realSchemas(): { resources: Array<{ path: string; schema: Json }>; plugins: Json[] } {
  const read = (rel: string) => JSON.parse(readFileSync(join(SCHEMAS, rel), "utf8")) as Json;
  const resources = [
    { path: "common.json", schema: read("common.json") },
    ...readdirSync(join(SCHEMAS, "resources")).filter((f) => f.endsWith(".json")).map((f) => ({ path: `resources/${f}`, schema: read(`resources/${f}`) })),
  ];
  const plugins = readdirSync(join(SCHEMAS, "plugins")).filter((f) => f.endsWith(".json")).map((f, i) => ({
    name: f.replace(/\.json$/, ""), default_priority: 3000 - i * 100, phases: ["request"], available: true, schema: read(`plugins/${f}`),
  }));
  return { resources, plugins };
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  headers: Record<string, string>;
}

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (call: Call) => Answer | Promise<Answer>;

export const ADMIN = { kind: "token", id: "t-admin", name: "ops", role: "admin", workspaces: "*", fleet_admin: true };
export const VIEWER = { kind: "token", id: "t-viewer", name: "auditor", role: "viewer", workspaces: ["ws-acme"], fleet_admin: false };
export const WORKSPACES = [
  { id: "ws-default", name: "default", slug: "default", system: true, status: "active", limits: {}, revision: 1, created_at: "2026-01-01T00:00:00Z" },
  { id: "ws-acme", name: "acme", slug: "acme", system: false, status: "active", limits: { max_routes: 10 }, revision: 1, created_at: "2026-01-02T00:00:00Z" },
];

/**
 * Installs a fake admin. `routes` maps "METHOD /path" to a handler; anything
 * not listed answers an empty list, so a page's side queries need no setup.
 */
export function serve(routes: Record<string, Handler | Answer>, opts: { actor?: Json | null; brand?: Json } = {}) {
  const calls: Call[] = [];
  const schemas = realSchemas();
  const actor = opts.actor === undefined ? ADMIN : opts.actor;
  const defaults: Record<string, Handler | Answer> = {
    "GET /ui/config.json": { body: { brand_name: "valkv-apg", logo_url: null, primary_color: null, version: "0.1.0", embed_origins: [], ...opts.brand } },
    "GET /v1/session": actor ? { body: { actor, csrf_token: "csrf-1" } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "missing or invalid credentials" } } },
    "GET /v1/workspaces": { body: { data: actor && actor["workspaces"] !== "*" ? WORKSPACES.filter((w) => (actor["workspaces"] as string[]).includes(w.id)) : WORKSPACES, next_cursor: null } },
    "GET /v1/schemas/resources": { body: { data: schemas.resources } },
    "GET /v1/schemas/plugins": { body: { data: schemas.plugins } },
    "GET /v1/usage": { body: { data: [], group_by: [], truncated: false, granularity: "hour" } },
    "GET /v1/nodes": { body: { data: [], last_seq: 0 } },
  };
  const table = { ...defaults, ...routes };

  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://admin.test");
    const method = init.method ?? "GET";
    const call: Call = { method, path: url.pathname, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const handler = table[`${method} ${url.pathname}`];
    const answer: Answer = handler === undefined ? { body: { data: [], next_cursor: null } } : typeof handler === "function" ? await handler(call) : handler;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: answer.headers ?? {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}
