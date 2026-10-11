/**
 * The data-plane API, `/dp/*` (spec §13.4): what nodes call.
 *
 * `GET /dp/changes` and `GET /dp/snapshot` are the public config contract
 * (spec CFG-12a): any server that answers these two the same way is a valid
 * control plane for a node in `api_poll` mode. Everything else here is
 * optional for third-party implementations.
 */

import type { FastifyInstance } from "fastify";
import { requireNode } from "../auth.js";
import { uuidv7 } from "../crypto.js";
import { type Sql, clusterId } from "../db.js";
import { ApiError } from "../errors.js";
import { bodyOf, ctxOf } from "../http.js";
import { KINDS, SNAPSHOT_ORDER } from "../kinds.js";
import type { Json, Row, Store } from "../store.js";
import { ingest } from "../usage.js";

const MAX_WAIT_MS = 55_000;

/** Wakes long-polling readers when a changelog row commits, on this replica or any other. */
export class ChangeNotifier {
  private readonly waiters = new Set<() => void>();
  private stop: (() => Promise<void>) | null = null;

  /** Starts listening. Postgres delivers a notification only when the writing transaction commits. */
  async start(sql: Sql): Promise<void> {
    const sub = await sql.listen("apg_changes", () => {
      for (const wake of [...this.waiters]) wake();
    });
    this.stop = () => sub.unlisten();
  }

  async close(): Promise<void> {
    for (const wake of [...this.waiters]) wake();
    await this.stop?.();
  }

