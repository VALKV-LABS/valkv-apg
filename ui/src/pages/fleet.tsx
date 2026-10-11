/** Fleet-wide pages, for a fleet admin only: workspaces, nodes, settings. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { type Json, api, formatTime, listAll, relativeTime } from "../api";
import { ResourceEditor } from "../components/resource";
import { Card, Confirm, Dialog, Empty, ErrorNotice, ErrorState, Field, Loading, PageHead, SecretOnce, Tabs, Tag } from "../components/ui";
import { useSchemas } from "../hooks";
import { useSession } from "../session";

// ── Workspaces ───────────────────────────────────────────────────────────────

export function Workspaces() {
  const session = useSession();
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["workspaces"], queryFn: () => listAll("/v1/workspaces") });
  const [editing, setEditing] = useState<Json | "new" | null>(null);
  const [deleting, setDeleting] = useState<Json | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["workspaces"] });
    await session.reloadWorkspaces();
  };
  const setStatus = (w: Json, status: string) => void api("PATCH", `/v1/workspaces/${w["id"]}`, { body: { status } }).then(refresh).catch(setError);
  const limits = (w: Json) => Object.entries((w["limits"] ?? {}) as Json).map(([k, v]) => `${k.replace("max_", "")} ≤ ${v}`).join(", ");

  return (
    <div className="page stack">
      <PageHead title="Workspaces">A workspace is one tenant: its own domains, routes, services and consumers.</PageHead>
      <ErrorNotice error={error} />
      <Card title="Workspaces" subtitle={list.data ? `${list.data.length} in all` : undefined}
        actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}><Plus size={13} aria-hidden="true" /> New workspace</button>}>
        {list.isLoading && <Loading />}
        {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
        {list.data && (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Name</th><th scope="col">Slug</th><th scope="col">Status</th><th scope="col">Limits</th><th scope="col">Created</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data.map((w) => (
                <tr key={w["id"]}>
                  <td><span className="row-link">{w["name"]}</span> {w["system"] && <Tag tone="info">system</Tag>}</td>
                  <td className="mono">{w["slug"]}</td>
                  <td>{w["status"] === "active" ? <Tag tone="ok" dot>active</Tag> : <Tag tone="warn" dot>suspended</Tag>}</td>
                  <td>{limits(w) || <span className="dim">none</span>}</td>
                  <td>{formatTime(w["created_at"])}</td>
                  <td className="actions">
                    {!w["system"] && (w["status"] === "active"
                      ? <button type="button" className="btn btn-ghost btn-sm" aria-label={`Suspend ${w["name"]}`} onClick={() => setStatus(w, "suspended")}>Suspend</button>
                      : <button type="button" className="btn btn-ghost btn-sm" aria-label={`Resume ${w["name"]}`} onClick={() => setStatus(w, "active")}>Resume</button>)}
                    <button type="button" className="icon-btn" aria-label={`Edit ${w["name"]}`} onClick={() => setEditing(w)}><Pencil size={14} aria-hidden="true" /></button>
                    {!w["system"] && <button type="button" className="icon-btn" aria-label={`Delete ${w["name"]}`} onClick={() => { setError(null); setDeleting(w); }}><Trash2 size={14} aria-hidden="true" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {editing && (
        <ResourceEditor
          title={editing === "new" ? "New workspace" : `Edit ${editing["name"]}`}
          schemaPath="resources/workspace.json"
          initial={editing === "new" ? {} : editing}
          hide={["system", ...(editing === "new" ? [] : ["id"])]}
          save={(value) => editing === "new" ? api("POST", "/v1/workspaces", { body: value }) : api("PUT", `/v1/workspaces/${editing["id"]}`, { body: value, ifMatch: editing["revision"] })}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void refresh(); }}
        />
      )}
      {deleting && (
        <Confirm title={`Delete workspace ${deleting["name"]}?`} confirmLabel="Delete workspace and everything in it" danger error={error} onClose={() => setDeleting(null)}
          onConfirm={() => void api("DELETE", `/v1/workspaces/${deleting["id"]}`, { query: { cascade: true } }).then(() => { setDeleting(null); return refresh(); }).catch(setError)}>
          <p>Its domains, routes, services, consumers and plugins are deleted with it, and nodes stop serving them. Usage already recorded is kept.</p>
        </Confirm>
      )}
    </div>
  );
}

// ── Nodes ────────────────────────────────────────────────────────────────────

/** Failing and unchecked backends as one node reports them, summed over its services. */
function backendCounts(node: Json): { healthy: number; unhealthy: number; unknown: number } {
  const services = (Array.isArray(node["info"]?.["backends"]) ? node["info"]["backends"] : []) as Json[];
  const sum = (key: string) => services.reduce((n, s) => n + Number(s[key] ?? 0), 0);
  return { healthy: sum("healthy"), unhealthy: sum("unhealthy"), unknown: sum("unknown") };
}

