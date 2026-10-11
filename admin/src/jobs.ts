/**
 * Background jobs (spec §13.6).
 *
 * The admin may run as several replicas. Each run of a job takes a
 * transaction-scoped advisory lock first, so exactly one replica does the
 * work and the others skip that tick (spec API-11).
 */

import type { Sql, Tx } from "./db.js";
import type { Store } from "./store.js";
import { rollup } from "./usage.js";

/** One job: a name, how often it runs, and what it does. Returns a count for the log. */
export interface Job {
  name: string;
  everyMs: number;
  run: (tx: Tx) => Promise<number>;
}

/** Options the jobs need from configuration. */
export interface JobSettings {
  changelogRetentionHours: number;
  nodeSlotTtlHours: number;
  auditRetentionDays: number;
  usageRollupSecs?: number;
  usageRawRetentionDays?: number;
  usageHourlyRetentionDays?: number;
}

/** Postgres slot names allow only lower-case letters, digits and underscores. Must match the node's own derivation. */
export function slotNameFor(nodeId: string): string {
  return "apg_slot_" + nodeId.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

export function buildJobs(store: Store, s: JobSettings): Job[] {
  return [
    {
      // spec CFG-9. A node that falls behind what is kept gets RESYNC_REQUIRED and snapshots.
      name: "changelog_retention",
      everyMs: 10 * 60_000,
      run: async (tx) => (await tx`DELETE FROM apg_changes WHERE created_at < now() - make_interval(hours => ${s.changelogRetentionHours})`).count,
    },
    {
      name: "cert_lease_sweep",
      everyMs: 60_000,
      run: async (tx) => (await tx`DELETE FROM apg_cert_leases WHERE expires_at <= now()`).count,
    },
    {
      // Expired challenges are removed from nodes too, so the table nodes hold stays small.
      name: "acme_challenge_sweep",
      everyMs: 60_000,
      run: async (tx) => {
        const rows = await tx<{ token: string }[]>`DELETE FROM apg_acme_challenges WHERE expires_at <= now() RETURNING token`;
        for (const r of rows) await store.emit(tx, { kind: "acme_challenge", op: "delete", id: r.token });
        return rows.length;
      },
    },
    {
      name: "audit_retention",
      everyMs: 6 * 3600_000,
      run: async (tx) => (await tx`DELETE FROM apg_audit_log WHERE ts < now() - make_interval(days => ${s.auditRetentionDays})`).count,
    },
    {
      // spec USG-6. Hours and days that received usage lately are rebuilt by overwrite.
      name: "usage_rollup",
      everyMs: (s.usageRollupSecs ?? 60) * 1000,
      run: async (tx) => rollup(tx),
    },
    {
      name: "usage_retention",
      everyMs: 3600_000,
      run: async (tx) =>
        (await tx`DELETE FROM apg_usage_raw WHERE window_start < now() - make_interval(days => ${s.usageRawRetentionDays ?? 7})`).count +
        (await tx`DELETE FROM apg_usage_hourly WHERE bucket < now() - make_interval(days => ${s.usageHourlyRetentionDays ?? 400})`).count,
    },
    {
      name: "idempotency_cleanup",
      everyMs: 3600_000,
      run: async (tx) => (await tx`DELETE FROM apg_idempotency_keys WHERE created_at < now() - interval '24 hours'`).count,
    },
    {
      // spec CFG-15. An inactive slot pins WAL until the disk fills; drop the
      // slot of any node that has been silent past the TTL, or was never seen.
      name: "replication_slot_reaper",
      everyMs: 10 * 60_000,
      run: async (tx) => {
        const slots = await tx<{ slot_name: string }[]>`
          SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE 'apg\_slot\_%' AND NOT active`;
        if (slots.length === 0) return 0;
        const alive = new Set(
          (await tx<{ node_id: string }[]>`SELECT node_id FROM apg_nodes WHERE last_seen > now() - make_interval(hours => ${s.nodeSlotTtlHours})`)
            .map((n) => slotNameFor(n.node_id)),
        );
        let dropped = 0;
        for (const { slot_name } of slots) {
          if (alive.has(slot_name)) continue;
          await tx`SELECT pg_drop_replication_slot(${slot_name})`;
          dropped++;
        }
        return dropped;
      },
    },
  ];
}

/** Runs jobs on their intervals until stopped. */
export class JobRunner {
  private timers: NodeJS.Timeout[] = [];
  /** Unix seconds of each job's last successful run; exported as a metric. */
  readonly lastSuccess = new Map<string, number>();
  readonly failures = new Map<string, number>();

  constructor(
    private readonly sql: Sql,
    private readonly jobs: Job[],
    private readonly log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void },
  ) {}

  start(): void {
    for (const job of this.jobs) {
      // Jitter the first run so replicas started together do not all wake at once.
      const first = setTimeout(() => {
        void this.runOnce(job);
        this.timers.push(setInterval(() => void this.runOnce(job), job.everyMs));
      }, Math.random() * Math.min(job.everyMs, 15_000));
      this.timers.push(first);
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Runs one job now if no other replica is running it. Returns the job's count, or null if skipped. */
  async runOnce(job: Job): Promise<number | null> {
    try {
      const result = (await this.sql.begin(async (tx) => {
        const [lock] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${"apg_job:" + job.name})) AS ok`;
        if (!lock!.ok) return null;
        return job.run(tx);
      })) as number | null;
      if (result !== null) {
        this.lastSuccess.set(job.name, Math.floor(Date.now() / 1000));
        if (result > 0) this.log.info({ job: job.name, affected: result }, "job ran");
      }
      return result;
    } catch (err) {
      this.failures.set(job.name, (this.failures.get(job.name) ?? 0) + 1);
      this.log.error({ job: job.name, err }, "job failed");
      return null;
    }
  }
}
