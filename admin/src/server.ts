/**
 * Builds the admin's HTTP server: health endpoints, metrics, the Admin API
 * and the data-plane API.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Authenticator } from "./auth.js";
import { CallerRateLimiter, SESSION_COOKIE } from "./auth.js";
import type { Config, UiConfig } from "./config.js";
import { registerConfig } from "./routes/config.js";
import { type Oidc, registerOidc } from "./oidc.js";
import { registerUi } from "./ui.js";
import { ApiError, toErrorResponse } from "./errors.js";
import type { JobRunner } from "./jobs.js";
import { buildOpenApi } from "./openapi.js";
import { ENDPOINTS, registerApi } from "./routes/api.js";
import { type ChangeNotifier, registerDp } from "./routes/dp.js";
import type { SchemaRegistry } from "./schemas.js";
import type { Store } from "./store.js";

/** Everything the full server needs. */
export interface ServerDeps {
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
  store?: Store;
  schemas?: SchemaRegistry;
  auth?: Authenticator;
  notifier?: ChangeNotifier;
  jobs?: JobRunner;
  /** Which route groups this listener serves. Default: both. */
  serve?: { api: boolean; dp: boolean };
  version?: string;
  /** The admin UI; absent or disabled serves none. */
  ui?: UiConfig;
  /** A node's management address, for the route tester (spec RT-6). */
  debugNodeUrl?: string | null;
  /** Single sign-on for the console. */
  oidc?: Oidc | null;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
// The single sign-on endpoints are reached by a browser that is not signed in yet.
const OPEN_PATHS = new Set(["/healthz", "/readyz", "/metrics", "/v1/openapi.json", "/v1/session/oidc/login", "/v1/session/oidc/callback"]);

/** Creates the server. The caller listens and closes. */
export function buildServer(config: Pick<Config, "logLevel"> & Partial<Pick<Config, "tls">>, deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ["req.headers.authorization"] },
    // Honour a well-formed inbound id so one id follows a request across services.
    genReqId: (req: { headers: Record<string, unknown> }) => {
      const inbound = req.headers["x-request-id"];
      return typeof inbound === "string" && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
    bodyLimit: 12 * 1024 * 1024,
    ...(config.tls ? { https: { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) } } : {}),
  } as Parameters<typeof Fastify>[0]) as unknown as FastifyInstance;

  const serve = deps.serve ?? { api: true, dp: true };
  const limiter = new CallerRateLimiter();
  const counts = new Map<string, number>();

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    const key = `${request.method} ${route} ${reply.statusCode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  // Authentication for everything except health, metrics and the API description.
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0]!;
    if (OPEN_PATHS.has(path) || path === "/" || path === "/ui" || path.startsWith("/ui/") || !deps.auth) return;
    if (!path.startsWith("/v1/") && !path.startsWith("/dp/")) return; // falls through to NOT_FOUND
    // A bearer credential wins; a browser session is the fallback (spec API-5).
    const cookie = request.headers.authorization === undefined ? cookieOf(request.headers.cookie, SESSION_COOKIE) : undefined;
    let actor;
    if (cookie !== undefined) {
      const header = request.headers["x-apg-csrf"];
      const session = await deps.auth.fromSession(cookie, request.method, typeof header === "string" ? header : undefined);
      actor = session.actor;
      request.session = { cookie, csrf: session.csrf, expiresAt: session.expiresAt };
    } else {
      actor = await deps.auth.authenticate(request.headers.authorization);
    }
    // A node token opens the data-plane API and nothing else.
    if (actor.role === "node" && !path.startsWith("/dp/")) throw new ApiError("FORBIDDEN", "node tokens can call /dp/* only");
    if (!limiter.take(actor.id)) throw new ApiError("RATE_LIMITED", "too many requests");
    request.actor = actor;
  });

  app.setErrorHandler(async (err, request, reply) => {
    const { status, body } = toErrorResponse(err, request.id);
    if (status === 500) request.log.error({ err }, "unhandled error");
    // Refused changes are audited too (spec API-9). Best effort: a failure to
    // record must not turn a 403 into a 500.
    if ((status === 401 || status === 403) && request.method !== "GET" && deps.store) {
      const actor = request.actor ?? { kind: "anonymous", id: "anonymous", name: "anonymous" };
      void deps.store
        .audit(deps.store.deps.sql, { actor: actor as never, requestId: request.id, sourceIp: request.ip }, {
          action: `${request.method} ${request.url.split("?")[0]}`, kind: "request", outcome: "refused",
        })
        .catch(() => {});
    }
    if (status === 429) reply.header("retry-after", "1");
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((request) => {
    throw new ApiError("NOT_FOUND", `no such endpoint: ${request.method} ${request.url.split("?")[0]}`);
  });

  // Liveness: the process is up.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: the process can do its job, which needs the database.
  app.get("/readyz", async (_request, reply) => {
    try {
      await deps.pingDatabase();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "unavailable", reason: "database unreachable" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    const lines: string[] = ["# TYPE apg_admin_requests_total counter"];
    for (const [key, n] of [...counts.entries()].sort()) {
      const [method, route, status] = key.split(" ");
      lines.push(`apg_admin_requests_total{method="${method}",route="${route}",status="${status}"} ${n}`);
    }
    if (deps.store) {
      try {
        const sql = deps.store.deps.sql;
        const [m] = await sql<Array<{ last_seq: string; rows: number; live: number; min_applied: number | null; leases: number }>>`
          SELECT (SELECT value FROM apg_meta WHERE key = 'last_seq') AS last_seq,
                 (SELECT count(*)::int FROM apg_changes) AS rows,
                 (SELECT count(*)::int FROM apg_nodes WHERE last_seen > now() - interval '30 seconds') AS live,
                 (SELECT min(applied_seq) FROM apg_nodes WHERE last_seen > now() - interval '30 seconds') AS min_applied,
                 (SELECT count(*)::int FROM apg_cert_leases WHERE expires_at > now()) AS leases`;
        const last = Number(m!.last_seq);
        lines.push("# TYPE apg_changes_max_seq gauge", `apg_changes_max_seq ${last}`);
        lines.push("# TYPE apg_changes_rows gauge", `apg_changes_rows ${m!.rows}`);
        lines.push("# TYPE apg_nodes_live gauge", `apg_nodes_live ${m!.live}`);
        lines.push("# TYPE apg_nodes_max_lag gauge", `apg_nodes_max_lag ${m!.min_applied === null ? 0 : Math.max(0, last - m!.min_applied)}`);
        lines.push("# TYPE apg_cert_leases_active gauge", `apg_cert_leases_active ${m!.leases}`);
        // One series per live node, so a dashboard can show the fleet and single out one node.
        // A node that stops reporting drops out here and out of apg_nodes_live.
        const nodes = await sql<Array<{ node_id: string; applied_seq: number; stale: boolean; unhealthy: number }>>`
          SELECT node_id, applied_seq, stale,
                 (SELECT coalesce(sum((b->>'unhealthy')::int), 0)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(info->'backends') = 'array' THEN info->'backends' ELSE '[]'::jsonb END) b) AS unhealthy
          FROM apg_nodes WHERE last_seen > now() - interval '30 seconds' ORDER BY node_id LIMIT 1000`;
        const label = (id: string) => `{node="${id.replace(/[\\"\n]/g, "_")}"}`;
        lines.push("# TYPE apg_node_lag gauge", ...nodes.map((n) => `apg_node_lag${label(n.node_id)} ${Math.max(0, last - Number(n.applied_seq))}`));
        lines.push("# TYPE apg_node_stale gauge", ...nodes.map((n) => `apg_node_stale${label(n.node_id)} ${n.stale ? 1 : 0}`));
        lines.push("# TYPE apg_node_backends_unhealthy gauge", ...nodes.map((n) => `apg_node_backends_unhealthy${label(n.node_id)} ${n.unhealthy}`));
      } catch {
        // metrics must never fail the scrape; the request counters above still go out
      }
    }
    if (deps.jobs) {
      lines.push("# TYPE apg_job_last_success_timestamp_seconds gauge");
      for (const [job, ts] of deps.jobs.lastSuccess) lines.push(`apg_job_last_success_timestamp_seconds{job="${job}"} ${ts}`);
      lines.push("# TYPE apg_job_failures_total counter");
      for (const [job, n] of deps.jobs.failures) lines.push(`apg_job_failures_total{job="${job}"} ${n}`);
    }
    return reply.header("content-type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  if (deps.store && deps.schemas) {
    if (serve.api) {
      registerApi(app, deps.store, deps.schemas);
      if (deps.auth) registerConfig(app, deps.store, deps.auth, { debugNodeUrl: deps.debugNodeUrl ?? null, secureCookies: Boolean(config.tls) });
      const document = buildOpenApi(ENDPOINTS, deps.schemas, deps.version ?? "0.1.0");
      app.get("/v1/openapi.json", async () => document);
    }
    if (serve.dp && deps.notifier) registerDp(app, deps.store, deps.notifier);
  }

  if (serve.api && deps.oidc && deps.auth) registerOidc(app, deps.oidc, deps.auth, { secureCookies: Boolean(config.tls) });
  if (serve.api && deps.ui?.enabled) registerUi(app, deps.ui, deps.version ?? "0.1.0", Boolean(deps.oidc));

  return app;
}

/** The value of one cookie in a `Cookie` header. */
export function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
