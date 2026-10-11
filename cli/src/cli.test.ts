import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { CliError, parseArgs } from "./args.js";
import { loadDocument, parseAndMerge, substituteEnv, validateOffline } from "./document.js";
import { renderChanges, table } from "./output.js";
import { type Io, run } from "./run.js";

const schemas = fileURLToPath(new URL("../../schemas/", import.meta.url));
const fixtures = fileURLToPath(new URL("../../tests/fixtures/config/", import.meta.url));

/** Runs the CLI against a scripted admin. */
async function cli(argv: string[], opts: { env?: Record<string, string>; answers?: Array<{ status?: number; body: unknown }>; interactive?: boolean; confirm?: boolean; stdin?: string } = {}) {
  const calls: Array<{ method: string; url: string; body: any; auth: string | null }> = [];
  const answers = [...(opts.answers ?? [])];
  let out = "";
  let err = "";
  const io: Io = {
    env: { APG_ADMIN_URL: "http://admin:9000/", APG_ADMIN_TOKEN: "apg_at_test", APG_SCHEMAS_DIR: schemas, ...opts.env },
    out: (t) => { out += t; },
    err: (t) => { err += t; },
    stdin: () => opts.stdin ?? "",
    interactive: opts.interactive ?? false,
    confirm: async () => opts.confirm ?? false,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>)["authorization"] ?? null });
      const next = answers.shift() ?? { body: {} };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status ?? 200 });
    }) as never,
  };
  const code = await run(argv, io);
  return { code, out, err, calls };
}

function tempFile(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "apgctl-"));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

const DOC = "version: 1\nservices:\n  - name: echo\n    backends:\n      - target: \"echo:8080\"\nroutes:\n  - name: all\n    service: echo\n";

