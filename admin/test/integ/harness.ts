// Shared setup for integration tests: a real Postgres, a freshly migrated
// schema, the full server, and one token per role. No SQL is mocked (spec DB-6).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { Authenticator, createToken } from "../../src/auth.js";
import type { UiConfig } from "../../src/config.js";
import { SecretBox } from "../../src/crypto.js";
import { type Sql, connect, migrateUp } from "../../src/db.js";
import { parseCidrList } from "../../src/egress.js";
import { JobRunner, buildJobs } from "../../src/jobs.js";
import { ChangeNotifier } from "../../src/routes/dp.js";
import { SchemaRegistry } from "../../src/schemas.js";
import { buildServer } from "../../src/server.js";
import { type Json, Store } from "../../src/store.js";

export const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

export interface Harness {
  sql: Sql;
  app: FastifyInstance;
  store: Store;
  jobs: JobRunner;
  notifier: ChangeNotifier;
  tokens: { admin: string; node: string };
  /** DNS answers used by the egress guard; tests set entries as needed. */
  dns: Map<string, string[]>;
  txt: Map<string, string[][]>;
  call: (method: string, url: string, opts?: { token?: string | null; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; json: any; text: string; headers: Record<string, any> }>;
  /** Changelog events with seq greater than `after`, oldest first. */
  events: (after?: number) => Promise<Array<{ seq: number; data: Json }>>;
  lastSeq: () => Promise<number>;
  token: (role: "admin" | "editor" | "viewer" | "node", workspaces?: string[]) => Promise<string>;
  close: () => Promise<void>;
}

const BASE_URL = process.env["APG_TEST_DATABASE_URL"] ?? "postgres://apg:apg-dev-only@postgres:5432/apg";

/** Creates an empty database named after the test file, migrates it, and starts the server on it. */
export async function start(name: string, opts: { domainVerification?: "none" | "dns_txt"; ui?: UiConfig; debugNodeUrl?: string } = {}): Promise<Harness> {
  const dbName = `apg_test_${name}`;
  const root = connect(BASE_URL, 1);
  await root.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE ${dbName}`);
  await root.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  const sql = connect(url.href);
  await migrateUp(sql);

  const dns = new Map<string, string[]>();
  const txt = new Map<string, string[][]>();
  const schemas = new SchemaRegistry(fileURLToPath(new URL("../../../schemas/", import.meta.url)));
  const store = new Store({
    sql,
    schemas,
    box: new SecretBox(Buffer.alloc(32, 9)),
    domainVerification: opts.domainVerification ?? "none",
    egressAllow: parseCidrList("", "x"),
    backendAllow: parseCidrList("", "x"),
    resolve: async (host) => {
      const hit = dns.get(host);
      if (!hit) throw new Error("ENOTFOUND");
      return hit;
    },
    resolveTxt: async (record) => txt.get(record) ?? [],
  });
  const notifier = new ChangeNotifier();
  await notifier.start(sql);
  const auth = new Authenticator(sql, null);
  const jobs = new JobRunner(sql, buildJobs(store, { changelogRetentionHours: 1, nodeSlotTtlHours: 1, auditRetentionDays: 1 }), { info: () => {}, error: () => {} });
  const app = buildServer({ logLevel: "error" }, { pingDatabase: async () => { await sql`SELECT 1`; }, store, schemas, auth, notifier, jobs, ...(opts.ui ? { ui: opts.ui } : {}), debugNodeUrl: opts.debugNodeUrl ?? null });
  await app.ready();

  const token: Harness["token"] = async (role, workspaces) =>
    (await createToken(sql, { name: `${role}-${Math.random().toString(36).slice(2, 10)}`, role, ...(workspaces ? { workspaces } : {}) })).secret;
  const tokens = { admin: await token("admin"), node: await token("node") };

  return {
    sql, app, store, jobs, notifier, tokens, dns, txt, token,
    call: async (method, path, o = {}) => {
      const bearer = o.token === undefined ? tokens.admin : o.token;
      const res = await app.inject({
        method: method as never,
        url: path,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
        ...(o.body !== undefined ? { payload: typeof o.body === "string" ? o.body : JSON.stringify(o.body) } : {}),
      });
      let json: any;
      try { json = res.body ? JSON.parse(res.body) : undefined; } catch { json = undefined; }
      return { status: res.statusCode, json, text: res.body, headers: res.headers as Record<string, any> };
    },
    events: async (after = 0) => sql<Array<{ seq: number; data: Json }>>`SELECT seq, data FROM apg_changes WHERE seq > ${after} ORDER BY seq`,
    lastSeq: async () => Number((await sql<{ value: string }[]>`SELECT value FROM apg_meta WHERE key = 'last_seq'`)[0]!.value),
    close: async () => {
      jobs.stop();
      await notifier.close();
      await app.close();
      await sql.end({ timeout: 5 });
    },
  };
}
