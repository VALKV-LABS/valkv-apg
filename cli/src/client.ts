/** Connection settings (spec DEC-6) and the HTTP client for the Admin API. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { type Args, CliError, flag } from "./args.js";
import type { Json } from "./document.js";

export interface Context {
  url?: string;
  token?: string;
  workspace?: string;
}

export interface ContextFile {
  current?: string;
  contexts: Record<string, Context>;
}

type Env = Record<string, string | undefined>;

/** `$XDG_CONFIG_HOME/apg/config.yaml`, or `~/.config/apg/config.yaml`. */
export function contextPath(env: Env): string {
  const base = env["XDG_CONFIG_HOME"] || join(env["HOME"] || env["USERPROFILE"] || ".", ".config");
  return join(base, "apg", "config.yaml");
}

export function readContexts(env: Env): ContextFile {
  const path = contextPath(env);
  if (!existsSync(path)) return { contexts: {} };
  const doc = yaml.load(readFileSync(path, "utf8")) as Partial<ContextFile> | null;
  if (typeof doc !== "object" || doc === null) throw new CliError(`${path}: not a valid context file`);
  return { ...(typeof doc.current === "string" ? { current: doc.current } : {}), contexts: doc.contexts ?? {} };
}

/** Writes the context file, readable by its owner only: it holds tokens. */
export function writeContexts(env: Env, file: ContextFile): string {
  const path = contextPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, yaml.dump(file), { mode: 0o600 });
  return path;
}

export interface Connection {
  url: string;
  token: string;
  workspace: string;
}

/** Flags win over the environment, which wins over the chosen context. */
export function resolveConnection(args: Args, env: Env): Connection {
  const name = flag(args, "context") ?? (env["APG_CONTEXT"] || undefined);
  const file = readContexts(env);
  const chosen = name ?? file.current;
  if (name !== undefined && !file.contexts[name]) throw new CliError(`no context named '${name}' in ${contextPath(env)}`);
  const context = (chosen ? file.contexts[chosen] : undefined) ?? {};
  const url = flag(args, "url") ?? (env["APG_ADMIN_URL"] || undefined) ?? context.url;
  const token = flag(args, "token") ?? (env["APG_ADMIN_TOKEN"] || undefined) ?? context.token;
  if (!url) throw new CliError("no admin address: set APG_ADMIN_URL, pass --url, or create a context with 'apgctl config set-context'");
  if (!token) throw new CliError("no admin token: set APG_ADMIN_TOKEN, pass --token, or create a context with 'apgctl config set-context'");
  return { url: url.replace(/\/+$/, ""), token, workspace: flag(args, "workspace") ?? context.workspace ?? "default" };
}

/** Calls the Admin API. A non-2xx answer becomes a {@link CliError} carrying the server's own words. */
export class Client {
  constructor(private readonly conn: Connection, private readonly fetcher: typeof fetch = fetch) {}

  get workspace(): string {
    return this.conn.workspace;
  }

  async call(method: string, path: string, body?: unknown, query?: Record<string, string | string[] | undefined>): Promise<any> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) for (const item of [v].flat()) if (item !== undefined) params.append(k, item);
    const qs = params.toString();
    let res: Response;
    try {
      res = await this.fetcher(`${this.conn.url}${path}${qs ? `?${qs}` : ""}`, {
        method,
        headers: { authorization: `Bearer ${this.conn.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new CliError(`cannot reach the admin at ${this.conn.url}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) return json;
    const error = (json as Json | undefined)?.["error"] as Json | undefined;
    if (!error) throw new CliError(`the admin answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    const details = ((error["details"] ?? []) as Array<{ pointer: string; message: string }>).map((d) => `  ${d.pointer}: ${d.message}`);
    throw new CliError([`${error["code"]}: ${error["message"]}`, ...details].join("\n"));
  }

  /** Follows `next_cursor` to the end of a list. */
  async list(path: string, query: Record<string, string | undefined> = {}): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call("GET", path, undefined, { ...query, limit: "500", cursor });
      out.push(...(page.data as Json[]));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }
}