describe("arguments", () => {
  it("parses flags, short forms, repeats and positionals", () => {
    expect(parseArgs(["sync", "-f", "a.yaml", "--file=b", "--yes", "-w", "acme", "--header", "A: 1", "--header", "B: 2", "x"])).toEqual({
      positional: ["sync", "x"],
      flags: { file: ["a.yaml", "b"], yes: true, workspace: "acme", header: ["A: 1", "B: 2"] },
    });
    expect(() => parseArgs(["get", "-z"])).toThrow(CliError);
    expect(() => parseArgs(["get", "--output"])).toThrow(/needs a value/);
    expect(() => parseArgs(["sync", "--yes=maybe"])).toThrow(/takes no value/);
  });

  it("refuses an option the command does not take, instead of ignoring it", async () => {
    const r = await cli(["apply", "-f", "x.yaml", "--prune"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown option '--prune'");
    expect(r.calls).toEqual([]);
  });
});

describe("documents", () => {
  it("substitutes ${VAR} and ${VAR:-default}; an unset variable is an error with its line", () => {
    expect(substituteEnv("a: ${A}\nb: ${B:-two}\nc: ${C:-}\nd: \"${not a var}\"", { A: "one" })).toBe("a: one\nb: two\nc: \nd: \"${not a var}\"");
    expect(substituteEnv("a: ${A:-x}", { A: "" })).toBe("a: x");
    expect(() => substituteEnv("a: 1\nb: ${MISSING}", {}, "f.yaml")).toThrow("f.yaml: line 2: environment variable MISSING is not set and has no default");
  });

  it("merges several files: lists concatenate, a clash is an error", () => {
    const merged = parseAndMerge([
      { name: "a", text: "version: 1\nservices: [{ name: a, backends: [{ target: 'a:1' }] }]\nflags: { x: true }" },
      { name: "b", text: "version: 1\nservices: [{ name: b, backends: [{ target: 'b:1' }] }]\nflags: { y: false }" },
    ]);
    expect(merged["services"].map((s: any) => s.name)).toEqual(["a", "b"]);
    expect(merged["flags"]).toEqual({ x: true, y: false });
    expect(() => parseAndMerge([{ name: "a", text: "version: 1\nworkspace: one" }, { name: "b", text: "version: 1\nworkspace: two" }])).toThrow(/b: workspace conflicts/);
    expect(() => parseAndMerge([{ name: "a", text: "flags: { x: true }" }, { name: "b", text: "flags: { x: false }" }])).toThrow(/flags.x is defined in more than one file/);
    expect(() => parseAndMerge([{ name: "a", text: "- 1" }])).toThrow(/must be a mapping/);
    expect(() => parseAndMerge([{ name: "a", text: "a: [" }])).toThrow(/not valid YAML/);
  });

  it("reads a directory in name order, and standard input", () => {
    const dir = mkdtempSync(join(tmpdir(), "apgctl-dir-"));
    writeFileSync(join(dir, "20-routes.yaml"), "version: 1\nroutes: [{ name: r, service: s }]");
    writeFileSync(join(dir, "10-services.yml"), "version: 1\nservices: [{ name: s, backends: [{ target: '${HOST}:80' }] }]");
    writeFileSync(join(dir, "notes.txt"), "not a document");
    const doc = loadDocument([dir], { HOST: "10.0.0.1" }, () => "");
    expect(doc["services"][0].backends[0].target).toBe("10.0.0.1:80");
    expect(Object.keys(doc)).toEqual(["version", "services", "routes"]);
    expect(loadDocument(["-"], {}, () => "version: 1")).toEqual({ version: 1 });
    expect(() => loadDocument([join(dir, "nope.yaml")], {}, () => "")).toThrow(/no such file/);
    mkdirSync(join(dir, "empty"));
    expect(() => loadDocument([join(dir, "empty")], {}, () => "")).toThrow(/holds no/);
  });
});

describe("offline validation", () => {
  it("accepts the shared valid fixtures and rejects the shared invalid ones", () => {
    for (const name of ["minimal.yaml", "full.yaml"]) {
      const doc = yaml.load(readFileSync(join(fixtures, "valid", name), "utf8")) as any;
      expect(validateOffline(doc, schemas).filter((p) => !p.warning), name).toEqual([]);
    }
    const cases = yaml.load(readFileSync(join(fixtures, "invalid", "cases.yaml"), "utf8")) as Array<{ name: string; doc: any }>;
    for (const c of cases) expect(validateOffline(c.doc, schemas).filter((p) => !p.warning).length, c.name).toBeGreaterThan(0);
  });

  it("checks plugin configuration, duplicate names and references between resources", () => {
    const problems = validateOffline({
      version: 1,
      services: [{ name: "a", backends: [{ target: "a:1" }] }, { name: "a", backends: [{ target: "b:1" }] }],
      routes: [{ name: "r", service: "elsewhere", plugins: [{ type: "rate_limit", config: { per_second: "many" } }] }],
      plugins: [{ type: "cors", scope: "route", scope_ref: "r", consumer: "nobody" }],
    }, schemas);
    expect(problems).toEqual(expect.arrayContaining([
      { pointer: "/services/1", message: "'a' is defined more than once" },
      { pointer: "/routes/0/service", message: "service 'elsewhere' is not defined in this document; it must already exist in the workspace", warning: true },
      { pointer: "/plugins/0/consumer", message: "consumer 'nobody' is not defined in this document; it must already exist in the workspace", warning: true },
    ]));
    expect(problems.some((p) => p.pointer === "/routes/0/plugins/0/config/per_second" && !p.warning)).toBe(true);
  });

  it("validate needs no server, prints each fault, and fails only on errors", async () => {
    const good = await cli(["validate", "-f", tempFile("apg.yaml", DOC)], { env: { APG_ADMIN_URL: "", APG_ADMIN_TOKEN: "" } });
    expect(good).toMatchObject({ code: 0, out: "valid\n", calls: [] });
    const bad = await cli(["validate", "-f", tempFile("apg.yaml", "version: 1\nservcies: []\n")]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("error: /: must NOT have additional properties 'servcies'");
    const warned = await cli(["validate", "-f", tempFile("apg.yaml", "version: 1\nroutes: [{ name: r, service: live }]\n")]);
    expect(warned.code).toBe(0);
    expect(warned.err).toContain("warning: /routes/0/service");
    const online = await cli(["validate", "--online", "-f", tempFile("apg.yaml", DOC)], { answers: [{ body: { valid: true } }] });
    expect(online.calls[0]).toMatchObject({ method: "POST", url: "http://admin:9000/v1/config/validate" });
  });
});

describe("declarative commands", () => {
  const change = { op: "update", workspace: "default", kind: "route", name: "all", fields: [{ pointer: "/priority", before: 0, after: 5 }] };
  const removal = { op: "delete", workspace: "default", kind: "service", name: "old", fields: [] };
  const result = (changes: unknown[]) => ({ changes, summary: { create: 0, update: 1, delete: changes.length - 1, unchanged: 3 }, generated: [], revisions: [] });

  it("diff exits 2 when something would change and 0 when nothing would", async () => {
    const some = await cli(["diff", "-f", tempFile("a.yaml", DOC), "--prune", "-w", "acme"], { answers: [{ body: result([change]) }] });
    expect(some.code).toBe(2);
    expect(some.out).toBe("~ route all (default)\n    /priority: 0 -> 5\n0 to create, 1 to update, 0 to delete, 3 unchanged\n");
    expect(some.calls[0]!.url).toBe("http://admin:9000/v1/config/diff?workspace=acme&prune=true");
    expect(some.calls[0]!.auth).toBe("Bearer apg_at_test");
    const none = await cli(["diff", "-f", tempFile("a.yaml", DOC)], { answers: [{ body: { changes: [], summary: { unchanged: 2 } } }] });
    expect(none.code).toBe(0);
  });

  it("apply sends the merged document and the message, and shows a generated key once", async () => {
    const r = await cli(["apply", "-f", tempFile("a.yaml", DOC), "-m", "release 4"], {
      answers: [{ body: { ...result([change]), generated: [{ workspace: "default", consumer: "app", credential: "main", key: "apg_k_secret" }], revisions: [{ id: "x", workspace: "default", number: 4 }] } }],
    });
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ document: yaml.load(DOC), message: "release 4" });
    expect(r.out).toContain("generated key for app/main (shown once): apg_k_secret");
    expect(r.out).toContain("recorded revision 4 of default");
  });

  it("sync shows the plan and refuses to delete unattended without --yes", async () => {
    const file = tempFile("a.yaml", DOC);
    const refused = await cli(["sync", "-f", file], { answers: [{ body: result([change, removal]) }] });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("- service old");
    expect(refused.err).toContain("pass --yes");
    expect(refused.calls.map((c) => c.url)).toEqual(["http://admin:9000/v1/config/diff?prune=true"]);

    const declined = await cli(["sync", "-f", file], { answers: [{ body: result([change, removal]) }], interactive: true, confirm: false });
    expect(declined.code).toBe(1);
    expect(declined.calls).toHaveLength(1);

    const yes = await cli(["sync", "-f", file, "--yes", "--select-label", "team=a"], { answers: [{ body: result([change, removal]) }, { body: result([change, removal]) }] });
    expect(yes.code).toBe(0);
    expect(yes.calls.map((c) => c.url)).toEqual(["http://admin:9000/v1/config/diff?prune=true", "http://admin:9000/v1/config/sync"]);
    expect(yes.calls[1]!.body.select_label).toBe("team=a");

    const nothing = await cli(["sync", "-f", file], { answers: [{ body: { changes: [], summary: { unchanged: 2 } } }] });
    expect(nothing.code).toBe(0);
    expect(nothing.calls).toHaveLength(1);
  });

  it("dump writes YAML to a file or to the terminal", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "apgctl-dump-")), "out.yaml");
    const r = await cli(["dump", "--file", out, "-w", "acme"], { answers: [{ body: yaml.load(DOC) }] });
    expect(r.calls[0]!.url).toBe("http://admin:9000/v1/config/dump?workspace=acme");
    expect(yaml.load(readFileSync(out, "utf8"))).toEqual(yaml.load(DOC));
    expect((await cli(["dump", "-o", "json"], { answers: [{ body: { version: 1 } }] })).out).toBe('{\n  "version": 1\n}\n');
  });

  it("rollback previews first and needs --yes when nobody can be asked", async () => {
    const refused = await cli(["revisions", "rollback", "rev-1"], { answers: [{ body: result([change]) }] });
    expect(refused.code).toBe(1);
    expect(refused.calls.map((c) => c.url)).toEqual(["http://admin:9000/v1/config/revisions/rev-1/rollback?dry_run=true"]);
    const done = await cli(["revisions", "rollback", "rev-1", "--yes"], { answers: [{ body: result([change]) }, { body: result([change]) }] });
    expect(done.code).toBe(0);
    expect(done.calls[1]!.url).toBe("http://admin:9000/v1/config/revisions/rev-1/rollback");
    const list = await cli(["revisions", "list"], { answers: [{ body: { data: [{ number: 2, action: "sync", actor: { name: "ci" }, created_at: "t", summary: { create: 1, update: 0, delete: 2 }, message: null, id: "r2" }], drift: { drifted: true, since_revision: 2 } } }] });
    expect(list.out).toContain("+1 ~0 -2");
    expect(list.out).toContain("drifted from revision 2");
  });
});

