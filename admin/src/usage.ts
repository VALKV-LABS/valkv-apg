/**
 * Usage metering on the control plane (spec §11): taking windows from nodes,
 * rolling them up, and answering questions about them.
 */

import type { Actor } from "./auth.js";
import { requireAdmin, requireRead } from "./auth.js";
import type { Sql, Tx } from "./db.js";
import { ApiError } from "./errors.js";
import type { Json, Row, Store } from "./store.js";

export const COUNTERS = [
  "requests", "bytes_in", "bytes_out", "status_2xx", "status_3xx", "status_4xx", "status_5xx", "latency_ms_sum", "upstream_latency_ms_sum",
] as const;

const DIMENSIONS = ["workspace", "service", "route", "consumer", "region"] as const;
type Dimension = (typeof DIMENSIONS)[number];
const COLUMN: Record<Dimension, string> = { workspace: "workspace_id", service: "service_id", route: "route_id", consumer: "consumer_id", region: "region" };

const MAX_ROWS = 10_000;

function count(value: unknown, pointer: string): number {
  const n = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new ApiError("VALIDATION_FAILED", "counters are non-negative whole numbers", [{ pointer, message: "must be a non-negative integer" }]);
  return n;
}

function text(value: unknown, pointer: string, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ApiError("VALIDATION_FAILED", "a dimension is missing", [{ pointer, message: "is required" }]);
    return "";
  }
  if (typeof value !== "string" || value.length > 256) throw new ApiError("VALIDATION_FAILED", "a dimension is not valid", [{ pointer, message: "must be a string of at most 256 characters" }]);
  return value;
}

/**
 * Stores one window from one node. Rows are keyed on the node, the window and
 * the dimensions, and a row sent again replaces itself: a node that retries
 * after a timeout cannot count anything twice (spec USG-4).
 */
export async function ingest(sql: Sql, body: Json): Promise<number> {
  const nodeId = text(body["node_id"], "/node_id", true);
  const region = text(body["region"], "/region", false);
  const start = Number(body["window_start"]);
  const interval = Number(body["interval_secs"]);
  if (!Number.isSafeInteger(start) || start <= 0) throw new ApiError("VALIDATION_FAILED", "window_start must be seconds since the epoch", [{ pointer: "/window_start", message: "must be a positive integer" }]);
  if (!Number.isInteger(interval) || interval < 1 || interval > 86_400) throw new ApiError("VALIDATION_FAILED", "interval_secs must be from 1 to 86400", [{ pointer: "/interval_secs", message: "out of range" }]);
  const rows = body["rows"];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new ApiError("VALIDATION_FAILED", `rows must be a list of at most ${MAX_ROWS}`, [{ pointer: "/rows", message: "is not a list, or too long" }]);
  if (rows.length === 0) return 0;

  const records = rows.map((r: Json, i: number) => ({
    node_id: nodeId,
    window_start: new Date(start * 1000),
    interval_secs: interval,
    workspace_id: text(r["workspace_id"], `/rows/${i}/workspace_id`, true),
    service_id: text(r["service_id"], `/rows/${i}/service_id`, true),
    route_id: text(r["route_id"], `/rows/${i}/route_id`, true),
    consumer_id: text(r["consumer_id"], `/rows/${i}/consumer_id`, false),
    region,
    ...Object.fromEntries(COUNTERS.map((c) => [c, count(r[c], `/rows/${i}/${c}`)])),
  }));
  await sql`
    INSERT INTO apg_usage_raw ${sql(records)}
    ON CONFLICT (node_id, window_start, workspace_id, route_id, service_id, consumer_id) DO UPDATE SET
      interval_secs = EXCLUDED.interval_secs, region = EXCLUDED.region, received_at = now(),
      requests = EXCLUDED.requests, bytes_in = EXCLUDED.bytes_in, bytes_out = EXCLUDED.bytes_out,
      status_2xx = EXCLUDED.status_2xx, status_3xx = EXCLUDED.status_3xx, status_4xx = EXCLUDED.status_4xx, status_5xx = EXCLUDED.status_5xx,
      latency_ms_sum = EXCLUDED.latency_ms_sum, upstream_latency_ms_sum = EXCLUDED.upstream_latency_ms_sum`;
  return records.length;
}

const SUMS = COUNTERS.map((c) => `sum(${c})::bigint AS ${c}`).join(", ");
const OVERWRITE = COUNTERS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
const KEY = "workspace_id, service_id, route_id, consumer_id, region";

