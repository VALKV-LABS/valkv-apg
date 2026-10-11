/**
 * The console's only way to the server: the public `/v1` Admin API (spec §15).
 * Anything done here can be done by a script with the same calls.
 */

export type Json = Record<string, any>;

export interface Fault {
  pointer: string;
  message: string;
}

/** An error answer from the Admin API, with the server's own code, message and field faults. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Fault[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Credentials {
  /** A delegated token handed over by an embedding page; kept in memory only. */
  bearer?: string;
  /** The CSRF token of the cookie session. */
  csrf?: string;
}

let credentials: Credentials = {};
let onUnauthenticated: () => void = () => {};

export function setCredentials(next: Credentials): void {
  credentials = next;
}

/** Called when any request comes back 401, so the app can return to sign-in. */
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export function withQuery(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null && item !== "") params.append(key, String(item));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** One call. Throws {@link ApiError} for any answer that is not 2xx. */
export async function api<T = any>(method: string, path: string, opts: { body?: unknown; query?: Query; ifMatch?: number; bearer?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const bearer = opts.bearer ?? credentials.bearer;
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  else if (credentials.csrf && method !== "GET") headers["x-apg-csrf"] = credentials.csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.ifMatch !== undefined) headers["if-match"] = `"${opts.ifMatch}"`;

  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      credentials: "same-origin",
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "The server cannot be reached. Check your connection and try again.");
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) return json as T;
  if (res.status === 401 && path !== "/v1/session") onUnauthenticated();
  const error = json?.error;
  throw new ApiError(res.status, error?.code ?? "ERROR", error?.message ?? `The server answered ${res.status}.`, error?.details ?? []);
}

/** Every item of a paged list. */
export async function listAll(path: string, query: Query = {}): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  do {
    const page: { data: Json[]; next_cursor: string | null } = await api("GET", path, { query: { ...query, limit: 500, cursor } });
    out.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/** The path of a workspace-scoped collection. */
export const ws = (workspace: string, segment: string): string => `/v1/workspaces/${encodeURIComponent(workspace)}/${segment}`;

// ── Formatting shared by pages ───────────────────────────────────────────────

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "3 minutes ago", "in 12 days". */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const diff = new Date(value).getTime() - now;
  if (Number.isNaN(diff)) return String(value);
  const abs = Math.abs(diff);
  const [n, unit] =
    abs < 60_000 ? [Math.round(abs / 1000), "second"]
    : abs < 3_600_000 ? [Math.round(abs / 60_000), "minute"]
    : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "hour"]
    : [Math.round(abs / 86_400_000), "day"];
  const text = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}