describe("resources and the rest", () => {
  it("get follows pages, prints a table, and one resource as YAML", async () => {
    const list = await cli(["get", "service"], {
      answers: [
        { body: { data: [{ name: "a", scheme: "http", backends: [{ target: "a:1" }, { target: "a:2" }], load_balancing: { strategy: "round_robin" } }], next_cursor: "c1" } },
        { body: { data: [{ name: "b", scheme: "https", backends: [], load_balancing: { strategy: "hash" } }], next_cursor: null } },
      ],
    });
    expect(list.out).toBe("NAME  SCHEME  BACKENDS  STRATEGY\na     http    a:1,a:2   round_robin\nb     https             hash\n");
    expect(list.calls[1]!.url).toBe("http://admin:9000/v1/workspaces/default/services?limit=500&cursor=c1");
    const one = await cli(["get", "routes", "orders api"], { answers: [{ body: { name: "orders api" } }] });
    expect(one.calls[0]!.url).toBe("http://admin:9000/v1/workspaces/default/routes/orders%20api");
    expect(one.out).toBe("name: orders api\n");
    expect((await cli(["get", "credentials"])).err).toContain("--consumer");
    expect((await cli(["get", "gadgets"])).err).toContain("unknown kind 'gadgets'");
    expect((await cli(["get", "ca_certificates"], { answers: [{ body: { data: [], next_cursor: null } }] })).out).toBe("(none)\n");
  });

  it("create, delete and tokens map onto the API", async () => {
    const made = await cli(["create", "consumer", "--data", '{"name":"app"}'], { answers: [{ status: 201, body: { name: "app" } }] });
    expect(made.calls[0]).toMatchObject({ method: "POST", url: "http://admin:9000/v1/workspaces/default/consumers", body: { name: "app" } });
    expect((await cli(["create", "consumer"])).err).toContain("-f <file> or --data");
    const gone = await cli(["delete", "service", "old", "--cascade"], { answers: [{ status: 204, body: undefined }] });
    expect(gone.calls[0]).toMatchObject({ method: "DELETE", url: "http://admin:9000/v1/workspaces/default/services/old?cascade=true" });
    expect(gone.out).toBe("deleted service old\n");
    const token = await cli(["tokens", "create", "--name", "ci", "--role", "editor", "--workspaces", "w1, w2"], { answers: [{ status: 201, body: { name: "ci", role: "editor", token: "apg_at_new" } }] });
    expect(token.calls[0]!.body).toEqual({ name: "ci", role: "editor", workspaces: ["w1", "w2"] });
    expect(token.out).toContain("apg_at_new");
    expect(token.err).toContain("only time");
  });

  it("route match explains the answer and exits 1 when nothing matches", async () => {
    const hit = await cli(["route", "match", "--host", "api.example.com", "--path", "/orders", "--header", "X-Beta: 1"], {
      answers: [{ body: { host: "api.example.com", path: "/orders", method: "GET", node_id: "n1", applied_seq: 9, selected: { route: "orders", tier: "workspace", path: "prefix /orders" }, candidates: [{ route: "orders", selected: true }, { route: "beta", tier: "workspace", path: "prefix /orders", reason: "the header 'x-beta' is missing or does not match", selected: false }] } }],
    });
    expect(hit.code).toBe(0);
    expect(hit.calls[0]!.url).toBe("http://admin:9000/v1/debug/match?host=api.example.com&path=%2Forders&header=X-Beta%3A+1");
    expect(hit.out).toContain("GET api.example.com/orders -> route orders (workspace tier, prefix /orders)");
    expect(hit.out).toContain("the header 'x-beta' is missing");
    const miss = await cli(["route", "match", "--host", "x", "--path", "/"], { answers: [{ body: { host: "x", path: "/", method: "GET", selected: null, candidates: [] } }] });
    expect(miss.code).toBe(1);
    expect(miss.out).toContain("no route matches");
  });

  it("health lists each backend with what nodes say, and exits 1 when one is failing", async () => {
    const svc = (name: string, backends: unknown[]) => ({ name, backends });
    const all = await cli(["health"], { answers: [{ body: { live_nodes: 2, data: [
      svc("orders", [{ target: "10.0.0.1:80", state: "unhealthy", reason: "connection refused", nodes: [{ node_id: "n1", state: "unhealthy" }, { node_id: "n2", state: "healthy" }] }]),
      svc("users", [{ target: "10.0.0.2:80", state: "unknown", nodes: [] }]),
    ] } }] });
    expect(all.calls[0]!.url).toBe("http://admin:9000/v1/workspaces/default/health");
    expect(all.code).toBe(1);
    expect(all.out).toMatch(/orders\s+10\.0\.0\.1:80\s+unhealthy\s+1 of 2\s+connection refused/);
    expect(all.out).toMatch(/users\s+10\.0\.0\.2:80\s+unknown\s+none reporting/);
    expect(all.err).toContain("no node has sent anything");

    const one = await cli(["health", "orders"], { answers: [{ body: svc("orders", [{ target: "10.0.0.1:80", state: "healthy", nodes: [{ node_id: "n1", state: "healthy" }] }]) }] });
    expect(one.calls[0]!.url).toBe("http://admin:9000/v1/workspaces/default/services/orders/health");
    expect([one.code, one.err]).toEqual([0, ""]);
    expect(one.out).toMatch(/orders\s+10\.0\.0\.1:80\s+healthy\s+1 of 1/);
  });

  it("shows the server's own error, with its pointers", async () => {
    const r = await cli(["apply", "-f", tempFile("a.yaml", DOC)], { answers: [{ status: 422, body: { error: { code: "VALIDATION_FAILED", message: "route 'all': bad", details: [{ pointer: "/routes/0/service", message: "service 'echo' does not exist" }] } } }] });
    expect(r.code).toBe(1);
    expect(r.err).toBe("apgctl: VALIDATION_FAILED: route 'all': bad\n  /routes/0/service: service 'echo' does not exist\n");
  });

  it("explains a missing connection, and help and version need none", async () => {
    const none = await cli(["nodes"], { env: { APG_ADMIN_URL: "", APG_ADMIN_TOKEN: "", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "apgctl-cfg-")) } });
    expect(none.err).toContain("no admin address");
    expect((await cli(["--version"])).out).toMatch(/^apgctl \d/);
    expect((await cli(["help"])).out).toContain("apgctl sync");
    expect((await cli([])).code).toBe(1);
    expect((await cli(["frobnicate"])).err).toContain("unknown command");
  });
});

