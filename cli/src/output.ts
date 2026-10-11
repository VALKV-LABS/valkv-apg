/** Rendering: tables, JSON, YAML, and the diff a person reads before a sync. */

import yaml from "js-yaml";
import { CliError } from "./args.js";
import type { Json } from "./document.js";

export type Format = "table" | "json" | "yaml";

export function formatOf(value: string | undefined): Format {
  if (value === undefined) return "table";
  if (value === "table" || value === "json" || value === "yaml") return value;
  throw new CliError(`-o takes table, json or yaml; got '${value}'`);
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cell).join(",");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** Aligned columns. `columns` maps a heading to a field name or to a function of the row. */
export function table(rows: Json[], columns: Array<[string, string | ((row: Json) => unknown)]>): string {
  if (rows.length === 0) return "(none)\n";
  const lines = [columns.map(([h]) => h), ...rows.map((r) => columns.map(([, f]) => cell(typeof f === "function" ? f(r) : r[f])))];
  const widths = columns.map((_, i) => Math.max(...lines.map((l) => l[i]!.length)));
  return lines.map((l) => l.map((c, i) => (i === l.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n") + "\n";
}

/** Prints data as the chosen format; `asTable` is used only for `table`. */
export function render(format: Format, data: unknown, asTable: () => string): string {
  if (format === "json") return JSON.stringify(data, null, 2) + "\n";
  if (format === "yaml") return yaml.dump(data, { lineWidth: 120, noRefs: true });
  return asTable();
}

export interface Change {
  op: "create" | "update" | "delete";
  workspace: string;
  kind: string;
  name: string;
  fields: Array<{ pointer: string; before?: unknown; after?: unknown }>;
}

const short = (v: unknown): string => {
  if (v === undefined) return "(unset)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 100 ? `${s.slice(0, 97)}...` : s;
};

/** The diff of a document against a workspace, one line per resource and one per changed field. */
export function renderChanges(result: { changes: Change[]; summary: Record<string, number> }, color: boolean): string {
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const sign = { create: paint(32, "+"), update: paint(33, "~"), delete: paint(31, "-") };
  const lines: string[] = [];
  for (const c of result.changes) {
    const where = c.workspace && c.kind !== "workspace" ? ` (${c.workspace})` : "";
    lines.push(`${sign[c.op]} ${c.kind} ${c.name}${where}`);
    for (const f of c.fields) lines.push(`    ${f.pointer}: ${short(f.before)} -> ${short(f.after)}`);
  }
  const s = result.summary;
  lines.push(`${s["create"] ?? 0} to create, ${s["update"] ?? 0} to update, ${s["delete"] ?? 0} to delete, ${s["unchanged"] ?? 0} unchanged`);
  return lines.join("\n") + "\n";
}
