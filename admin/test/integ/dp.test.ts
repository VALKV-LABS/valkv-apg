// Data-plane API, migrations and jobs against a real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, migrateDown, migrateStatus, migrateUp } from "../../src/db.js";
import { buildJobs } from "../../src/jobs.js";
import { type Harness, fixture, start } from "./harness.js";

let h: Harness;
const D = "/v1/workspaces/default";
const node = () => ({ token: h.tokens.node });

beforeAll(async () => {
  h = await start("dp");
});
afterAll(async () => h.close());

describe("migrations", () => {
  it("apply, revert and re-apply cleanly on an empty database (DB-1)", async () => {
    const root = connect(process.env["APG_TEST_DATABASE_URL"] ?? "postgres://apg:apg-dev-only@postgres:5432/apg", 1);
    await root.unsafe("DROP DATABASE IF EXISTS apg_test_migrations WITH (FORCE)");
    await root.unsafe("CREATE DATABASE apg_test_migrations");
    await root.end();
    const url = new URL(process.env["APG_TEST_DATABASE_URL"] ?? "postgres://apg:apg-dev-only@postgres:5432/apg");
    url.pathname = "/apg_test_migrations";
    const sql = connect(url.href, 2);
    try {
      expect(await migrateUp(sql)).toEqual([1, 2, 3, 4]);
      expect(await migrateUp(sql)).toEqual([]); // idempotent
      const tables = async () => (await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'apg\_%' AND table_name <> 'apg_migrations'`)[0]!["n"];
      expect(await tables()).toBeGreaterThan(15);
      expect((await migrateDown(sql, 4)).sort()).toEqual([1, 2, 3, 4]);
      expect(await tables()).toBe(0);
      expect(await migrateUp(sql)).toEqual([1, 2, 3, 4]);
      expect((await migrateStatus(sql)).every((m) => m.applied)).toBe(true);
      // the system workspace and the cluster identity exist from the first migration
      expect((await sql`SELECT name FROM apg_workspaces WHERE system`)[0]!["name"]).toBe("default");
      expect((await sql`SELECT value FROM apg_meta WHERE key = 'cluster_id'`)[0]!["value"]).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await sql.end();
    }
  });

  it("two replicas migrating at once apply each migration exactly once", async () => {
    const root = connect(process.env["APG_TEST_DATABASE_URL"] ?? "postgres://apg:apg-dev-only@postgres:5432/apg", 1);
    await root.unsafe("DROP DATABASE IF EXISTS apg_test_race WITH (FORCE)");
    await root.unsafe("CREATE DATABASE apg_test_race");
    await root.end();
    const url = new URL(process.env["APG_TEST_DATABASE_URL"] ?? "postgres://apg:apg-dev-only@postgres:5432/apg");
    url.pathname = "/apg_test_race";
    const a = connect(url.href, 2);
    const b = connect(url.href, 2);
    try {
      const results = await Promise.all([migrateUp(a), migrateUp(b)]);
      expect(results.flat().sort()).toEqual([1, 2, 3, 4]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe("access", () => {
  it("only node tokens (and fleet admins, for diagnosis) reach /dp", async () => {
    expect((await h.call("GET", "/dp/changes", { token: null })).status).toBe(401);
    const editor = await h.token("editor");
    expect((await h.call("GET", "/dp/changes", { token: editor })).status).toBe(403);
    expect((await h.call("GET", "/dp/changes", node())).status).toBe(204);
    expect((await h.call("GET", "/dp/changes")).status).toBe(204);
  });
});

describe("changes", () => {
  it("returns rows after `since` in order, pages with has_more, and 204 when caught up", async () => {
    const start = await h.lastSeq();
    for (const n of ["a", "b", "c"]) await h.call("PUT", `${D}/services/svc-${n}`, { body: { backends: [{ target: "10.0.0.1:80" }] } });
    const all = await h.call("GET", `/dp/changes?since=${start}`, node());
    expect(all.status).toBe(200);
    expect(all.json.changes.map((c: any) => c.data.data.name)).toEqual(["svc-a", "svc-b", "svc-c"]);
    expect(all.json.changes.map((c: any) => c.seq)).toEqual([start + 1, start + 2, start + 3]);
    expect(all.json).toMatchObject({ last_seq: start + 3, has_more: false });

    const page = await h.call("GET", `/dp/changes?since=${start}&limit=2`, node());
    expect(page.json).toMatchObject({ last_seq: start + 2, has_more: true });
    expect((await h.call("GET", `/dp/changes?since=${start + 3}`, node())).status).toBe(204);
  });

  it("a long poll returns as soon as a change commits, not after the full wait", async () => {
    const since = await h.lastSeq();
    const started = Date.now();
    const pending = h.call("GET", `/dp/changes?since=${since}&wait_ms=10000`, node());
    await new Promise((r) => setTimeout(r, 300));
    await h.call("PUT", "/v1/flags/access_log", { body: { enabled: false } });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.json.changes[0].data).toMatchObject({ kind: "flag", id: "access_log" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a long poll with nothing new returns 204 after the wait", async () => {
    const since = await h.lastSeq();
    const started = Date.now();
    const res = await h.call("GET", `/dp/changes?since=${since}&wait_ms=400`, node());
    expect(res.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("a position ahead of the newest row means the database was restored: resync (CFG-9)", async () => {
    const res = await h.call("GET", `/dp/changes?since=${(await h.lastSeq()) + 100}`, node());
    expect(res.status).toBe(410);
    expect(res.json.error.code).toBe("RESYNC_REQUIRED");
  });

  it("rejects malformed parameters", async () => {
    for (const q of ["since=-1", "since=abc", "limit=0", "limit=5000"]) {
      expect((await h.call("GET", `/dp/changes?${q}`, node())).status, q).toBe(400);
    }
  });

  it("concurrent writers never produce a row a reader could skip: seq order is commit order", async () => {
    const start = await h.lastSeq();
    await Promise.all(Array.from({ length: 12 }, (_, i) => h.call("PUT", `${D}/services/par-${i}`, { body: { backends: [{ target: "10.0.0.2:80" }] } })));
    const rows = await h.events(start);
    expect(rows).toHaveLength(12);
    // contiguous: no gap a late-committing transaction could fill behind a reader
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => start + 1 + i));
    expect(await h.lastSeq()).toBe(start + 12);
  });
});

describe("snapshot", () => {
  it("is the state at one seq, lists referenced resources before their referrers, and holds no clear secret", async () => {
    await h.call("POST", `${D}/certificates`, { body: { name: "snap", cert_pem: fixture("test-cert.crt"), key_pem: fixture("test-cert.key") } });
    await h.call("PUT", `${D}/routes/snap-route`, { body: { service: "svc-a", hosts: ["snap.example.com"] } });
    await h.call("POST", `${D}/plugins`, { body: { type: "rate_limit", scope: "route", scope_ref: "snap-route" } });
    await h.call("POST", `${D}/consumers`, { body: { name: "snap-consumer" } });
    await h.call("POST", `${D}/consumers/snap-consumer/credentials`, { body: { type: "key" } });

    const res = await h.call("GET", "/dp/snapshot", node());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    const header = lines[0];
    expect(header.cluster_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(header.seq).toBe(await h.lastSeq());

    const events = lines.slice(1);
    expect(events.every((e) => e.v === 2 && e.op === "upsert")).toBe(true);
    const first = (kind: string) => events.findIndex((e) => e.kind === kind);
    expect(first("workspace")).toBeLessThan(first("service"));
    expect(first("service")).toBeLessThan(first("route"));
    expect(first("route")).toBeLessThan(first("plugin"));
    expect(first("consumer")).toBeLessThan(first("credential"));
    expect(first("certificate")).toBeGreaterThan(-1);
    expect(res.text).not.toContain("PRIVATE KEY");

    // every line is a valid contract-2 event
    for (const e of events) expect(h.store.deps.schemas.validate("changelog-event.json", e), JSON.stringify(e).slice(0, 80)).toEqual([]);
    // and the snapshot agrees with the resource tables
    expect(events.filter((e) => e.kind === "service").length).toBe((await h.sql`SELECT count(*)::int AS n FROM apg_services`)[0]!["n"]);
  });
});

describe("nodes", () => {
  it("heartbeats register nodes, and lag is the distance to the newest change", async () => {
    const last = await h.lastSeq();
    expect((await h.call("POST", "/dp/heartbeat", { ...node(), body: { node_id: "n1", version: "0.1.0", source: "api_poll", applied_seq: last, region: "eu" } })).status).toBe(204);
    expect((await h.call("POST", "/dp/heartbeat", { ...node(), body: { node_id: "n2", version: "0.1.0", source: "api_poll", applied_seq: last - 3, stale: true } })).status).toBe(204);
    const nodes = (await h.call("GET", "/v1/nodes")).json;
    expect(nodes.data.map((n: any) => [n.node_id, n.lag, n.live, n.stale])).toEqual([["n1", 0, true, false], ["n2", 3, true, true]]);
    expect((await h.call("GET", "/dp/nodes/applied", node())).json).toEqual({ min_applied_seq: last - 3, live_nodes: 2 });
    expect((await h.call("POST", "/dp/heartbeat", { ...node(), body: { applied_seq: 1 } })).status).toBe(422);
  });
});

describe("backend health", () => {
  // spec OBS-4
  it("puts what each live node reports side by side, and claims nothing nobody reported", async () => {
    const created = await h.call("POST", "/v1/workspaces/default/services", { body: { name: "health-svc", backends: [{ target: "10.0.0.1:80" }, { target: "10.0.0.2:80" }, { target: "10.0.0.3:80", status: "down" }], health_check: { active: { type: "tcp" } } } });
    expect(created.status).toBe(201);
    const id = created.json.id;
    await h.call("POST", "/v1/workspaces/default/services", { body: { name: "health-unseen", backends: [{ target: "10.0.0.9:80" }] } });
    const report = (backends: unknown[]) => [{ service_id: id, name: "health-svc", backends }];
    const beat = (nodeId: string, backends: unknown[]) => h.call("POST", "/dp/heartbeat", { ...node(), body: { node_id: nodeId, applied_seq: 1, backends: report(backends) } });
    await beat("h1", [
      { target: "10.0.0.1:80", state: "healthy", in_rotation: true, health_check: true, circuit: "closed", seen_at: 1760000000 },
      { target: "10.0.0.2:80", state: "healthy", in_rotation: true, health_check: true, circuit: "closed" },
    ]);
    await beat("h2", [
      { target: "10.0.0.1:80", state: "unhealthy", reason: "connection refused", in_rotation: false, health_check: true, circuit: "open" },
      { target: "10.0.0.2:80", state: "healthy", in_rotation: true, health_check: true, circuit: "closed" },
    ]);
    // A node from before per-backend reports says nothing about any backend.
    await h.call("POST", "/dp/heartbeat", { ...node(), body: { node_id: "h-old", applied_seq: 1, backends: [{ service_id: id, name: "health-svc", healthy: 2, unhealthy: 0 }] } });

    const one = (await h.call("GET", "/v1/workspaces/default/services/health-svc/health")).json;
    expect([one.state, one.healthy, one.unhealthy, one.unknown, one.health_check]).toEqual(["unhealthy", 1, 1, 0, true]);
    const [first, second, third] = one.backends;
    expect([first.target, first.state, first.reason]).toEqual(["10.0.0.1:80", "unhealthy", "connection refused"]);
    expect(first.nodes.map((n: any) => [n.node_id, n.state, n.in_rotation])).toEqual([["h1", "healthy", true], ["h2", "unhealthy", false]]);
    expect(first.nodes[0].seen_at).toBe("2025-10-09T08:53:20.000Z");
    expect([second.state, second.reason]).toEqual(["healthy", undefined]);
    expect([third.state, third.nodes]).toEqual(["down", []]);
    expect(one.live_nodes).toBeGreaterThanOrEqual(3);
    expect((await h.call("GET", `/v1/workspaces/default/services/${id}/health`)).json.name).toBe("health-svc");

    const all = (await h.call("GET", "/v1/workspaces/default/health")).json;
    const unseen = all.data.find((s: any) => s.name === "health-unseen");
    expect([unseen.state, unseen.unknown, unseen.health_check, unseen.nodes_reporting]).toEqual(["unknown", 1, false, 0]);
    expect(all.data.find((s: any) => s.name === "health-svc").state).toBe("unhealthy");

    // A node that stopped reporting is not counted.
    await h.sql`UPDATE apg_nodes SET last_seen = now() - interval '5 minutes' WHERE node_id = 'h2'`;
    expect((await h.call("GET", "/v1/workspaces/default/services/health-svc/health")).json.state).toBe("healthy");

    // Readable by a viewer of the workspace and by nobody outside it.
    const viewer = await h.token("viewer", [(await h.call("GET", "/v1/workspaces/default")).json.id]);
    expect((await h.call("GET", "/v1/workspaces/default/health", { token: viewer })).status).toBe(200);
    await h.call("POST", "/v1/workspaces", { body: { name: "health-other" } });
    expect((await h.call("GET", "/v1/workspaces/health-other/health", { token: viewer })).status).toBe(404);
    expect((await h.call("GET", "/v1/workspaces/default/services/no-such/health")).status).toBe(404);
  });
});

describe("certificate coordination", () => {
  it("one node holds a lease; a second is refused until it expires or is released", async () => {
    const a = await h.call("POST", "/dp/certs/lease", { ...node(), body: { hostname: "lease.example.com", node_id: "n1" } });
    expect(a.status).toBe(200);
    expect((await h.call("POST", "/dp/certs/lease", { ...node(), body: { hostname: "lease.example.com", node_id: "n2" } })).status).toBe(409);
    await h.call("POST", "/dp/certs/lease/release", { ...node(), body: { hostname: "lease.example.com", lease_id: a.json.lease_id } });
    expect((await h.call("POST", "/dp/certs/lease", { ...node(), body: { hostname: "lease.example.com", node_id: "n2" } })).status).toBe(200);
    // an expired lease can be taken over, so a crashed issuer blocks a host for a bounded time
    await h.sql`UPDATE apg_cert_leases SET expires_at = now() - interval '1 second' WHERE hostname = 'lease.example.com'`;
    expect((await h.call("POST", "/dp/certs/lease", { ...node(), body: { hostname: "lease.example.com", node_id: "n1" } })).status).toBe(200);
  });

  it("a certificate is accepted only from the lease holder, stored encrypted, and announced to every node", async () => {
    const cert = fixture("test-cert.crt");
    const key = fixture("test-cert.key");
    const noLease = await h.call("POST", "/dp/certs", { ...node(), body: { hostname: "api.example.com", lease_id: "00000000-0000-0000-0000-000000000000", cert_pem: cert, key_pem: key } });
    expect(noLease.status).toBe(409);

    const lease = (await h.call("POST", "/dp/certs/lease", { ...node(), body: { hostname: "api.example.com", node_id: "n1" } })).json;
    const before = await h.lastSeq();
    const stored = await h.call("POST", "/dp/certs", { ...node(), body: { hostname: "api.example.com", lease_id: lease.lease_id, cert_pem: cert, key_pem: key } });
    expect(stored.status).toBe(201);
    const [event] = await h.events(before);
    expect(event!.data).toMatchObject({ kind: "certificate", op: "upsert" });
    expect(JSON.stringify(event)).not.toContain("PRIVATE KEY");
    expect((await h.sql`SELECT source FROM apg_certificates WHERE name = 'acme-api.example.com'`)[0]!["source"]).toBe("acme");
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_cert_leases WHERE hostname = 'api.example.com'`)[0]!["n"]).toBe(0);
  });

  it("an ACME challenge is announced to every node and withdrawn afterwards (TLS-10)", async () => {
    const before = await h.lastSeq();
    const res = await h.call("POST", "/dp/acme/challenges", { ...node(), body: { token: "tok_abcdefgh", key_authorization: "tok_abcdefgh.thumb" } });
    expect(res.status).toBe(201);
    expect(res.json.seq).toBe(before + 1);
    expect((await h.call("DELETE", "/dp/acme/challenges/tok_abcdefgh", node())).status).toBe(204);
    const events = await h.events(before);
    expect(events.map((e) => `${e.data["kind"]}:${e.data["op"]}`)).toEqual(["acme_challenge:upsert", "acme_challenge:delete"]);
    expect(events[0]!.data["data"]).toMatchObject({ token: "tok_abcdefgh", key_authorization: "tok_abcdefgh.thumb" });
  });

  it("the fleet shares one ACME account: the first writer wins and everyone reads it back", async () => {
    const q = "directory_url=https%3A%2F%2Facme.test%2Fdir";
    expect((await h.call("GET", `/dp/acme/account?${q}`, node())).status).toBe(404);
    const a = await h.call("PUT", "/dp/acme/account", { ...node(), body: { directory_url: "https://acme.test/dir", credentials_ciphertext: "v1:first" } });
    const b = await h.call("PUT", "/dp/acme/account", { ...node(), body: { directory_url: "https://acme.test/dir", credentials_ciphertext: "v1:second" } });
    expect([a.json.credentials_ciphertext, b.json.credentials_ciphertext]).toEqual(["v1:first", "v1:first"]);
    expect((await h.call("GET", `/dp/acme/account?${q}`, node())).json.credentials_ciphertext).toBe("v1:first");
  });
});