function NodeState({ node }: { node: Json }) {
  if (!node["live"]) return <Tag tone="danger" dot>not reporting</Tag>;
  if (node["stale"]) return <Tag tone="warn" dot>serving stale config</Tag>;
  return <Tag tone="ok" dot>live</Tag>;
}

/** One node on its own: what it holds, and every backend as this node sees it. */
function NodeDialog({ node, onClose }: { node: Json; onClose: () => void }) {
  const { workspaces } = useSession();
  const services = (Array.isArray(node["info"]?.["backends"]) ? node["info"]["backends"] : []) as Json[];
  const counts = (node["info"]?.["counts"] ?? {}) as Json;
  const rows = services.flatMap((s) => ((s["backends"] ?? []) as Json[]).map((b) => ({ service: s, backend: b })));
  const order = (state: string) => (state === "unhealthy" ? 0 : state === "unknown" ? 1 : 2);
  rows.sort((a, b) => order(a.backend["state"]) - order(b.backend["state"]));
  const facts: Array<[string, React.ReactNode]> = [
    ["State", <NodeState node={node} />],
    ["Version", node["version"]],
    ["Configuration from", node["source"]],
    ["Applied change", node["applied_seq"]],
    ["Behind by", node["lag"]],
    ["Region", node["region"] ?? "none"],
    ["Started", formatTime(node["started_at"])],
    ["Last reported", relativeTime(node["last_seen"])],
    ["Holds", `${counts["routes"] ?? 0} routes, ${counts["services"] ?? 0} services, ${counts["workspaces"] ?? 0} workspaces`],
  ];
  return (
    <Dialog title={`Node ${node["node_id"]}`} onClose={onClose} foot={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="form">
        {!node["live"] && <div className="notice notice-danger">This node has not reported for more than 30 seconds. What follows is the last thing it said.</div>}
        <div className="table-scroll"><table className="t">
          <tbody>{facts.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody>
        </table></div>
        <h3 style={{ fontSize: 13, margin: 0 }}>Backends as this node sees them</h3>
        {rows.length === 0 ? <Empty title="Nothing reported">{services.length === 0 ? "This node holds no services, or has not reported since it started." : "This node runs a version that reports counts only."}</Empty> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Workspace</th><th scope="col">Service</th><th scope="col">Backend</th><th scope="col">State</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {rows.map(({ service, backend }) => (
                <tr key={`${service["service_id"]} ${backend["target"]}`}>
                  <td>{workspaces.find((w) => w["id"] === service["workspace_id"])?.["name"] ?? <span className="dim">unknown</span>}</td>
                  <td>{service["name"]}</td>
                  <td className="mono">{backend["target"]}</td>
                  <td>{backend["state"] === "healthy" ? <Tag tone="ok" dot>healthy</Tag> : backend["state"] === "unhealthy" ? <Tag tone="danger" dot>failing</Tag> : backend["state"] === "down" ? <Tag tone="warn" dot>marked down</Tag> : <Tag dot>not checked</Tag>}</td>
                  <td>{backend["reason"] ?? ""}{backend["status"] === "active" && backend["in_rotation"] === false ? `${backend["reason"] ? "; " : ""}not sending it traffic` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </Dialog>
  );
}

export function Nodes() {
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api<{ data: Json[]; last_seq: number }>("GET", "/v1/nodes"), refetchInterval: 10_000 });
  const [open, setOpen] = useState<string | null>(null);
  const all = nodes.data?.data ?? [];
  const live = all.filter((n) => n["live"]);
  const behind = live.filter((n) => Number(n["lag"]) > 0).length;
  const stale = live.filter((n) => n["stale"]).length;
  const withFailing = live.filter((n) => backendCounts(n).unhealthy > 0).length;
  const silent = all.length - live.length;
  // Looked up again on every refresh, so an open node keeps up with what it reports.
  const inspected = open === null ? undefined : all.find((n) => n["node_id"] === open);
  const stat = (label: string, value: number, note: string, bad = value > 0) => (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{nodes.data ? value : "…"}</div>
      <div className="stat-delta">{nodes.data ? (bad ? note : "None") : ""}</div>
    </div>
  );
  return (
    <div className="page stack">
      <PageHead title="Nodes">The gateways that serve traffic. Each one reports here every few seconds. Open a node to see it on its own.</PageHead>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Live</div>
          <div className="stat-value">{nodes.data ? live.length : "…"}</div>
          <div className="stat-delta">{nodes.data ? (behind + stale + withFailing + silent === 0 ? "All up to date and reaching every backend" : `of ${all.length} known`) : ""}</div>
        </div>
        {stat("Not reporting", silent, "Silent for more than 30 seconds")}
        {stat("Behind", behind, "Have changes still to apply")}
        {stat("Serving stale config", stale, "Cannot reach the control plane")}
        {stat("With failing backends", withFailing, "Open a node to see which")}
      </div>
      <Card title="Nodes" subtitle={nodes.data ? `The newest change is number ${nodes.data.last_seq}` : undefined}>
        {nodes.isLoading && <Loading />}
        {nodes.error && <ErrorState error={nodes.error} retry={() => void nodes.refetch()} />}
        {nodes.data && (all.length === 0 ? <Empty title="No node has reported yet">A node appears here a few seconds after it starts with this control plane's address and a node token.</Empty> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Node</th><th scope="col">State</th><th scope="col">Version</th><th scope="col">Source</th><th scope="col">Applied</th><th scope="col">Behind by</th><th scope="col">Backends</th><th scope="col">Region</th><th scope="col">Last seen</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {all.map((n) => {
                const b = backendCounts(n);
                return (
                  <tr key={n["node_id"]}>
                    <td className="mono">{n["node_id"]}</td>
                    <td><NodeState node={n} /></td>
                    <td>{n["version"]}</td>
                    <td>{n["source"]}</td>
                    <td className="num">{n["applied_seq"]}</td>
                    <td className="num">{n["lag"] === 0 ? <span className="dim">0</span> : <Tag tone="warn">{n["lag"]}</Tag>}</td>
                    <td>{b.unhealthy > 0 ? <Tag tone="danger" dot>{b.unhealthy} failing</Tag> : b.healthy + b.unknown === 0 ? <span className="dim">none</span> : <Tag tone="ok" dot>none failing</Tag>}</td>
                    <td>{n["region"] ?? ""}</td>
                    <td title={formatTime(n["last_seen"])}>{relativeTime(n["last_seen"])}</td>
                    <td className="actions"><button type="button" className="icon-btn" aria-label={`Details of node ${n["node_id"]}`} title="What this node holds and sees" onClick={() => setOpen(n["node_id"])}><Search size={14} aria-hidden="true" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        ))}
      </Card>
      {inspected && <NodeDialog node={inspected} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

function Flags() {
  const client = useQueryClient();
  const flags = useQuery({ queryKey: ["flags"], queryFn: () => api<{ data: Json[] }>("GET", "/v1/flags") });
  const [error, setError] = useState<unknown>(null);
  const toggle = (f: Json) => void api("PUT", `/v1/flags/${f["name"]}`, { body: { enabled: !f["enabled"] } }).then(() => client.invalidateQueries({ queryKey: ["flags"] })).catch(setError);
  return (
    <Card title="Flags" subtitle="Switches that take effect on every node within a second or two">
      <ErrorNotice error={error} />
      {flags.isLoading && <Loading />}
      {flags.error && <ErrorState error={flags.error} retry={() => void flags.refetch()} />}
      {flags.data && (flags.data.data.length === 0 ? <Empty title="No flags" /> : (
        <div className="table-scroll"><table className="t">
          <thead><tr><th scope="col">Flag</th><th scope="col">State</th><th scope="col">Changed</th></tr></thead>
          <tbody>
            {flags.data.data.map((f) => (
              <tr key={f["name"]}>
                <td className="mono">{f["name"]}</td>
                <td><label className="check"><input type="checkbox" checked={f["enabled"]} onChange={() => toggle(f)} aria-label={`${f["name"]} enabled`} />{f["enabled"] ? "On" : "Off"}</label></td>
                <td>{formatTime(f["updated_at"])}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ))}
    </Card>
  );
}

function GatewaySettings() {
  const client = useQueryClient();
  const schemas = useSchemas();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<{ data: Json[] }>("GET", "/v1/settings") });
  const [editing, setEditing] = useState<string | null>(null);
  const names = Object.keys((schemas.data?.schemas.get("resources/settings.json")?.["properties"] ?? {}) as Json);
  const current = (name: string) => settings.data?.data.find((s) => s["name"] === name)?.["value"];
  return (
    <Card title="Gateway settings" subtitle="Routing behaviour that belongs to no single resource">
      {(schemas.isLoading || settings.isLoading) && <Loading />}
      {settings.error && <ErrorState error={settings.error} retry={() => void settings.refetch()} />}
      {schemas.data && settings.data && (
        <div className="table-scroll"><table className="t">
          <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {names.map((name) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td className="wrap mono">{current(name) === undefined ? <span className="dim">default</span> : JSON.stringify(current(name))}</td>
                <td className="actions"><button type="button" className="icon-btn" aria-label={`Edit ${name}`} onClick={() => setEditing(name)}><Pencil size={14} aria-hidden="true" /></button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {editing && (
        <ResourceEditor
          title={`Edit ${editing}`}
          schemaPath="resources/settings.json"
          initial={current(editing) === undefined ? {} : { [editing]: current(editing) }}
          hide={names.filter((n) => n !== editing)}
          save={async (value) => {
            if (value[editing] === undefined) throw new Error("Give the setting a value. To go back to the default, set the default value.");
            return api("PUT", `/v1/settings/${editing}`, { body: { value: value[editing] } });
          }}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void client.invalidateQueries({ queryKey: ["settings"] }); }}
        />
      )}
    </Card>
  );
}

function Tokens() {
  const client = useQueryClient();
  const { workspaces, actor } = useSession();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ data: Json[] }>("GET", "/v1/tokens") });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", role: "viewer", scope: [] as string[], expires: "" });
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Json | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["tokens"] });
  const scopeText = (t: Json) => (t["workspaces"] as string[]).includes("*") ? "all workspaces" : (t["workspaces"] as string[]).map((id) => workspaces.find((w) => w["id"] === id)?.["name"] ?? id).join(", ");

  const create = async () => {
    setError(null);
    try {
      const made = await api<Json>("POST", "/v1/tokens", { body: {
        name: form.name, role: form.role,
        ...(form.scope.length > 0 && form.role !== "node" ? { workspaces: form.scope } : {}),
        ...(form.expires ? { expires_at: new Date(form.expires).toISOString() } : {}),
      } });
      setSecret(made["token"]);
      setCreating(false);
      setForm({ name: "", role: "viewer", scope: [], expires: "" });
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card title="Admin tokens" subtitle="For people, scripts and nodes. Only a hash is stored."
      actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => { setError(null); setCreating(true); }}><Plus size={13} aria-hidden="true" /> New token</button>}>
      {secret && <div className="card-body"><SecretOnce label="New token" value={secret} /></div>}
      {tokens.isLoading && <Loading />}
      {tokens.error && <ErrorState error={tokens.error} retry={() => void tokens.refetch()} />}
      {tokens.data && (
        <div className="table-scroll"><table className="t">
          <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Scope</th><th scope="col">Starts with</th><th scope="col">Expires</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {tokens.data.data.map((t) => (
              <tr key={t["id"]}>
                <td>{t["name"]} {t["id"] === actor?.id && <Tag tone="info">you</Tag>}</td>
                <td>{t["role"]}</td>
                <td className="wrap">{scopeText(t)}</td>
                <td className="mono">{t["token_prefix"]}…</td>
                <td>{t["expires_at"] ? formatTime(t["expires_at"]) : <span className="dim">never</span>}</td>
                <td>{relativeTime(t["last_used_at"])}</td>
                <td className="actions"><button type="button" className="icon-btn" aria-label={`Revoke ${t["name"]}`} onClick={() => { setError(null); setRevoking(t); }}><Trash2 size={14} aria-hidden="true" /></button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {creating && (
        <Dialog narrow title="New token" onClose={() => setCreating(false)} foot={<>
          <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={form.name === ""} onClick={() => void create()}>Create</button>
        </>}>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <ErrorNotice error={error} />
            <Field label="Name" required hint="Lower-case letters, digits, dots and dashes.">{(id, d) => <input id={id} className="input" required aria-describedby={d} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Role" hint="A viewer reads. An editor changes resources. An admin also manages tokens, settings and workspaces. A node may only fetch configuration.">
              {(id, d) => <select id={id} className="select" aria-describedby={d} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{["viewer", "editor", "admin", "node"].map((r) => <option key={r}>{r}</option>)}</select>}
            </Field>
            {form.role !== "node" && (
              <Field label="Workspaces" hint="Select none for all workspaces. Hold Ctrl or Cmd to select several.">
                {(id, d) => (
                  <select id={id} className="select" multiple size={Math.min(6, Math.max(3, workspaces.length))} style={{ height: "auto" }} aria-describedby={d}
                    value={form.scope} onChange={(e) => setForm({ ...form, scope: [...e.target.selectedOptions].map((o) => o.value) })}>
                    {workspaces.map((w) => <option key={w["id"]} value={w["id"]}>{w["name"]}</option>)}
                  </select>
                )}
              </Field>
            )}
            <Field label="Expires" hint="Empty means it never expires.">{(id, d) => <input id={id} className="input" type="datetime-local" aria-describedby={d} value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />}</Field>
          </form>
        </Dialog>
      )}
      {revoking && (
        <Confirm title={`Revoke token ${revoking["name"]}?`} confirmLabel="Revoke" danger error={error} onClose={() => setRevoking(null)}
          onConfirm={() => void api("DELETE", `/v1/tokens/${revoking["id"]}`).then(() => { setRevoking(null); return refresh(); }).catch(setError)}>
          <p>Whatever uses it is refused from now on, and browser sessions opened with it end.</p>
        </Confirm>
      )}
    </Card>
  );
}

function Branding() {
  const { brand } = useSession();
  const rows: Array<[string, string, string]> = [
    ["Name", brand.brand_name, "APG_UI_BRAND_NAME"],
    ["Logo", brand.logo_url ?? "the first letter of the name", "APG_UI_LOGO_URL"],
    ["Accent colour", brand.primary_color ?? "built in", "APG_UI_PRIMARY_COLOR"],
    ["May be framed by", brand.embed_origins.join(", ") || "nobody", "APG_UI_EMBED_ORIGINS"],
    ["Version", brand.version, ""],
  ];
  return (
    <Card title="Branding" subtitle="Set in the control plane's environment; shown here for reference">
      <div className="table-scroll"><table className="t">
        <thead><tr><th scope="col">What</th><th scope="col">Now</th><th scope="col">Set with</th></tr></thead>
        <tbody>{rows.map(([what, now, env]) => <tr key={what}><td>{what}</td><td className="wrap">{now}</td><td className="mono">{env}</td></tr>)}</tbody>
      </table></div>
    </Card>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<"tokens" | "flags" | "settings" | "branding">("tokens");
  return (
    <div className="page">
      <PageHead title="Settings">Fleet-wide: these apply to every workspace and every node.</PageHead>
      <Tabs label="Section" value={tab} onChange={setTab} tabs={[["tokens", "Tokens"], ["flags", "Flags"], ["settings", "Gateway settings"], ["branding", "Branding"]]} />
      {tab === "tokens" && <Tokens />}
      {tab === "flags" && <Flags />}
      {tab === "settings" && <GatewaySettings />}
      {tab === "branding" && <Branding />}
    </div>
  );
}
