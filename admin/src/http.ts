/** Small helpers shared by the Admin API and data-plane API route modules. */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "./auth.js";
import { ApiError } from "./errors.js";
import { type Ctx, type Json, type Page, isUuid } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the authentication hook on every authenticated route. */
    actor?: Actor;
    /** Set when the caller authenticated with a browser session. */
    session?: { cookie: string; csrf: string; expiresAt: Date };
  }
}

/** The request context handed to the store. */
export function ctxOf(request: FastifyRequest): Ctx {
  if (!request.actor) throw new ApiError("UNAUTHENTICATED", "missing or invalid credentials");
  return { actor: request.actor, requestId: request.id, sourceIp: request.ip };
}

/** Parses list parameters: `limit`, `cursor`, `name`, `label=k=v`. */
export function pageOf(request: FastifyRequest): Page {
  const q = request.query as Record<string, string | undefined>;
  const limit = q["limit"] === undefined ? 50 : Number(q["limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError("BAD_REQUEST", "limit must be an integer from 1 to 500");
  if (q["cursor"] !== undefined && !isUuid(q["cursor"])) throw new ApiError("BAD_REQUEST", "cursor is not valid");
  // `?label=k=v`, repeatable: a resource matches when it carries every one.
  let label: Record<string, string> | undefined;
  const asked = q["label"] as string | string[] | undefined;
  for (const one of asked === undefined ? [] : Array.isArray(asked) ? asked : [asked]) {
    const i = one.indexOf("=");
    if (i < 1) throw new ApiError("BAD_REQUEST", "label must be key=value");
    const key = one.slice(0, i);
    if (label?.[key] !== undefined && label[key] !== one.slice(i + 1)) throw new ApiError("BAD_REQUEST", `label '${key}' is asked for with two values`);
    label = { ...label, [key]: one.slice(i + 1) };
  }
  return { limit, cursor: q["cursor"], name: q["name"], label };
}

/** Options common to writes: `?dry_run=true`, `?cascade=true`, `If-Match`. */
export function writeOptions(request: FastifyRequest): { dryRun: boolean; cascade: boolean; ifMatch: number | undefined } {
  const q = request.query as Record<string, string | undefined>;
  const header = request.headers["if-match"];
  let ifMatch: number | undefined;
  if (typeof header === "string") {
    ifMatch = Number(header.replace(/^W\//, "").replace(/"/g, ""));
    if (!Number.isInteger(ifMatch) || ifMatch < 1) throw new ApiError("BAD_REQUEST", "If-Match must be a revision number");
  }
  return { dryRun: q["dry_run"] === "true", cascade: q["cascade"] === "true", ifMatch };
}

/** Sends one resource with its revision as the entity tag. */
export function sendResource(reply: FastifyReply, resource: Json, status = 200): FastifyReply {
  if (typeof resource["revision"] === "number") reply.header("etag", `"${resource["revision"]}"`);
  return reply.status(status).send(resource);
}

/** The request body as an object, or `BAD_REQUEST`. */
export function bodyOf(request: FastifyRequest): Json {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("BAD_REQUEST", "the request body must be a JSON object");
  return body as Json;
}
