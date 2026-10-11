import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ConfigError, READ_VARIABLES, loadConfig } from "./config.js";
import { ApiError, ERROR_STATUS, toErrorResponse } from "./errors.js";
import { buildServer } from "./server.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function server(pingDatabase: () => Promise<void> = async () => {}): FastifyInstance {
  app = buildServer({ logLevel: "error" }, { pingDatabase });
  return app;
}

describe("health endpoints", () => {
  it("healthz is 200 whatever the database is doing", async () => {
    const res = await server(async () => {
      throw new Error("down");
    }).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("readyz is 200 when the database answers", async () => {
    const res = await server().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("readyz is 503 when the database does not answer", async () => {
    const res = await server(async () => {
      throw new Error("connection refused to 10.1.2.3");
    }).inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("10.1.2.3");
  });
});

describe("error shape", () => {
  it("an unknown path is NOT_FOUND in the standard shape, with the request id", async () => {
    const res = await server().inject({ method: "GET", url: "/v1/nope?x=1", headers: { "x-request-id": "req-123" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "no such endpoint: GET /v1/nope", request_id: "req-123" },
    });
    expect(res.headers["x-request-id"]).toBe("req-123");
  });

  it("a malformed inbound request id is replaced, not echoed", async () => {
    const res = await server().inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "bad id\twith spaces" } });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("malformed JSON is BAD_REQUEST, not a 500", async () => {
    const s = server();
    s.post("/echo", async (req) => req.body);
    const res = await s.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("an unexpected throw is INTERNAL_ERROR and leaks nothing", async () => {
    const s = server();
    s.get("/boom", async () => {
      throw new Error("password=hunter2 at db.internal");
    });
    const res = await s.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: "INTERNAL_ERROR", message: "internal error" });
    expect(res.body).not.toContain("hunter2");
  });

  it("an ApiError keeps its code, status and details", () => {
    const { status, body } = toErrorResponse(
      new ApiError("VALIDATION_FAILED", "invalid route", [{ pointer: "/paths/0", message: "must start with /" }]),
    );
    expect(status).toBe(422);
    expect(body.error.details).toEqual([{ pointer: "/paths/0", message: "must start with /" }]);
  });

  it("every code maps to one status in the documented set", () => {
    expect(new Set(Object.values(ERROR_STATUS))).toEqual(new Set([400, 401, 403, 404, 409, 410, 412, 422, 429, 500, 503]));
  });
});

describe("process configuration", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const base = { APG_DATABASE_URL: "postgres://u@h/db", APG_SECRET_KEY: KEY };

  it("reads defaults", () => {
    expect(loadConfig(base)).toMatchObject({
      databaseUrl: "postgres://u@h/db",
      listen: { host: "0.0.0.0", port: 9000 },
      dpListen: null,
      tls: null,
      jwt: null,
      migrateOnBoot: true,
      domainVerification: "none",
      changelogRetentionHours: 168,
      nodeSlotTtlHours: 24,
      auditRetentionDays: 400,
      logLevel: "info",
      logFormat: "json",
    });
  });

  it("needs a 32-byte secret key and says so", () => {
    expect(() => loadConfig({ APG_DATABASE_URL: "postgres://u@h/db" })).toThrow(/APG_SECRET_KEY/);
    expect(() => loadConfig({ ...base, APG_SECRET_KEY: "c2hvcnQ=" })).toThrow(/32 random bytes/);
  });

  it("delegated JWT needs a workspace claim, so a token can never be unscoped", () => {
    expect(() => loadConfig({ ...base, APG_ADMIN_JWT_JWKS_URL: "https://idp.example/jwks" })).toThrow(/WORKSPACE_CLAIM/);
    expect(loadConfig({ ...base, APG_ADMIN_JWT_JWKS_URL: "https://idp.example/jwks", APG_ADMIN_JWT_WORKSPACE_CLAIM: "ws" }).jwt?.workspaceClaim).toBe("ws");
  });

  it("rejects half a TLS pair and malformed numbers and CIDRs", () => {
    expect(() => loadConfig({ ...base, APG_ADMIN_TLS_CERT: "/c.pem" })).toThrow(/together/);
    expect(() => loadConfig({ ...base, APG_CHANGELOG_RETENTION_HOURS: "0" })).toThrow(/positive integer/);
    expect(() => loadConfig({ ...base, APG_BACKEND_ALLOW_CIDRS: "10.0.0.0/99" })).toThrow(/CIDR/);
    expect(() => loadConfig({ ...base, APG_MIGRATE_ON_BOOT: "yes" })).toThrow(/true or false/);
  });

  it("fails when the database URL is absent or empty", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, APG_DATABASE_URL: "  " })).toThrow(/APG_DATABASE_URL/);
  });

  it("rejects a bad listen address and a bad log level instead of guessing", () => {
    expect(() => loadConfig({ ...base, APG_ADMIN_LISTEN: "9000" })).toThrow(/host:port/);
    expect(() => loadConfig({ ...base, APG_ADMIN_LISTEN: "0.0.0.0:99999" })).toThrow(/host:port/);
    expect(() => loadConfig({ ...base, APG_LOG_LEVEL: "verbose" })).toThrow(/APG_LOG_LEVEL/);
  });

  it("reads only variables listed for the admin in schemas/process-config.yaml", () => {
    const path = fileURLToPath(new URL("../../schemas/process-config.yaml", import.meta.url));
    const listed = (yaml.load(readFileSync(path, "utf8")) as { variables: Array<{ name: string; component: string }> }).variables
      .filter((v) => v.component === "admin")
      .map((v) => v.name);
    for (const name of READ_VARIABLES) expect(listed).toContain(name);
  });
});