describe("jobs", () => {
  const job = (name: string) => buildJobs(h.store, { changelogRetentionHours: 1, nodeSlotTtlHours: 1, auditRetentionDays: 1 }).find((j) => j.name === name)!;

  it("retention removes old changelog rows, and a reader behind them is told to resync", async () => {
    const last = await h.lastSeq();
    await h.sql`UPDATE apg_changes SET created_at = now() - interval '2 hours' WHERE seq <= ${last - 2}`;
    expect(await h.jobs.runOnce(job("changelog_retention"))).toBe(last - 2);
    const oldest = (await h.sql`SELECT min(seq)::int AS s FROM apg_changes`)[0]!["s"];
    expect(oldest).toBe(last - 1);
    expect((await h.call("GET", "/dp/changes?since=0", node())).status).toBe(410);
    expect((await h.call("GET", `/dp/changes?since=${oldest - 1}`, node())).status).toBe(200);
    // a snapshot still has everything
    expect((await h.call("GET", "/dp/snapshot", node())).text).toContain("svc-a");
  });

  it("when retention has removed every row, the watermark still decides who must resync", async () => {
    await h.sql`UPDATE apg_changes SET created_at = now() - interval '2 hours'`;
    await h.jobs.runOnce(job("changelog_retention"));
    const last = await h.lastSeq();
    expect((await h.call("GET", `/dp/changes?since=${last}`, node())).status).toBe(204);
    expect((await h.call("GET", `/dp/changes?since=${last - 1}`, node())).status).toBe(410);
  });

  it("expired ACME challenges are swept and nodes are told", async () => {
    await h.call("POST", "/dp/acme/challenges", { ...node(), body: { token: "tok_expiring", key_authorization: "x.y" } });
    await h.sql`UPDATE apg_acme_challenges SET expires_at = now() - interval '1 second'`;
    const before = await h.lastSeq();
    expect(await h.jobs.runOnce(job("acme_challenge_sweep"))).toBe(1);
    expect((await h.events(before)).map((e) => e.data)).toEqual([{ v: 2, kind: "acme_challenge", op: "delete", id: "tok_expiring" }]);
  });

  it("only one replica runs a job at a time", async () => {
    const slow = { name: "slow", everyMs: 1000, run: async () => { await new Promise((r) => setTimeout(r, 400)); return 1; } };
    const [a, b] = await Promise.all([h.jobs.runOnce(slow), h.jobs.runOnce(slow)]);
    expect([a, b].sort()).toEqual([1, null]);
  });

  it("drops the replication slot of a node that has gone silent, and keeps a live node's (CFG-15)", async () => {
    await h.sql`SELECT pg_create_logical_replication_slot('apg_slot_dead_node', 'pgoutput')`;
    await h.sql`SELECT pg_create_logical_replication_slot('apg_slot_n1', 'pgoutput')`;
    try {
      await h.call("POST", "/dp/heartbeat", { ...node(), body: { node_id: "n1", applied_seq: 0 } });
      expect(await h.jobs.runOnce(job("replication_slot_reaper"))).toBe(1);
      const left = (await h.sql`SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE 'apg\_slot\_%'`).map((r) => r["slot_name"]);
      expect(left).toEqual(["apg_slot_n1"]);
    } finally {
      await h.sql`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'apg\_slot\_%'`;
    }
  });
});