/**
 * Rebuilds the hours and days that received rows lately, from scratch. Because
 * a bucket is recomputed whole and written over, running this twice changes
 * nothing, and a window that arrives late simply re-rolls its hour (spec USG-6).
 */
export async function rollup(tx: Tx): Promise<number> {
  const hours = await tx.unsafe(`
    WITH touched AS (
      SELECT DISTINCT to_timestamp(floor(extract(epoch FROM window_start) / 3600) * 3600) AS bucket
      FROM apg_usage_raw WHERE received_at > now() - interval '15 minutes'
    )
    INSERT INTO apg_usage_hourly (bucket, ${KEY}, ${COUNTERS.join(", ")})
    SELECT t.bucket, ${KEY}, ${SUMS}
    FROM apg_usage_raw r JOIN touched t ON r.window_start >= t.bucket AND r.window_start < t.bucket + interval '1 hour'
    GROUP BY t.bucket, ${KEY}
    ON CONFLICT (bucket, workspace_id, route_id, service_id, consumer_id, region) DO UPDATE SET ${OVERWRITE}`);
  await tx.unsafe(`
    WITH touched AS (
      SELECT DISTINCT to_timestamp(floor(extract(epoch FROM window_start) / 86400) * 86400) AS bucket
      FROM apg_usage_raw WHERE received_at > now() - interval '15 minutes'
    )
    INSERT INTO apg_usage_daily (bucket, ${KEY}, ${COUNTERS.join(", ")})
    SELECT t.bucket, ${KEY}, ${SUMS}
    FROM apg_usage_hourly h JOIN touched t ON h.bucket >= t.bucket AND h.bucket < t.bucket + interval '1 day'
    GROUP BY t.bucket, ${KEY}
    ON CONFLICT (bucket, workspace_id, route_id, service_id, consumer_id, region) DO UPDATE SET ${OVERWRITE}`);
  return hours.count;
}

function instant(value: string | undefined, name: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError("BAD_REQUEST", `${name} must be a date-time`);
  return parsed;
}

/** `GET /v1/usage` (spec USG-7). */
export async function query(store: Store, sql: Sql, actor: Actor, q: Record<string, string | undefined>): Promise<Json> {
  const granularity = q["granularity"] ?? "hour";
  if (!["minute", "hour", "day"].includes(granularity)) throw new ApiError("BAD_REQUEST", "granularity must be minute, hour or day");
  const groupBy = (q["group_by"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const g of groupBy) {
    if (!(DIMENSIONS as readonly string[]).includes(g)) throw new ApiError("BAD_REQUEST", `group_by takes ${DIMENSIONS.join(", ")}; got '${g}'`);
  }
  const to = instant(q["to"], "to", new Date());
  const from = instant(q["from"], "from", new Date(to.getTime() - 24 * 3600_000));
  if (from >= to) throw new ApiError("BAD_REQUEST", "from must be before to");

  // A scoped caller must name a workspace it can read; only a fleet admin may look across all.
  let workspaceId: string | null = null;
  if (q["workspace"] !== undefined) {
    const ws = await store.workspace(sql, q["workspace"], actor);
    requireRead(actor, ws["id"]);
    workspaceId = ws["id"];
  } else {
    requireAdmin(actor);
  }

  const { table, time, bucket } = {
    minute: { table: "apg_usage_raw", time: "window_start", bucket: "to_timestamp(floor(extract(epoch FROM window_start) / 60) * 60)" },
    hour: { table: "apg_usage_hourly", time: "bucket", bucket: "bucket" },
    day: { table: "apg_usage_daily", time: "bucket", bucket: "bucket" },
  }[granularity as "minute" | "hour" | "day"];

  const where: string[] = [`${time} >= $1`, `${time} < $2`];
  const params: Array<string | Date> = [from, to];
  const filter = (column: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  };
  filter("workspace_id", workspaceId);
  for (const d of ["service", "route", "consumer", "region"] as const) filter(COLUMN[d], q[d]);

  const columns = groupBy.map((g) => COLUMN[g as Dimension]);
  const select = [`${bucket} AS bucket`, ...columns].join(", ");
  const group = ["1", ...columns.map((_, i) => String(i + 2))].join(", ");
  const rows = await sql.unsafe<Row[]>(
    `SELECT ${select}, ${SUMS} FROM ${table} WHERE ${where.join(" AND ")} GROUP BY ${group} ORDER BY 1, ${group} LIMIT ${MAX_ROWS + 1}`,
    params as never[],
  );
  return { granularity, from, to, group_by: groupBy, data: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}
