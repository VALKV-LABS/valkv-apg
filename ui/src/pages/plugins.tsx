/** The plugin catalogue and the instances attached in this workspace. */

import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ApiError, type Json, api, ws } from "../api";
import { SchemaForm, plain, shownPointers } from "../components/schema-form";
import { Card, Confirm, Dialog, Empty, ErrorNotice, ErrorState, Field, Loading, PageHead, Tabs, Tag } from "../components/ui";
import { useCollection, useNames, useSchemas } from "../hooks";
import { useSession } from "../session";

const PHASE: Record<string, string> = {
  request: "before the request is forwarded", upstream_request: "as the request is sent upstream",
  response_headers: "when the response headers arrive", response_body: "as the response body passes", log: "after the response is sent",
};

/** Create or edit one plugin instance: where it attaches, then its configuration from the type's schema. */
function PluginEditor({ initial, onClose }: { initial: Json; onClose: () => void }) {
  const { workspace, workspaces } = useSession();
  const client = useQueryClient();
  const schemas = useSchemas();
  const services = useCollection("services");
  const routes = useCollection("routes");
  const consumers = useCollection("consumers");
  const [value, setValue] = useState<Json>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const editing = initial["id"] !== undefined;
  const system = workspaces.find((w) => w["name"] === workspace)?.["system"] === true;
  const faults = error instanceof ApiError ? error.details : [];
  const targets = value["scope"] === "service" ? services.data : value["scope"] === "route" ? routes.data : undefined;
  const set = (patch: Json) => setValue((v) => {
    const next = { ...v, ...patch };
    for (const [k, x] of Object.entries(patch)) if (x === undefined || x === "") delete next[k];
    return next;
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = ws(workspace, "plugins");
      const { id: _id, workspace_id: _w, revision, created_at: _c, updated_at: _u, ...body } = value;
      if (editing) await api("PUT", `${base}/${initial["id"]}`, { body, ifMatch: revision });
      else await api("POST", base, { body });
      await client.invalidateQueries({ queryKey: ["ws", workspace] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={editing ? `Edit ${initial["name"]}` : `Add ${value["type"]}`}
      onClose={onClose}
      foot={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !schemas.data}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      {schemas.isLoading && <Loading label="Loading the form" />}
      {schemas.error && <ErrorState error={schemas.error} retry={() => void schemas.refetch()} />}
      {schemas.data && (
        <form id={formId} className="form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <ErrorNotice error={error} shown={[...shownPointers(faults, value["config"] ?? {}, "/config"), "/scope_ref", "/name"].filter((p) => faults.some((f) => f.pointer === p))} />
          <div className="form-grid">
            <Field label="Attach to" required hint="The most specific attachment wins when several of one type could apply.">
              {(id, d) => (
                <select id={id} className="select" aria-describedby={d} value={value["scope"]} onChange={(e) => set({ scope: e.target.value, scope_ref: undefined })}>
                  {system && <option value="global">Every request (global)</option>}
                  <option value="workspace">This workspace</option>
                  <option value="service">One service</option>
                  <option value="route">One route</option>
                </select>
              )}
            </Field>
            {targets !== undefined && (
              <Field label={value["scope"] === "service" ? "Service" : "Route"} required error={faults.find((f) => f.pointer === "/scope_ref")?.message}>
                {(id) => (
                  <select id={id} className="select" value={value["scope_ref"] ?? ""} onChange={(e) => set({ scope_ref: e.target.value })}>
                    <option value="">Choose</option>
                    {targets.map((t) => <option key={t["id"]} value={t["id"]}>{t["name"]}</option>)}
                  </select>
                )}
              </Field>
            )}
            <Field label="Only for consumer" hint="Leave empty to apply to every caller.">
              {(id, d) => (
                <select id={id} className="select" aria-describedby={d} value={value["consumer"] ?? ""} onChange={(e) => set({ consumer: e.target.value })}>
                  <option value="">Every caller</option>
                  {(consumers.data ?? []).map((c) => <option key={c["id"]} value={c["id"]}>{c["name"]}</option>)}
                </select>
              )}
            </Field>
            <Field label="Name" hint="Optional. One is made up when left empty." error={faults.find((f) => f.pointer === "/name")?.message}>
              {(id, d) => <input id={id} className="input" aria-describedby={d} value={value["name"] ?? ""} onChange={(e) => set({ name: e.target.value })} />}
            </Field>
            <Field label="Priority" hint="Higher runs earlier. Empty uses the type's default.">
              {(id, d) => <input id={id} className="input" type="number" min={0} max={10000} aria-describedby={d} value={value["priority"] ?? ""} onChange={(e) => set({ priority: e.target.value === "" ? undefined : Number(e.target.value) })} />}
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={value["enabled"] !== false} onChange={(e) => set({ enabled: e.target.checked })} />
            Enabled
          </label>
          <fieldset className="fieldset">
            <legend>Configuration</legend>
            <SchemaForm schemas={schemas.data.schemas} schemaPath={`plugins/${value["type"]}.json`} value={value["config"] ?? {}} onChange={(config) => setValue((v) => ({ ...v, config }))} faults={faults} pointer="/config" />
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}

export function Plugins() {
  const { workspace, canWrite } = useSession();
  const client = useQueryClient();
  const [tab, setTab] = useState<"instances" | "catalogue">("instances");
  const schemas = useSchemas();
  const plugins = useCollection("plugins");
  const services = useNames("services");
  const routes = useNames("routes");
  const consumers = useNames("consumers");
  const [editing, setEditing] = useState<Json | null>(null);
  const [deleting, setDeleting] = useState<Json | null>(null);
  const [error, setError] = useState<unknown>(null);

  const where = (p: Json) => p["scope"] === "service" ? `service ${services.get(p["scope_ref"]) ?? p["scope_ref"]}` : p["scope"] === "route" ? `route ${routes.get(p["scope_ref"]) ?? p["scope_ref"]}` : p["scope"] === "global" ? "every request" : "this workspace";

  return (
    <div className="page">
      <PageHead title="Plugins">What the gateway does to requests and responses: authentication, limits, transformations, caching.</PageHead>
      <Tabs label="View" value={tab} onChange={setTab} tabs={[["instances", "Attached"], ["catalogue", "Catalogue"]]} />

      {tab === "instances" && (
        <Card title="Attached plugins" subtitle={plugins.data ? `${plugins.data.length} in ${workspace}` : undefined}
          actions={canWrite && <button type="button" className="btn btn-primary btn-sm" onClick={() => setTab("catalogue")}><Plus size={13} aria-hidden="true" /> Add plugin</button>}>
          {plugins.isLoading && <Loading />}
          {plugins.error && <ErrorState error={plugins.error} retry={() => void plugins.refetch()} />}
          {plugins.data && plugins.data.length === 0 && <Empty title="No plugins attached">Pick one from the catalogue to attach it to a route, a service or the whole workspace.</Empty>}
          {plugins.data && plugins.data.length > 0 && (
            <div className="table-scroll"><table className="t">
              <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Attached to</th><th scope="col">Only for</th><th scope="col">State</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {plugins.data.map((p) => (
                  <tr key={p["id"]}>
                    <td className="mono">{p["type"]}</td>
                    <td>{p["name"]}</td>
                    <td>{where(p)}</td>
                    <td>{p["consumer"] ? (consumers.get(p["consumer"]) ?? p["consumer"]) : <span className="dim">everyone</span>}</td>
                    <td>{p["enabled"] ? <Tag tone="ok" dot>on</Tag> : <Tag tone="warn" dot>off</Tag>}</td>
                    <td className="actions">{canWrite && <>
                      <button type="button" className="icon-btn" aria-label={`Edit ${p["name"]}`} onClick={() => setEditing(p)}><Pencil size={14} aria-hidden="true" /></button>
                      <button type="button" className="icon-btn" aria-label={`Delete ${p["name"]}`} onClick={() => { setError(null); setDeleting(p); }}><Trash2 size={14} aria-hidden="true" /></button>
                    </>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      )}

      {tab === "catalogue" && (
        <Card title="Catalogue" subtitle="In the order they run by default">
          {schemas.isLoading && <Loading />}
          {schemas.error && <ErrorState error={schemas.error} retry={() => void schemas.refetch()} />}
          {schemas.data && (
            <div className="table-scroll"><table className="t">
              <thead><tr><th scope="col">Type</th><th scope="col">What it does</th><th scope="col">Runs</th><th scope="col">Priority</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {schemas.data.pluginTypes.map((t) => (
                  <tr key={t["name"]}>
                    <td className="mono">{t["name"]}</td>
                    <td className="wrap">{plain(t["schema"]?.["description"]) ?? <span className="dim">Not available in this build.</span>}</td>
                    <td className="wrap">{(t["phases"] as string[]).map((p) => PHASE[p] ?? p).join("; ")}</td>
                    <td className="num">{t["default_priority"]}</td>
                    <td className="actions">
                      {!t["available"] ? <Tag>not built</Tag> : canWrite && (
                        <button type="button" className="btn btn-ghost btn-sm" aria-label={`Add ${t["name"]}`} onClick={() => setEditing({ type: t["name"], scope: "workspace", config: {} })}><Plus size={12} aria-hidden="true" /> Add</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      )}

      {editing && <PluginEditor initial={editing} onClose={() => { setEditing(null); setTab("instances"); }} />}
      {deleting && (
        <Confirm title={`Delete plugin ${deleting["name"]}?`} confirmLabel="Delete" danger error={error} onClose={() => setDeleting(null)}
          onConfirm={() => void api("DELETE", `${ws(workspace, "plugins")}/${deleting["id"]}`).then(() => { setDeleting(null); return client.invalidateQueries({ queryKey: ["ws", workspace] }); }).catch(setError)}>
          <p>It stops applying as soon as nodes hear of the change.</p>
        </Confirm>
      )}
    </div>
  );
}
