/** What a document would change, as the Config page and a rollback preview show it. */

import type { Json } from "../api";

export interface Change {
  op: "create" | "update" | "delete";
  workspace: string;
  kind: string;
  name: string;
  fields: Array<{ pointer: string; before?: unknown; after?: unknown }>;
}

const SIGN = { create: "+", update: "~", delete: "-" } as const;
const WORD = { create: "create", update: "update", delete: "delete" } as const;

const short = (v: unknown): string => {
  if (v === undefined) return "(unset)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
};

export function summaryText(summary: Json): string {
  return `${summary["create"] ?? 0} to create, ${summary["update"] ?? 0} to update, ${summary["delete"] ?? 0} to delete, ${summary["unchanged"] ?? 0} unchanged`;
}

export function ChangeList({ changes }: { changes: Change[] }) {
  if (changes.length === 0) return <div className="state">Nothing would change. The workspace already matches the document.</div>;
  return (
    <div role="list" aria-label="Changes">
      {changes.map((c, i) => (
        <div key={i} role="listitem">
          <div className={`diff-line diff-${c.op}`}>
            <span aria-hidden="true">{SIGN[c.op]} </span>
            <span className="sr-only">{WORD[c.op]} </span>
            {c.kind} {c.name}
          </div>
          {c.fields.map((f, j) => (
            <div key={j} className="diff-line diff-field">{f.pointer}: {short(f.before)} → {short(f.after)}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
