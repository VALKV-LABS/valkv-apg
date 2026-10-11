/**
 * The commands of `apgctl` (spec §14.2).
 *
 * `run` takes everything it touches from `io`, so tests drive it without a
 * terminal, a home directory or a network.
 */

import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { type Args, CliError, allow, flag, flags, parseArgs } from "./args.js";
import { Client, contextPath, readContexts, resolveConnection, writeContexts } from "./client.js";
import { type Json, loadDocument, schemasDir, validateOffline } from "./document.js";
import { formatOf, render, renderChanges, table } from "./output.js";

export const VERSION = "0.1.0";

export interface Io {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads all of standard input. */
  stdin: () => string;
  /** True when a person is at the terminal and can be asked. */
  interactive: boolean;
  /** Asks a yes/no question. */
  confirm: (question: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

const HELP = `apgctl ${VERSION}: command-line client for valkv-apg

Declarative configuration
  apgctl validate -f <file|dir> [--online]     check documents; needs no server unless --online
  apgctl diff -f <file|dir> [--prune]          what apply (or, with --prune, sync) would change; exits 2 if anything
  apgctl apply -f <file|dir> [-m <message>]    create and update; never deletes
  apgctl sync -f <file|dir> [--select-label k=v] [--yes] [-m <message>]
                                               as apply, and delete what the documents omit
  apgctl dump [--file <out>]                   export the workspace as a document
  apgctl revisions list | show <id> | rollback <id> [--yes]

Resources
  apgctl get <kind> [name]                     workspaces, domains, certificates, ca-certificates, services, routes,
                                               plugins, consumers, credentials (--consumer), tokens, flags, settings
  apgctl create <kind> -f <file> | --data <json>
  apgctl delete <kind> <name> [--cascade]
  apgctl tokens create --name <n> --role <admin|editor|viewer|node> [--workspaces id,id] [--expires <time>]
  apgctl route match --host <h> --path <p> [--method <m>] [--header 'Name: value']...
  apgctl cache purge <route>
  apgctl nodes
  apgctl usage [--from <time>] [--to <time>] [--granularity minute|hour|day] [--group-by a,b] [--all-workspaces]

Connection
  apgctl config set-context <name> --url <url> --token <token> [--workspace <ws>]
  apgctl config use-context <name> | get-contexts

Options everywhere
  --url, --token        the admin (or APG_ADMIN_URL, APG_ADMIN_TOKEN, or a context)
  --context <name>      a named context (or APG_CONTEXT)
  -w, --workspace <ws>  workspace name or id; default: default
  -o table|json|yaml    output format
`;

interface Kind {
  /** Path under the workspace, or an absolute path for fleet-wide kinds. */
  path: (ws: string, args: Args) => string;
  columns: Array<[string, string | ((r: Json) => unknown)]>;
  /** False for kinds the API lists without paging. */
  paged?: boolean;
  key?: string;
}

const inWs = (segment: string) => (ws: string) => `/v1/workspaces/${encodeURIComponent(ws)}/${segment}`;
const KINDS: Record<string, Kind> = {
  workspaces: { path: () => "/v1/workspaces", columns: [["NAME", "name"], ["SLUG", "slug"], ["STATUS", "status"], ["SYSTEM", "system"], ["ID", "id"]] },
  domains: { path: inWs("domains"), columns: [["NAME", "name"], ["HOSTNAME", "hostname"], ["TLS", (r) => r["tls"]?.["mode"]], ["STATUS", "status"], ["REASON", "status_reason"]] },
  certificates: { path: inWs("certificates"), columns: [["NAME", "name"], ["HOSTS", "hosts"], ["SOURCE", "source"], ["NOT AFTER", "not_after"]] },
  "ca-certificates": { path: inWs("ca-certificates"), columns: [["NAME", "name"], ["ID", "id"]] },
  services: { path: inWs("services"), columns: [["NAME", "name"], ["SCHEME", "scheme"], ["BACKENDS", (r) => ((r["backends"] ?? []) as Json[]).map((b) => b["target"])], ["STRATEGY", (r) => r["load_balancing"]?.["strategy"]]] },
  routes: { path: inWs("routes"), columns: [["NAME", "name"], ["HOSTS", "hosts"], ["PATHS", (r) => ((r["paths"] ?? []) as Json[]).map((p) => (p["type"] === "prefix" ? p["value"] : `${p["type"]}:${p["value"]}`))], ["METHODS", "methods"], ["PRIORITY", "priority"], ["ENABLED", "enabled"]] },
  plugins: { path: inWs("plugins"), columns: [["NAME", "name"], ["TYPE", "type"], ["SCOPE", "scope"], ["SCOPE REF", "scope_ref"], ["ENABLED", "enabled"]] },
  consumers: { path: inWs("consumers"), columns: [["NAME", "name"], ["CUSTOM ID", "custom_id"], ["GROUPS", "groups"]] },
  credentials: {
    path: (ws, args) => {
      const consumer = flag(args, "consumer");
      if (!consumer) throw new CliError("credentials belong to a consumer: add --consumer <name>");
      return `${inWs("consumers")(ws)}/${encodeURIComponent(consumer)}/credentials`;
    },
    columns: [["NAME", "name"], ["TYPE", "type"], ["IDENTIFIES AS", (r) => r["key_prefix"] ?? r["username"] ?? r["identity"]], ["ENABLED", "enabled"], ["EXPIRES", "expires_at"]],
  },
  tokens: { path: () => "/v1/tokens", paged: false, columns: [["NAME", "name"], ["ROLE", "role"], ["WORKSPACES", "workspaces"], ["PREFIX", "token_prefix"], ["EXPIRES", "expires_at"], ["LAST USED", "last_used_at"]] },
  flags: { path: () => "/v1/flags", paged: false, columns: [["NAME", "name"], ["ENABLED", "enabled"]] },
  settings: { path: () => "/v1/settings", paged: false, columns: [["NAME", "name"], ["VALUE", "value"]] },
};
const ALIASES: Record<string, string> = { ca_certificates: "ca-certificates", "ca-certificate": "ca-certificates", ca_certificate: "ca-certificates" };

function kindOf(name: string | undefined): [string, Kind] {
  if (!name) throw new CliError(`which kind? one of: ${Object.keys(KINDS).join(", ")}`);
  const key = ALIASES[name] ?? (KINDS[name] ? name : `${name}s`);
  const kind = KINDS[key];
  if (!kind) throw new CliError(`unknown kind '${name}'; one of: ${Object.keys(KINDS).join(", ")}`);
  return [key, kind];
}

function labelArg(value: string | undefined): string | undefined {
  if (value !== undefined && value.indexOf("=") < 1) throw new CliError("--select-label takes key=value");
  return value;
}

/** Runs one command. Returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), io);
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`apgctl: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

async function dispatch(args: Args, io: Io): Promise<number> {
  const [command, ...rest] = args.positional;
  if (args.flags["version"] || command === "version") {
    io.out(`apgctl ${VERSION}\n`);
    return 0;
  }
  if (!command || args.flags["help"] || command === "help") {
    io.out(HELP);
    return command || args.flags["help"] ? 0 : 1;
  }
  const format = formatOf(flag(args, "output"));
  const color = io.interactive && !args.flags["no-color"] && !io.env["NO_COLOR"];
  const client = () => new Client(resolveConnection(args, io.env), io.fetch);
  const document = () => loadDocument(flags(args, "file"), io.env, io.stdin);
  const body = (doc: Json, c: Client) => ({ document: doc, ...(flag(args, "message") ? { message: flag(args, "message") } : {}), ...(flag(args, "select-label") ? { select_label: labelArg(flag(args, "select-label")) } : {}) });
  // The document names its workspace; -w overrides it only when given.
  const target = (): Record<string, string | undefined> => ({ workspace: flag(args, "workspace") });
  const showResult = (result: Json) => {
    io.out(render(format, result, () => renderChanges(result as never, color)));
    for (const g of (result["generated"] ?? []) as Json[]) io.out(`generated key for ${g["consumer"]}/${g["credential"]} (shown once): ${g["key"]}\n`);
    for (const r of (result["revisions"] ?? []) as Json[]) io.out(`recorded revision ${r["number"]} of ${r["workspace"]}\n`);
  };

  switch (command) {
    case "validate": {
      allow(args, "file", "online");
      const doc = document();
      const problems = validateOffline(doc, schemasDir(io.env));
      const errors = problems.filter((p) => !p.warning);
      for (const p of problems) io.err(`${p.warning ? "warning" : "error"}: ${p.pointer}: ${p.message}\n`);
      if (errors.length > 0) return 1;
      if (args.flags["online"]) await client().call("POST", "/v1/config/validate", { document: doc }, target());
      io.out(args.flags["online"] ? "valid (checked against the workspace)\n" : "valid\n");
      return 0;
    }

    case "diff": {
      allow(args, "file", "prune", "select-label");
      const c = client();
      const result = await c.call("POST", "/v1/config/diff", body(document(), c), { ...target(), prune: args.flags["prune"] ? "true" : undefined });
      showResult(result);
      return result.changes.length > 0 ? 2 : 0;
    }

    case "apply": {
      allow(args, "file", "message");
      const c = client();
      showResult(await c.call("POST", "/v1/config/apply", body(document(), c), target()));
      return 0;
    }

    case "sync": {
      allow(args, "file", "message", "select-label", "yes");
      const c = client();
      const doc = document();
      const preview = await c.call("POST", "/v1/config/diff", body(doc, c), { ...target(), prune: "true" });
      const deletes = (preview.changes as Json[]).filter((x) => x["op"] === "delete").length;
      if (preview.changes.length === 0) {
        io.out(render(format, preview, () => renderChanges(preview, color)));
        return 0;
      }
      if (!args.flags["yes"]) {
        io.err(renderChanges(preview, color));
        if (!io.interactive) throw new CliError(`sync would make ${preview.changes.length} change(s), ${deletes} of them deletions; pass --yes to go ahead`);
        if (!(await io.confirm(`Apply these ${preview.changes.length} change(s), ${deletes} of them deletions?`))) {
          io.err("nothing changed\n");
          return 1;
        }
      }
      showResult(await c.call("POST", "/v1/config/sync", body(doc, c), target()));
      return 0;
    }

    case "dump": {
      allow(args, "file");
      const c = client();
      const doc = await c.call("GET", "/v1/config/dump", undefined, { workspace: c.workspace });
      const text = format === "json" ? JSON.stringify(doc, null, 2) + "\n" : yaml.dump(doc, { lineWidth: 120, noRefs: true });
      const [file] = flags(args, "file");
      if (file) {
        writeFileSync(file, text);
        io.err(`wrote ${file}\n`);
      } else io.out(text);
      return 0;
    }

    case "revisions": {
      allow(args, "yes", "message", "dry-run");
      const c = client();
      const [sub, id] = rest;
      if (sub === "list" || sub === undefined) {
        const result = await c.call("GET", "/v1/config/revisions", undefined, { workspace: c.workspace });
        io.out(render(format, result, () =>
          table(result.data, [["NUMBER", "number"], ["ACTION", "action"], ["BY", (r) => r["actor"]?.["name"]], ["WHEN", "created_at"], ["CHANGES", (r) => `+${r["summary"]["create"]} ~${r["summary"]["update"]} -${r["summary"]["delete"]}`], ["MESSAGE", "message"], ["ID", "id"]]) +
          (result.drift.drifted ? `\nThe workspace has drifted from revision ${result.drift.since_revision}: it was changed outside apply and sync.\n` : "")));
        return 0;
      }
      if (!id) throw new CliError(`usage: apgctl revisions ${sub} <id>`);
      if (sub === "show") {
        const revision = await c.call("GET", `/v1/config/revisions/${encodeURIComponent(id)}`);
        io.out(render(format === "table" ? "yaml" : format, revision, () => ""));
        return 0;
      }
      if (sub === "rollback") {
        const path = `/v1/config/revisions/${encodeURIComponent(id)}/rollback`;
        const message = flag(args, "message") ? { message: flag(args, "message") } : {};
        const preview = await c.call("POST", path, message, { dry_run: "true" });
        if (args.flags["dry-run"]) {
          showResult(preview);
          return 0;
        }
        if (!args.flags["yes"]) {
          io.err(renderChanges(preview, color));
          if (!io.interactive) throw new CliError(`the rollback would make ${preview.changes.length} change(s); pass --yes to go ahead`);
          if (!(await io.confirm("Roll back to this revision?"))) return 1;
        }
        showResult(await c.call("POST", path, message));
        return 0;
      }
      throw new CliError("usage: apgctl revisions list | show <id> | rollback <id>");
    }

    case "get": {
      allow(args, "consumer");
      const c = client();
      const [, kind] = kindOf(rest[0]);
      const path = kind.path(c.workspace, args);
      if (rest[1]) {
        if (kind.paged === false) {
          const found = ((await c.call("GET", path)).data as Json[]).find((r) => r["name"] === rest[1] || r["id"] === rest[1]);
          if (!found) throw new CliError(`NOT_FOUND: '${rest[1]}' not found`);
          io.out(render(format === "table" ? "yaml" : format, found, () => ""));
        } else io.out(render(format === "table" ? "yaml" : format, await c.call("GET", `${path}/${encodeURIComponent(rest[1])}`), () => ""));
        return 0;
      }
      const rows = kind.paged === false ? ((await c.call("GET", path)).data as Json[]) : await c.list(path);
      io.out(render(format, rows, () => table(rows, kind.columns)));
      return 0;
    }

    case "create": {
      allow(args, "file", "data", "consumer");
      const c = client();
      const [name, kind] = kindOf(rest[0]);
      if (kind.paged === false) throw new CliError(name === "tokens" ? "use 'apgctl tokens create'" : `${name} cannot be created; they are set`);
      const data = flag(args, "data");
      const [file] = flags(args, "file");
      if ((data === undefined) === (file === undefined)) throw new CliError("give the resource with -f <file> or --data '<json>'");
      let resource: unknown;
      try {
        resource = yaml.load(data ?? (file === "-" ? io.stdin() : readFileSync(file!, "utf8")));
      } catch (err) {
        throw new CliError(`the resource is not valid YAML or JSON: ${(err as Error).message.split("\n")[0]}`);
      }
      const made = await c.call("POST", kind.path(c.workspace, args), resource);
      io.out(render(format === "table" ? "yaml" : format, made, () => ""));
      return 0;
    }

    case "delete": {
      allow(args, "cascade", "consumer");
      const c = client();
      const [name, kind] = kindOf(rest[0]);
      if (!rest[1]) throw new CliError(`usage: apgctl delete ${name} <name>`);
      if (name === "flags" || name === "settings") throw new CliError(`${name} cannot be deleted`);
      await c.call("DELETE", `${kind.path(c.workspace, args)}/${encodeURIComponent(rest[1])}`, undefined, { cascade: args.flags["cascade"] ? "true" : undefined });
      io.out(`deleted ${name.replace(/s$/, "")} ${rest[1]}\n`);
      return 0;
    }

    case "tokens": {
      allow(args, "name", "role", "workspaces", "expires");
      const c = client();
      if (rest[0] === "list" || rest[0] === undefined) {
        const rows = (await c.call("GET", "/v1/tokens")).data as Json[];
        io.out(render(format, rows, () => table(rows, KINDS["tokens"]!.columns)));
        return 0;
      }
      if (rest[0] !== "create") throw new CliError("usage: apgctl tokens list | create --name <n> --role <role>");
      const name = flag(args, "name");
      const role = flag(args, "role");
      if (!name || !role) throw new CliError("usage: apgctl tokens create --name <n> --role <admin|editor|viewer|node> [--workspaces id,id] [--expires <time>]");
      const made = await c.call("POST", "/v1/tokens", {
        name, role,
        ...(flag(args, "workspaces") ? { workspaces: flag(args, "workspaces")!.split(",").map((s) => s.trim()) } : {}),
        ...(flag(args, "expires") ? { expires_at: flag(args, "expires") } : {}),
      });
      io.out(render(format, made, () => `created token ${made.name} (${made.role})\n${made.token}\n`));
      if (format === "table") io.err("This is the only time the token is shown. Store it now.\n");
      return 0;
    }

    case "route": {
      allow(args, "host", "path", "method", "header", "query");
      if (rest[0] !== "match" || !flag(args, "host") || !flag(args, "path")) throw new CliError("usage: apgctl route match --host <host> --path <path> [--method <m>] [--header 'Name: value']...");
      const result = await client().call("GET", "/v1/debug/match", undefined, {
        host: flag(args, "host"), path: flag(args, "path"), method: flag(args, "method"), query: flag(args, "query"), header: flags(args, "header"),
      });
      io.out(render(format, result, () => {
        const head = result.selected
          ? `${result.method} ${result.host}${result.path} -> route ${result.selected.route} (${result.selected.tier} tier, ${result.selected.path})\n`
          : `${result.method} ${result.host}${result.path} -> no route matches\n`;
        const others = (result.candidates as Json[]).filter((x) => !x["selected"]);
        return head + (others.length > 0 ? "\nNot chosen:\n" + table(others, [["ROUTE", "route"], ["TIER", "tier"], ["PATH", "path"], ["WHY", "reason"]]) : "") +
          `\nAnswered by node ${result.node_id} at sequence ${result.applied_seq}.\n`;
      }));
      return result.selected ? 0 : 1;
    }

    case "cache": {
      allow(args);
      if (rest[0] !== "purge" || !rest[1]) throw new CliError("usage: apgctl cache purge <route>");
      const c = client();
      const route = await c.call("POST", `${inWs("routes")(c.workspace)}/${encodeURIComponent(rest[1])}/cache/purge`);
      io.out(render(format, route, () => `purged cached responses of route ${route.name}\n`));
      return 0;
    }

    case "nodes": {
      allow(args);
      const result = await client().call("GET", "/v1/nodes");
      io.out(render(format, result, () => table(result.data, [["NODE", "node_id"], ["VERSION", "version"], ["SOURCE", "source"], ["APPLIED", "applied_seq"], ["LAG", "lag"], ["LIVE", "live"], ["STALE", "stale"], ["REGION", "region"], ["LAST SEEN", "last_seen"]])));
      return 0;
    }

    case "usage": {
      allow(args, "from", "to", "granularity", "group-by", "service", "route", "consumer", "region", "all-workspaces");
      const c = client();
      const result = await c.call("GET", "/v1/usage", undefined, {
        workspace: args.flags["all-workspaces"] ? undefined : c.workspace,
        from: flag(args, "from"), to: flag(args, "to"), granularity: flag(args, "granularity"), group_by: flag(args, "group-by"),
        service: flag(args, "service"), route: flag(args, "route"), consumer: flag(args, "consumer"), region: flag(args, "region"),
      });
      const column: Record<string, string> = { workspace: "workspace_id", service: "service_id", route: "route_id", consumer: "consumer_id", region: "region" };
      io.out(render(format, result, () => table(result.data, [
        ["BUCKET", "bucket"],
        ...(result.group_by as string[]).map((g): [string, string] => [g.toUpperCase(), column[g] ?? g]),
        ["REQUESTS", "requests"], ["4XX", "status_4xx"], ["5XX", "status_5xx"], ["BYTES IN", "bytes_in"], ["BYTES OUT", "bytes_out"],
        ["AVG MS", (r) => (Number(r["requests"]) > 0 ? Math.round(Number(r["latency_ms_sum"]) / Number(r["requests"])) : "")],
      ]) + (result.truncated ? "(more rows exist; narrow the range)\n" : "")));
      return 0;
    }

    case "config": {
      allow(args);
      const file = readContexts(io.env);
      const [sub, name] = rest;
      if (sub === "get-contexts") {
        const rows = Object.entries(file.contexts).map(([n, c]) => ({ current: n === file.current ? "*" : "", name: n, url: c.url, workspace: c.workspace ?? "default" }));
        io.out(render(format, rows, () => table(rows, [["", "current"], ["NAME", "name"], ["URL", "url"], ["WORKSPACE", "workspace"]])));
        return 0;
      }
      if (!name) throw new CliError("usage: apgctl config set-context <name> --url <url> --token <token> | use-context <name> | get-contexts");
      if (sub === "use-context") {
        if (!file.contexts[name]) throw new CliError(`no context named '${name}' in ${contextPath(io.env)}`);
        writeContexts(io.env, { ...file, current: name });
        io.out(`now using context ${name}\n`);
        return 0;
      }
      if (sub === "set-context") {
        const next = { ...file.contexts[name] };
        for (const key of ["url", "token", "workspace"] as const) if (flag(args, key)) next[key] = flag(args, key)!;
        if (!next.url || !next.token) throw new CliError("a context needs --url and --token");
        const path = writeContexts(io.env, { current: file.current ?? name, contexts: { ...file.contexts, [name]: next } });
        io.out(`saved context ${name} in ${path}\n`);
        return 0;
      }
      throw new CliError(`unknown config command '${sub}'`);
    }

    default:
      throw new CliError(`unknown command '${command}'; run 'apgctl help'`);
  }
}