  /** Resolves on the next change or after `ms`, whichever comes first. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

/** Sequence numbers a reader can still be served from. */
async function bounds(sql: Sql): Promise<{ oldest: number | null; newest: number }> {
  const [row] = await sql<{ oldest: number | null; newest: string }[]>`
    SELECT (SELECT min(seq) FROM apg_changes) AS oldest, (SELECT value FROM apg_meta WHERE key = 'last_seq') AS newest`;
  return { oldest: row!.oldest, newest: Number(row!.newest) };
}

export function registerDp(app: FastifyInstance, store: Store, notifier: ChangeNotifier): void {
  const sql = store.deps.sql;
  let cluster: string | undefined;

  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/dp/")) requireNode(ctxOf(request).actor);
  });

  // ── Config contract ────────────────────────────────────────────────────────

  app.get("/dp/changes", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const since = Number(q["since"] ?? 0);
    const limit = Number(q["limit"] ?? 500);
    const waitMs = Math.min(MAX_WAIT_MS, Number(q["wait_ms"] ?? 0));
    if (!Number.isInteger(since) || since < 0) throw new ApiError("BAD_REQUEST", "since must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ApiError("BAD_REQUEST", "limit must be an integer from 1 to 1000");
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new ApiError("BAD_REQUEST", "wait_ms must be a non-negative number");

    // Every answer names the control plane it came from. A node that was moved
    // to another one (or whose database was rebuilt) sees the change at once
    // and resyncs instead of trusting a position from elsewhere (spec CFG-10).
    cluster ??= await clusterId(sql);
    reply.header("x-apg-cluster-id", cluster);

    const { oldest, newest } = await bounds(sql);
    // Ahead of the newest row: the database was restored from a backup.
    // Behind the oldest retained row: retention removed rows this reader needs.
    // Either way an incremental read would silently miss changes (spec CFG-9).
    const missed = oldest === null ? since < newest : since < oldest - 1;
    if (since > newest || missed) {
      throw new ApiError("RESYNC_REQUIRED", "the requested position is no longer available; take a snapshot");
    }

    const read = () => sql<{ seq: number; data: Json }[]>`
      SELECT seq, data FROM apg_changes WHERE seq > ${since} ORDER BY seq LIMIT ${limit + 1}`;
    let rows = await read();
    if (rows.length === 0 && waitMs > 0) {
      await notifier.wait(waitMs);
      rows = await read();
    }
    // 204 is proof of liveness with nothing new to say (spec CFG-12).
    if (rows.length === 0) return reply.status(204).send();

    const page = rows.slice(0, limit);
    return { changes: page, last_seq: page[page.length - 1]!.seq, has_more: rows.length > limit };
  });

  app.get("/dp/snapshot", async (_request, reply) => {
    // One repeatable-read transaction: the body is exactly the state at `seq` (spec CFG-7).
    const lines = (await sql.begin("isolation level repeatable read read only", async (tx) => {
      const out: string[] = [];
      const [meta] = await tx<{ value: string }[]>`SELECT value FROM apg_meta WHERE key = 'last_seq'`;
      out.push(JSON.stringify({ cluster_id: await clusterId(tx), seq: Number(meta!.value) }));
      const push = (e: Json) => out.push(JSON.stringify({ v: 2, op: "upsert", ...e }));

      for (const r of await tx<Row[]>`SELECT * FROM apg_settings ORDER BY name`) push({ kind: "setting", id: r["name"], revision: r["revision"], data: { value: r["value"] } });
      for (const r of await tx<Row[]>`SELECT * FROM apg_flags ORDER BY name`) push({ kind: "flag", id: r["name"], revision: r["revision"], data: { enabled: r["enabled"] } });
      for (const r of await tx<Row[]>`SELECT * FROM apg_workspaces ORDER BY id`) {
        push({ kind: "workspace", id: r["id"], revision: r["revision"], data: { name: r["name"], slug: r["slug"], system: r["system"], status: r["status"], labels: r["labels"] } });
      }
      for (const kind of SNAPSHOT_ORDER) {
        const def = KINDS[kind];
        for (const r of await tx<Row[]>`SELECT * FROM ${tx(def.table)} ORDER BY id`) {
          push({ kind, id: r["id"], workspace_id: r["workspace_id"], revision: r["revision"], data: def.toEvent(r) });
        }
      }
      for (const r of await tx<Row[]>`SELECT * FROM apg_acme_challenges WHERE expires_at > now()`) {
        push({ kind: "acme_challenge", id: r["token"], revision: 1, data: { token: r["token"], key_authorization: r["key_authorization"], expires_at: r["expires_at"] } });
      }
      return out;
    })) as string[];
    return reply.header("content-type", "application/x-ndjson").send(lines.join("\n") + "\n");
  });

  // ── Fleet state ────────────────────────────────────────────────────────────

  app.post("/dp/heartbeat", async (request, reply) => {
    const b = bodyOf(request);
    const nodeId = b["node_id"];
    if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 200) throw new ApiError("VALIDATION_FAILED", "node_id is required", [{ pointer: "/node_id", message: "must be a non-empty string" }]);
    const applied = Number(b["applied_seq"] ?? 0);
    if (!Number.isInteger(applied) || applied < 0) throw new ApiError("VALIDATION_FAILED", "applied_seq must be a non-negative integer", [{ pointer: "/applied_seq", message: "must be a non-negative integer" }]);
    const { node_id: _n, applied_seq: _a, version, source, stale, region, started_at, ...info } = b;
    await sql`
      INSERT INTO apg_nodes (node_id, version, source, applied_seq, stale, region, info, started_at, last_seen)
      VALUES (${nodeId}, ${String(version ?? "")}, ${String(source ?? "")}, ${applied}, ${stale === true}, ${typeof region === "string" ? region : null},
              ${sql.json(info)}, ${typeof started_at === "string" ? started_at : null}, now())
      ON CONFLICT (node_id) DO UPDATE SET version = EXCLUDED.version, source = EXCLUDED.source, applied_seq = EXCLUDED.applied_seq,
        stale = EXCLUDED.stale, region = EXCLUDED.region, info = EXCLUDED.info, started_at = EXCLUDED.started_at, last_seen = now()`;
    return reply.status(204).send();
  });

  // The lowest applied position among live nodes. An ACME issuer waits for this
  // to pass its challenge's seq before asking the CA to validate (spec TLS-10).
  app.get("/dp/nodes/applied", async () => {
    const [row] = await sql<{ min_applied: number | null; live: number }[]>`
      SELECT min(applied_seq) AS min_applied, count(*)::int AS live FROM apg_nodes WHERE last_seen > now() - interval '30 seconds'`;
    return { min_applied_seq: row!.min_applied, live_nodes: row!.live };
  });

  // ── Usage (spec §11) ───────────────────────────────────────────────────────

  // One closed window from one node. Sending the same window again replaces
  // it, so a node may retry freely (spec USG-4).
  app.post("/dp/usage", async (request, reply) => {
    await ingest(sql, bodyOf(request));
    return reply.status(204).send();
  });

  // ── Certificate coordination (spec §8.4) ───────────────────────────────────

  app.post("/dp/certs/lease", async (request) => {
    const b = bodyOf(request);
    const hostname = String(b["hostname"] ?? "").toLowerCase();
    const nodeId = String(b["node_id"] ?? "");
    const ttl = Math.min(900, Math.max(30, Number(b["ttl_secs"] ?? 300) || 300));
    if (!hostname || !nodeId) throw new ApiError("VALIDATION_FAILED", "hostname and node_id are required");
    const leaseId = uuidv7();
    // Take the lease if it is free or has expired; a crashed issuer blocks a host for at most its TTL.
    const [row] = await sql<Row[]>`
      INSERT INTO apg_cert_leases (hostname, lease_id, node_id, expires_at)
      VALUES (${hostname}, ${leaseId}, ${nodeId}, now() + make_interval(secs => ${ttl}))
      ON CONFLICT (hostname) DO UPDATE SET lease_id = EXCLUDED.lease_id, node_id = EXCLUDED.node_id, expires_at = EXCLUDED.expires_at
        WHERE apg_cert_leases.expires_at <= now()
      RETURNING lease_id, expires_at`;
    if (!row) throw new ApiError("CONFLICT", "another node holds the lease for this hostname");
    return { lease_id: row["lease_id"], expires_at: row["expires_at"] };
  });

  app.post("/dp/certs/lease/release", async (request, reply) => {
    const b = bodyOf(request);
    await sql`DELETE FROM apg_cert_leases WHERE hostname = ${String(b["hostname"] ?? "").toLowerCase()} AND lease_id = ${String(b["lease_id"] ?? "")}`;
    return reply.status(204).send();
  });

  app.post("/dp/certs", async (request, reply) => {
    const ctx = ctxOf(request);
    const b = bodyOf(request);
    const hostname = String(b["hostname"] ?? "").toLowerCase();
    const [lease] = await sql<Row[]>`
      SELECT 1 FROM apg_cert_leases WHERE hostname = ${hostname} AND lease_id = ${String(b["lease_id"] ?? "")} AND expires_at > now()`;
    if (!lease) throw new ApiError("CONFLICT", "the lease is missing or has expired; the certificate was not stored");

    // The certificate belongs to the workspace that owns the domain; a base
    // domain's wildcard belongs to the system workspace.
    const bare = hostname.replace(/^\*\./, "");
    const [owner] = await sql<Row[]>`SELECT workspace_id FROM apg_domains WHERE hostname = ${hostname} OR hostname = ${bare}`;
    const [system] = await sql<Row[]>`SELECT id FROM apg_workspaces WHERE system`;
    const workspaceId: string = owner?.["workspace_id"] ?? system!["id"];
    const name = `acme-${bare}`.slice(0, 128);

    const stored = await store.put(
      { ...ctx, actor: { ...ctx.actor, role: "admin", workspaces: "*" } },
      "certificate", workspaceId, name, { cert_pem: b["cert_pem"], key_pem: b["key_pem"] },
    );
    await sql`UPDATE apg_certificates SET source = 'acme' WHERE id = ${stored["id"]}`;
    await sql`DELETE FROM apg_cert_leases WHERE hostname = ${hostname}`;
    return reply.status(201).send({ id: stored["id"], not_after: stored["not_after"] });
  });

  // ── ACME challenges and account (spec §8.3, TLS-10) ────────────────────────

  app.post("/dp/acme/challenges", async (request, reply) => {
    const b = bodyOf(request);
    const token = String(b["token"] ?? "");
    const keyAuthorization = String(b["key_authorization"] ?? "");
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(token) || !keyAuthorization) throw new ApiError("VALIDATION_FAILED", "token and key_authorization are required");
    const ttl = Math.min(3600, Math.max(60, Number(b["ttl_secs"] ?? 600) || 600));
    const seq = await sql.begin(async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO apg_acme_challenges (token, key_authorization, expires_at)
        VALUES (${token}, ${keyAuthorization}, now() + make_interval(secs => ${ttl}))
        ON CONFLICT (token) DO UPDATE SET key_authorization = EXCLUDED.key_authorization, expires_at = EXCLUDED.expires_at
        RETURNING expires_at`;
      // Every node must be able to answer this token, whichever one the CA reaches.
      return store.emit(tx, { kind: "acme_challenge", op: "upsert", id: token, revision: 1, data: { token, key_authorization: keyAuthorization, expires_at: row!["expires_at"] } });
    });
    return reply.status(201).send({ seq });
  });

  app.delete("/dp/acme/challenges/:token", async (request, reply) => {
    const token = (request.params as Record<string, string>)["token"]!;
    await sql.begin(async (tx) => {
      const [row] = await tx<Row[]>`DELETE FROM apg_acme_challenges WHERE token = ${token} RETURNING token`;
      if (row) await store.emit(tx, { kind: "acme_challenge", op: "delete", id: token });
    });
    return reply.status(204).send();
  });

  // One ACME account for the fleet. The credentials are sealed by the node
  // that created them; the admin stores them without being able to read them.
  app.get("/dp/acme/account", async (request) => {
    const directory = String((request.query as Record<string, string | undefined>)["directory_url"] ?? "");
    const [row] = await sql<Row[]>`SELECT credentials_ciphertext FROM apg_acme_accounts WHERE directory_url = ${directory}`;
    if (!row) throw new ApiError("NOT_FOUND", "no ACME account is stored for this directory");
    return { directory_url: directory, credentials_ciphertext: row["credentials_ciphertext"] };
  });

  app.put("/dp/acme/account", async (request) => {
    const b = bodyOf(request);
    const directory = String(b["directory_url"] ?? "");
    const ciphertext = String(b["credentials_ciphertext"] ?? "");
    if (!directory || !ciphertext) throw new ApiError("VALIDATION_FAILED", "directory_url and credentials_ciphertext are required");
    // First writer wins; every caller gets the stored account back, so two
    // nodes racing to register end up sharing one.
    await sql`INSERT INTO apg_acme_accounts (directory_url, credentials_ciphertext) VALUES (${directory}, ${ciphertext}) ON CONFLICT DO NOTHING`;
    const [row] = await sql<Row[]>`SELECT credentials_ciphertext FROM apg_acme_accounts WHERE directory_url = ${directory}`;
    return { directory_url: directory, credentials_ciphertext: row!["credentials_ciphertext"] };
  });
}
