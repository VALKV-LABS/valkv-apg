/**
 * List, create, edit and delete for one kind of resource. Most pages are this
 * component with a few columns; what a kind adds goes in `rowActions` or
 * around it.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ApiError, type Json, api, ws } from "../api";
import { useCollection, useSchemas } from "../hooks";
import { useSession } from "../session";
import { type Choices, SchemaForm, shownPointers } from "./schema-form";
import { Card, Confirm, Dialog, Empty, ErrorNotice, ErrorState, Loading } from "./ui";

export interface Column {
  head: string;
  cell: (row: Json) => ReactNode;
}

export interface ResourceSpec {
  /** Plural, as shown: "Services". */
  title: string;
  /** Singular, lower case: "service". */
  singular: string;
  /** Path segment under the workspace. */
  segment: string;
  schemaPath: string;
  columns: Column[];
  /** Fields the form leaves out. */
  hide?: string[];
  /** What a new one starts as. */
  blank?: Json;
  emptyHint?: string;
  /** Selections for fields that name another resource. */
  choices?: Choices;
  /** Order of the rows; default is creation order. */
  sort?: (a: Json, b: Json) => number;
}

/** A dialog that edits one resource with a schema-driven form and reports the server's faults on the fields. */
export function ResourceEditor({ title, schemaPath, initial, hide, choices, save, onClose, onSaved, children }: {
  title: string; schemaPath: string; initial: Json; hide?: string[]; choices?: Choices | undefined;
  save: (value: Json) => Promise<Json>;
  onClose: () => void;
  onSaved: (result: Json) => void;
  children?: ReactNode;
}) {
  const schemas = useSchemas();
  const [value, setValue] = useState<Json>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const faults = error instanceof ApiError ? error.details : [];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await save(value));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      foot={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !schemas.data}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      {schemas.isLoading && <Loading label="Loading the form" />}
      {schemas.error && <ErrorState error={schemas.error} retry={() => void schemas.refetch()} />}
      {schemas.data && (
        <form id={formId} className="form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <ErrorNotice error={error} shown={shownPointers(faults, value)} />
          {children}
          <SchemaForm schemas={schemas.data.schemas} schemaPath={schemaPath} value={value} onChange={setValue} faults={faults} hide={hide ?? []} choices={choices ?? {}} />
        </form>
      )}
    </Dialog>
  );
}

export function ResourcePage({ spec, rowActions, headActions, onCreated }: {
  spec: ResourceSpec;
  rowActions?: (row: Json) => ReactNode;
  headActions?: ReactNode;
  /** Called with the server's answer to a create (it may carry a secret shown once). */
  onCreated?: (result: Json) => void;
}) {
  const { workspace, canWrite } = useSession();
  const client = useQueryClient();
  const list = useCollection(spec.segment);
  const [editing, setEditing] = useState<Json | "new" | null>(null);
  const [deleting, setDeleting] = useState<Json | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const all = spec.sort ? [...(list.data ?? [])].sort(spec.sort) : (list.data ?? []);
  const needle = filter.trim().toLowerCase();
  const rows = needle ? all.filter((r) => JSON.stringify(r).toLowerCase().includes(needle)) : all;
  const base = ws(workspace, spec.segment);
  const refresh = () => client.invalidateQueries({ queryKey: ["ws", workspace] });

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api("DELETE", `${base}/${deleting["id"]}`, { query: { cascade: cascade || undefined } });
      setDeleting(null);
      setCascade(false);
      await refresh();
    } catch (err) {
      setDeleteError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={spec.title}
      subtitle={list.data ? `${list.data.length} in ${workspace}` : undefined}
      actions={<>
        {all.length > 6 && (
          <input className="input" style={{ width: 180, height: 26 }} type="search" aria-label={`Filter ${spec.title.toLowerCase()}`} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        {headActions}
        {canWrite && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
            <Plus size={13} aria-hidden="true" /> New {spec.singular}
          </button>
        )}
      </>}
    >
      {list.isLoading && <Loading />}
      {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
      {list.data && list.data.length === 0 && (
        <Empty title={`No ${spec.title.toLowerCase()} yet`}>{spec.emptyHint}</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <div className="table-scroll">
          <table className="t">
            <thead>
              <tr>
                {spec.columns.map((c) => <th key={c.head} scope="col">{c.head}</th>)}
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row["id"]}>
                  {spec.columns.map((c) => <td key={c.head} className="wrap">{c.cell(row)}</td>)}
                  <td className="actions">
                    {rowActions?.(row)}
                    {canWrite && <>
                      <button type="button" className="icon-btn" aria-label={`Edit ${row["name"]}`} title="Edit" onClick={() => setEditing(row)}><Pencil size={14} aria-hidden="true" /></button>
                      <button type="button" className="icon-btn" aria-label={`Delete ${row["name"]}`} title="Delete" onClick={() => { setDeleteError(null); setCascade(false); setDeleting(row); }}><Trash2 size={14} aria-hidden="true" /></button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="state">Nothing matches the filter.</div>}
        </div>
      )}

      {editing && (
        <ResourceEditor
          title={editing === "new" ? `New ${spec.singular}` : `Edit ${editing["name"]}`}
          schemaPath={spec.schemaPath}
          initial={editing === "new" ? (spec.blank ?? {}) : editing}
          hide={spec.hide ?? []}
          choices={spec.choices}
          save={(value) => editing === "new"
            ? api("POST", base, { body: value })
            : api("PUT", `${base}/${editing["id"]}`, { body: value, ifMatch: editing["revision"] })}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            if (editing === "new") onCreated?.(result);
            setEditing(null);
            void refresh();
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete ${spec.singular} ${deleting["name"]}?`}
          confirmLabel="Delete"
          danger
          busy={busy}
          error={deleteError}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(null)}
        >
          <p>Nodes stop using it within a second or two. This cannot be undone here; an earlier config revision can bring it back.</p>
          {deleteError instanceof ApiError && deleteError.code === "IN_USE" && (
            <label className="check" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
              Also delete what refers to it
            </label>
          )}
        </Confirm>
      )}
    </Card>
  );
}