describe("contexts", () => {
  it("saves a context for its owner only, and flags and the environment win over it", async () => {
    const home = mkdtempSync(join(tmpdir(), "apgctl-ctx-"));
    const env = { XDG_CONFIG_HOME: home, APG_ADMIN_URL: "", APG_ADMIN_TOKEN: "" };
    expect((await cli(["config", "set-context", "prod", "--url", "https://admin.prod", "--token", "apg_at_prod", "-w", "acme"], { env })).code).toBe(0);
    expect((await cli(["config", "set-context", "dev", "--url", "http://admin.dev", "--token", "apg_at_dev"], { env })).code).toBe(0);
    const path = join(home, "apg", "config.yaml");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await cli(["config", "get-contexts"], { env })).out).toContain("*  prod  https://admin.prod  acme");

    const viaContext = await cli(["get", "services"], { env, answers: [{ body: { data: [], next_cursor: null } }] });
    expect(viaContext.calls[0]).toMatchObject({ url: "https://admin.prod/v1/workspaces/acme/services?limit=500", auth: "Bearer apg_at_prod" });
    expect((await cli(["config", "use-context", "dev"], { env })).code).toBe(0);
    const viaDev = await cli(["get", "services"], { env, answers: [{ body: { data: [], next_cursor: null } }] });
    expect(viaDev.calls[0]!.url).toContain("http://admin.dev/v1/workspaces/default/");
    const viaEnv = await cli(["get", "services", "--context", "prod", "--token", "apg_at_flag"], { env: { ...env, APG_ADMIN_URL: "http://from-env" }, answers: [{ body: { data: [], next_cursor: null } }] });
    expect(viaEnv.calls[0]).toMatchObject({ url: "http://from-env/v1/workspaces/acme/services?limit=500", auth: "Bearer apg_at_flag" });
    expect((await cli(["get", "services", "--context", "nope"], { env })).err).toContain("no context named 'nope'");
  });
});

describe("output", () => {
  it("aligns a table and marks each kind of change", () => {
    expect(table([{ a: "x", b: [1, 2] }, { a: "longer", b: null }], [["A", "a"], ["B", "b"]])).toBe("A       B\nx       1,2\nlonger\n");
    const text = renderChanges({ changes: [{ op: "create", workspace: "default", kind: "service", name: "s", fields: [] }, { op: "delete", workspace: "", kind: "flag", name: "f", fields: [] }], summary: { create: 1, delete: 1 } }, false);
    expect(text).toBe("+ service s (default)\n- flag f\n1 to create, 0 to update, 1 to delete, 0 unchanged\n");
    expect(renderChanges({ changes: [{ op: "create", workspace: "default", kind: "service", name: "s", fields: [] }], summary: {} }, true)).toContain("\x1b[32m+\x1b[0m");
  });
});
