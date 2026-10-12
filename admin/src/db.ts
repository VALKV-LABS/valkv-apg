/**
 * Postgres access and the migration runner (spec DB-1).
 *
 * Migrations are numbered pairs `NNN_name.up.sql` / `NNN_name.down.sql`.
 * The runner holds an advisory lock, so several admin replicas starting at
 * once apply each migration exactly once.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/** A connection pool. */
export type Sql = postgres.Sql;
/** A transaction handle; usable wherever a pool is, for queries. */
export type Tx = postgres.TransactionSql;
/** Either a pool or a transaction. */
export type Db = Sql | Tx;

const MIGRATION_LOCK = 4_271_001; // arbitrary, fixed

/** Opens a pool. BIGINT columns are returned as numbers: changelog sequences stay well inside 2^53. */
export function connect(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    onnotice: () => {},
    types: {
      bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
    },
    transform: { undefined: null },
  });
}

/** Where migration files live: `APG_MIGRATIONS_DIR`, or `admin/migrations`. */
export function defaultMigrationsDir(): string {
  return process.env["APG_MIGRATIONS_DIR"] ?? fileURLToPath(new URL("../migrations/", import.meta.url));
}

interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

function loadMigrations(dir: string): Migration[] {
  const byVersion = new Map<number, Partial<Migration>>();
  for (const file of readdirSync(dir)) {
    const m = /^(\d{3})_([a-z0-9_]+)\.(up|down)\.sql$/.exec(file);
    if (!m) continue;
    const version = Number(m[1]);
    const entry = byVersion.get(version) ?? { version, name: m[2]! };
    entry[m[3] as "up" | "down"] = readFileSync(join(dir, file), "utf8");
    byVersion.set(version, entry);
  }
  const list = [...byVersion.values()].sort((a, b) => a.version! - b.version!);
  for (const m of list) {
    if (!m.up || !m.down) throw new Error(`migration ${m.version} needs both an .up.sql and a .down.sql file`);
  }
  return list as Migration[];
}

async function withLock<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`CREATE TABLE IF NOT EXISTS apg_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    return fn(tx);
  })) as T;
}

/** Applies every migration not yet applied. Returns the versions it applied. */
export async function migrateUp(sql: Sql, dir = defaultMigrationsDir()): Promise<number[]> {
  const migrations = loadMigrations(dir);
  return withLock(sql, async (tx) => {
    const done = new Set((await tx<{ version: number }[]>`SELECT version FROM apg_migrations`).map((r) => r.version));
    const applied: number[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await tx.unsafe(m.up);
      await tx`INSERT INTO apg_migrations (version, name) VALUES (${m.version}, ${m.name})`;
      applied.push(m.version);
    }
    return applied;
  });
}

/** Reverts the most recent `steps` migrations. Returns the versions it reverted. */
export async function migrateDown(sql: Sql, steps = 1, dir = defaultMigrationsDir()): Promise<number[]> {
  const migrations = loadMigrations(dir);
  return withLock(sql, async (tx) => {
    const done = (await tx<{ version: number }[]>`SELECT version FROM apg_migrations ORDER BY version DESC`).map((r) => r.version);
    const reverted: number[] = [];
    for (const version of done.slice(0, steps)) {
      const m = migrations.find((x) => x.version === version);
      if (!m) throw new Error(`no migration file for applied version ${version}`);
      await tx.unsafe(m.down);
      await tx`DELETE FROM apg_migrations WHERE version = ${version}`;
      reverted.push(version);
    }
    return reverted;
  });
}

/** Lists every known migration and whether it is applied. */
export async function migrateStatus(sql: Sql, dir = defaultMigrationsDir()): Promise<Array<{ version: number; name: string; applied: boolean }>> {
  const migrations = loadMigrations(dir);
  return withLock(sql, async (tx) => {
    const done = new Set((await tx<{ version: number }[]>`SELECT version FROM apg_migrations`).map((r) => r.version));
    return migrations.map((m) => ({ version: m.version, name: m.name, applied: done.has(m.version) }));
  });
}

/** The identity of this control plane (spec CFG-10). */
export async function clusterId(db: Db): Promise<string> {
  const [row] = await db<{ value: string }[]>`SELECT value FROM apg_meta WHERE key = 'cluster_id'`;
  if (!row) throw new Error("apg_meta has no cluster_id; migrations have not run");
  return row.value;
}