describe("metrics and OpenAPI", () => {
  it("exposes fleet gauges without authentication, and serves the API description", async () => {
    const m = await h.call("GET", "/metrics", { token: null });
    expect(m.status).toBe(200);
    for (const name of ["apg_admin_requests_total", "apg_changes_max_seq", "apg_nodes_live", "apg_job_last_success_timestamp_seconds"]) expect(m.text).toContain(name);
    const api = await h.call("GET", "/v1/openapi.json", { token: null });
    expect(api.json.openapi).toBe("3.1.0");
    expect(api.json.paths["/v1/workspaces/{ws}/routes"]).toBeDefined();
  });
});

describe("usage (spec §11)", () => {
  const job = (name: string) => buildJobs(h.store, { changelogRetentionHours: 1, nodeSlotTtlHours: 1, auditRetentionDays: 1, usageRawRetentionDays: 7, usageHourlyRetentionDays: 400 }).find((j) => j.name === name)!;

  it("a window is stored once however often it is sent, rolled up by overwrite, and answerable per caller", async () => {
    const ws = (await h.call("POST", "/v1/workspaces", { body: { name: "usage-ws" } })).json;
    const start = Math.floor(Date.now() / 60_000) * 60 - 120;
    const window = (nodeId: string, requests: number) => ({
      node_id: nodeId, region: "eu", window_start: start, interval_secs: 60,
      rows: [
        { workspace_id: ws.id, service_id: "s1", route_id: "r1", requests, bytes_in: 10, bytes_out: 100, status_2xx: requests, latency_ms_sum: 50, upstream_latency_ms_sum: 40 },
        { workspace_id: "another-workspace", service_id: "s9", route_id: "r9", consumer_id: "c9", requests: 7, status_5xx: 7 },
      ],
    });
    expect((await h.call("POST", "/dp/usage", { ...node(), body: window("n1", 2) })).status).toBe(204);
    // The node retries, this time with the final figures: the row is replaced, not added to (USG-4).
    expect((await h.call("POST", "/dp/usage", { ...node(), body: window("n1", 3) })).status).toBe(204);
    expect((await h.call("POST", "/dp/usage", { ...node(), body: window("n2", 5) })).status).toBe(204);

    const minute = await h.call("GET", `/v1/usage?granularity=minute&group_by=route&workspace=${ws.id}`);
    expect(minute.status).toBe(200);
    expect(minute.json.data).toHaveLength(1);
    expect(minute.json.data[0]).toMatchObject({ route_id: "r1", requests: 8, bytes_in: 20, bytes_out: 200, status_2xx: 8, latency_ms_sum: 100 });

    // Rolled up; running the job again changes nothing (USG-6).
    await h.jobs.runOnce(job("usage_rollup"));
    await h.jobs.runOnce(job("usage_rollup"));
    const hour = await h.call("GET", "/v1/usage?granularity=hour&group_by=workspace,region");
    const byWorkspace = Object.fromEntries(hour.json.data.map((r: any) => [r.workspace_id, r]));
    expect(byWorkspace[ws.id]).toMatchObject({ region: "eu", requests: 8 });
    expect(byWorkspace["another-workspace"]).toMatchObject({ requests: 14, status_5xx: 14 });
    const day = await h.call("GET", `/v1/usage?granularity=day&workspace=${ws.id}`);
    expect(day.json.data).toHaveLength(1);
    expect(day.json.data[0].requests).toBe(8);
    // A late correction re-rolls its hour.
    await h.call("POST", "/dp/usage", { ...node(), body: window("n2", 6) });
    await h.jobs.runOnce(job("usage_rollup"));
    expect((await h.call("GET", `/v1/usage?granularity=hour&workspace=${ws.id}`)).json.data[0].requests).toBe(9);
    // Filters.
    expect((await h.call("GET", "/v1/usage?granularity=minute&consumer=c9&group_by=consumer")).json.data[0]).toMatchObject({ consumer_id: "c9", requests: 14 });
    expect((await h.call("GET", "/v1/usage?granularity=minute&route=no-such-route")).json.data).toEqual([]);

    // A workspace-scoped caller sees its own workspace and has to name it.
    const viewer = await h.token("viewer", [ws.id]);
    expect((await h.call("GET", `/v1/usage?workspace=${ws.id}`, { token: viewer })).status).toBe(200);
    expect((await h.call("GET", "/v1/usage", { token: viewer })).status).toBe(403);
    expect((await h.call("GET", "/v1/usage?workspace=default", { token: viewer })).status).toBe(404);
  });

  it("only nodes report usage, and malformed reports are refused whole", async () => {
    const editor = await h.token("editor");
    expect((await h.call("POST", "/dp/usage", { token: editor, body: { node_id: "n1", window_start: 1, interval_secs: 60, rows: [] } })).status).toBe(403);
    const bad = async (body: unknown) => (await h.call("POST", "/dp/usage", { ...node(), body })).status;
    const row = { workspace_id: "w", service_id: "s", route_id: "r" };
    expect(await bad({ node_id: "n1", window_start: 1_800_000_000, interval_secs: 60, rows: [{ ...row, requests: -1 }] })).toBe(422);
    expect(await bad({ node_id: "n1", window_start: 1_800_000_000, interval_secs: 60, rows: [{ service_id: "s", route_id: "r" }] })).toBe(422);
    expect(await bad({ window_start: 1_800_000_000, interval_secs: 60, rows: [row] })).toBe(422);
    expect(await bad({ node_id: "n1", window_start: "soon", interval_secs: 60, rows: [row] })).toBe(422);
    expect(await bad({ node_id: "n1", window_start: 1_800_000_000, interval_secs: 0, rows: [row] })).toBe(422);
    expect((await h.call("GET", "/v1/usage?granularity=second")).status).toBe(400);
    expect((await h.call("GET", "/v1/usage?group_by=colour")).status).toBe(400);
    expect((await h.call("GET", "/v1/usage?from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z")).status).toBe(400);
  });

  it("retention removes raw windows past their age", async () => {
    await h.sql`UPDATE apg_usage_raw SET window_start = now() - interval '8 days' WHERE node_id = 'n1'`;
    expect(await h.jobs.runOnce(job("usage_retention"))).toBeGreaterThanOrEqual(2);
    expect((await h.sql`SELECT count(*)::int AS n FROM apg_usage_raw WHERE node_id = 'n1'`)[0]!["n"]).toBe(0);
  });
});
