/**
 * Serves the admin UI (spec §15): a static single-page application under
 * `/ui/`, built into the image. The UI talks only to the public `/v1` API.
 *
 * Files are read once at start; the set is small and fixed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { UiConfig } from "./config.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

function load(dir: string, prefix = ""): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of readdirSync(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) for (const [k, v] of load(dir, rel)) out.set(k, v);
    else out.set(rel, readFileSync(join(dir, rel)));
  }
  return out;
}

/** The headers every UI response carries. `frame-ancestors` is what makes embedding opt-in (spec UI-7). */
export function securityHeaders(ui: Pick<UiConfig, "embedOrigins" | "logoUrl">): Record<string, string> {
  const img = ["'self'", "data:", ...(ui.logoUrl?.startsWith("https://") ? [new URL(ui.logoUrl).origin] : [])];
  return {
    "content-security-policy": [
      "default-src 'self'",
      `img-src ${img.join(" ")}`,
      "style-src 'self' 'unsafe-inline'",
      "object-src 'none'",
      "base-uri 'self'",
      `frame-ancestors ${ui.embedOrigins.length > 0 ? ui.embedOrigins.join(" ") : "'none'"}`,
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export function registerUi(app: FastifyInstance, ui: UiConfig, version: string): void {
  if (!existsSync(join(ui.dir, "index.html"))) {
    app.log.warn({ dir: ui.dir }, "the admin UI is enabled but its files are not there; it will not be served");
    return;
  }
  const files = load(ui.dir);
  const headers = securityHeaders(ui);
  const send = (reply: FastifyReply, path: string): FastifyReply => {
    const body = files.get(path)!;
    // Vite names built assets by content hash, so they can be cached for good; the page itself never is.
    const cache = path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return reply.headers({ ...headers, "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": cache }).send(body);
  };

  app.get("/", async (_request, reply) => reply.redirect("/ui/"));
  app.get("/ui", async (_request, reply) => reply.redirect("/ui/"));

  // What the page needs before anyone has signed in.
  app.get("/ui/config.json", async (_request, reply) =>
    reply.headers({ ...headers, "cache-control": "no-cache" }).send({
      brand_name: ui.brandName,
      logo_url: ui.logoUrl,
      primary_color: ui.primaryColor,
      version,
      embed_origins: ui.embedOrigins,
    }));

  app.get("/ui/*", async (request, reply) => {
    const path = (request.params as Record<string, string>)["*"] ?? "";
    if (files.has(path)) return send(reply, path);
    // A missing asset is a 404; anything else is a page of the application.
    if (path.startsWith("assets/") || /\.[a-z0-9]{2,5}$/i.test(path)) return reply.status(404).headers(headers).send({ error: { code: "NOT_FOUND", message: "no such file" } });
    return send(reply, "index.html");
  });
}
