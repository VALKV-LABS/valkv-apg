/** Routes, services and consumers. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, FlaskConical, KeyRound, Layers, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { type Json, api, formatNumber, formatTime, ws } from "../api";
import { BarChart, byBucket } from "../components/chart";
import { HealthDialog, HealthTag, useHealth } from "../components/health";
import { ResourceEditor, ResourcePage, type ResourceSpec } from "../components/resource";
import { Card, Confirm, Dialog, Empty, ErrorNotice, ErrorState, Field, Loading, PageHead, SecretOnce, Tag, Tags } from "../components/ui";
import { useCollection, useNames, useUsage } from "../hooks";
import { useSession } from "../session";

// ── Routes ───────────────────────────────────────────────────────────────────

const pathText = (p: Json | string) => (typeof p === "string" ? p : p["type"] === "prefix" ? p["value"] : `${p["type"]} ${p["value"]}`);

/** Which route would a request hit, and why not the others (spec RT-6). */
function RouteTester() {
  const [form, setForm] = useState({ host: "", path: "/", method: "GET", header: "" });
  const [asked, setAsked] = useState<typeof form | null>(null);
  const result = useQuery({
    queryKey: ["match", asked],
    enabled: asked !== null,
    retry: false,
    queryFn: () => api<Json>("GET", "/v1/debug/match", { query: { host: asked!.host, path: asked!.path, method: asked!.method, header: asked!.header.split("\n").map((s) => s.trim()).filter(Boolean) } }),
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  return (
    <Card title="Route tester" subtitle="Ask a node which route a request would hit">
      <form className="card-body form" onSubmit={(e) => { e.preventDefault(); setAsked({ ...form }); }}>
        <div className="form-grid">
          <Field label="Host" required>{(id) => <input id={id} className="input" required placeholder="api.example.com" value={form.host} onChange={set("host")} />}</Field>
          <Field label="Path" required>{(id) => <input id={id} className="input" required value={form.path} onChange={set("path")} />}</Field>
          <Field label="Method">{(id) => (
            <select id={id} className="select" value={form.method} onChange={set("method")}>
              {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => <option key={m}>{m}</option>)}
            </select>
          )}</Field>
          <Field label="Headers" hint="One per line, as Name: value.">{(id, d) => <input id={id} className="input" aria-describedby={d} placeholder="X-Api-Version: 2" value={form.header} onChange={set("header")} />}</Field>
        </div>
        <div><button type="submit" className="btn btn-ghost"><FlaskConical size={13} aria-hidden="true" /> Test</button></div>
        {result.isFetching && <Loading label="Asking a node" />}
        {result.error && !result.isFetching && <ErrorNotice error={result.error} />}
        {result.data && !result.isFetching && (
          <div aria-live="polite">
            <div className={`notice ${result.data["selected"] ? "notice-ok" : "notice-warn"}`}>
              {result.data["selected"]
                ? <>This request goes to route <strong>{result.data["selected"]["route"]}</strong> ({result.data["selected"]["tier"]} tier, {result.data["selected"]["path"] || "path not shown"}).</>
                : <>No route matches this request. The gateway would answer 404.</>}
            </div>
            {(result.data["candidates"] as Json[]).filter((c) => !c["selected"]).length > 0 && (
              <div className="table-scroll" style={{ marginTop: 12 }}><table className="t">
                <caption className="sr-only">Routes that were considered and not chosen</caption>
                <thead><tr><th scope="col">Not chosen</th><th scope="col">Tier</th><th scope="col">Path</th><th scope="col">Why</th></tr></thead>
                <tbody>
                  {(result.data["candidates"] as Json[]).filter((c) => !c["selected"]).map((c, i) => (
                    <tr key={i}><td>{c["route"]}</td><td>{c["tier"]}</td><td className="mono">{c["path"]}</td><td className="wrap">{c["reason"]}</td></tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

/** Which plugin instance wins per type on a route, and why (spec PL-1). */
function EffectivePlugins({ route, onClose }: { route: Json; onClose: () => void }) {
  const { workspace } = useSession();
  const q = useQuery({ queryKey: ["effective", workspace, route["id"]], queryFn: () => api<{ data: Json[] }>("GET", `${ws(workspace, "routes")}/${route["id"]}/effective-plugins`) });
  const range = useMemo(() => ({ from: new Date(Date.now() - 24 * 3600_000).toISOString() }), []);
  const usage = useUsage({ workspace, route: route["id"], granularity: "hour", ...range });
  return (
    <Dialog title={`Route ${route["name"]}`} onClose={onClose} foot={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="form">
        <div>
          <h3>Requests in the last 24 hours</h3>
          {usage.isLoading && <Loading />}
          {usage.error && <ErrorState error={usage.error} retry={() => void usage.refetch()} />}
          {usage.data && (usage.data.data.length === 0 ? <p>No requests yet.</p> : <BarChart points={byBucket(usage.data.data)} label={`Requests per hour on ${route["name"]}`} />)}
        </div>
        <div>
          <h3>Plugins that run on this route</h3>
          <p>In the order they run. The most specific instance of each type wins.</p>
        </div>
        {q.isLoading && <Loading />}
        {q.error && <ErrorState error={q.error} retry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <Empty title="No plugins run on this route" /> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Type</th><th scope="col">Applies</th><th scope="col">Only for some callers</th><th scope="col">Overridden</th></tr></thead>
            <tbody>
              {q.data.data.map((p) => (
                <tr key={p["type"]}>
                  <td><span className="mono">{p["type"]}</span></td>
                  <td>{p["applies"] ? <>{p["applies"]["name"]} <Tag>{p["applies"]["scope"]}</Tag> {!p["applies"]["runs"] && <Tag tone="warn">disabled</Tag>}</> : <span className="dim">none</span>}</td>
                  <td>{(p["conditional"] as Json[]).map((c) => c["name"]).join(", ") || <span className="dim">none</span>}</td>
                  <td>{(p["shadowed"] as Json[]).map((c) => `${c["name"]} (${c["scope"]})`).join(", ") || <span className="dim">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </div>
    </Dialog>
  );
}

export function Routes() {
  const services = useNames("services");
  const serviceChoices = [...services].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const [inspect, setInspect] = useState<Json | null>(null);
  const spec: ResourceSpec = {
    title: "Routes", singular: "route", segment: "routes", schemaPath: "resources/route.json",
    // idle_timeout_ms is not enforced by nodes yet, so the form does not offer it.
    hide: ["plugins", "cache_epoch", "idle_timeout_ms"],
    choices: { service: serviceChoices },
    blank: { paths: ["/"] },
    emptyHint: "A route sends requests for a host and path to a service.",
    // The order nodes try them in, most important first (priority, then how specific the route is).
    sort: (a, b) => Number(b["priority"]) - Number(a["priority"]) || (b["hosts"]?.length ? 1 : 0) - (a["hosts"]?.length ? 1 : 0) || String(a["name"]).localeCompare(b["name"]),
    columns: [
      { head: "Name", cell: (r) => <span className="row-link">{r["name"]}</span> },
      { head: "Hosts", cell: (r) => <Tags items={r["hosts"]} /> },
      { head: "Paths", cell: (r) => <span className="mono">{((r["paths"] ?? []) as Json[]).map(pathText).join(", ") || "any"}</span> },
      { head: "Methods", cell: (r) => (r["methods"]?.length ? r["methods"].join(", ") : <span className="dim">any</span>) },
      { head: "Goes to", cell: (r) => r["service"] ? (services.get(r["service"]) ?? r["service"]) : ((r["split"] ?? []) as Json[]).map((s) => `${services.get(s["service"]) ?? s["service"]} ×${s["weight"]}`).join(", ") },
      { head: "Priority", cell: (r) => <span className="num">{r["priority"]}</span> },
      { head: "State", cell: (r) => (r["enabled"] ? <Tag tone="ok" dot>on</Tag> : <Tag tone="warn" dot>off</Tag>) },
    ],
  };
  return (
    <div className="page stack">
      <PageHead title="Routes">Listed in the order nodes try them.</PageHead>
      <ResourcePage spec={spec} rowActions={(row) => (
        <button type="button" className="icon-btn" aria-label={`Plugins and usage of ${row["name"]}`} title="Plugins and usage" onClick={() => setInspect(row)}><Layers size={14} aria-hidden="true" /></button>
      )} />
      <RouteTester />
      {inspect && <EffectivePlugins route={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

// ── Services ─────────────────────────────────────────────────────────────────

export function Services() {
  const [inspect, setInspect] = useState<Json | null>(null);
  const certificates = useNames("certificates");
  const certificateChoices = [...certificates].map(([value, label]) => ({ value, label }));
  const reported = useHealth();
  const health = useMemo(() => new Map((reported.data?.data ?? []).map((s) => [s["service_id"] as string, s])), [reported.data]);

  const spec: ResourceSpec = {
    title: "Services", singular: "service", segment: "services", schemaPath: "resources/service.json",
    hide: ["plugins", "egress_restricted", "drain_timeout_ms"],
    choices: { client_certificate: certificateChoices },
    // A new service checks that each backend accepts connections, so that a dead one shows without waiting for traffic.
    blank: { backends: [{ target: "" }], health_check: { active: { type: "tcp" } } },
    emptyHint: "A service is one upstream application and the backends that serve it.",
    columns: [
      { head: "Name", cell: (r) => <span className="row-link">{r["name"]}</span> },
      { head: "Backends", cell: (r) => (
        <span className="tags">{((r["backends"] ?? []) as Json[]).map((b) => (
          <Tag key={b["target"]} tone={b["status"] === "active" ? undefined : "warn"}>{b["target"]}{b["weight"] !== 1 ? ` ×${b["weight"]}` : ""}{b["status"] !== "active" ? ` ${b["status"]}` : ""}</Tag>
        ))}</span>
      ) },
      { head: "Protocol", cell: (r) => `${r["scheme"]}, HTTP/${r["http_version"]}` },
      { head: "Balancing", cell: (r) => r["load_balancing"]?.["strategy"] ?? "round_robin" },
      { head: "Health", cell: (r) => <HealthTag health={health.get(r["id"])} live={reported.data?.live_nodes} /> },
    ],
  };
  return (
    <div className="page stack">
      <PageHead title="Services">Where requests are sent. To drain a backend, edit the service and set the backend's status to draining.</PageHead>
      <ResourcePage spec={spec} rowActions={(row) => (
        <button type="button" className="icon-btn" aria-label={`Health of ${row["name"]}`} title="Health of each backend" onClick={() => setInspect(row)}><Activity size={14} aria-hidden="true" /></button>
      )} />
      {inspect && <HealthDialog name={inspect["name"]} health={health.get(inspect["id"])} onClose={() => setInspect(null)} />}
    </div>
  );
}

// ── Consumers ────────────────────────────────────────────────────────────────

function Credentials({ consumer, onClose }: { consumer: Json; onClose: () => void }) {
  const { workspace, canWrite } = useSession();
  const client = useQueryClient();
  const base = `${ws(workspace, "consumers")}/${consumer["id"]}/credentials`;
  const list = useQuery({ queryKey: ["ws", workspace, "credentials", consumer["id"]], queryFn: () => api<{ data: Json[] }>("GET", base, { query: { limit: 500 } }) });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Json | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["ws", workspace, "credentials", consumer["id"]] });

  return (
    <Dialog title={`Credentials of ${consumer["name"]}`} onClose={onClose} foot={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="form">
        {secret && <SecretOnce label="New API key" value={secret} />}
        {list.isLoading && <Loading />}
        {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
        {list.data && (list.data.data.length === 0 ? <Empty title="No credentials">This consumer cannot authenticate until it has one.</Empty> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Identifies as</th><th scope="col">State</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data.data.map((c) => (
                <tr key={c["id"]}>
                  <td>{c["name"]}</td>
                  <td>{c["type"]}</td>
                  <td className="mono">{c["key_prefix"] ? `${c["key_prefix"]}…` : (c["username"] ?? c["identity"])}</td>
                  <td>{c["enabled"] ? <Tag tone="ok" dot>on</Tag> : <Tag tone="warn" dot>off</Tag>}</td>
                  <td>{c["expires_at"] ? formatTime(c["expires_at"]) : <span className="dim">never</span>}</td>
                  <td className="actions">{canWrite && <button type="button" className="icon-btn" aria-label={`Delete credential ${c["name"]}`} onClick={() => { setError(null); setRemoving(c); }}><Trash2 size={14} aria-hidden="true" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
        {canWrite && <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Plus size={12} aria-hidden="true" /> Add credential</button></div>}
      </div>

      {adding && (
        <ResourceEditor
          title={`New credential for ${consumer["name"]}`}
          schemaPath="resources/credential.json"
          initial={{ type: "key" }}
          hide={["consumer_id", "key_prefix"]}
          save={(value) => api("POST", base, { body: value })}
          onClose={() => setAdding(false)}
          onSaved={(result) => {
            // A generated key is in this one response and nowhere else (spec UI-8).
            setSecret(typeof result["key"] === "string" ? result["key"] : null);
            setAdding(false);
            void refresh();
          }}
        >
          <div className="notice">Leave the key empty to have one generated. It is shown once, right after saving.</div>
        </ResourceEditor>
      )}
      {removing && (
        <Confirm title={`Delete credential ${removing["name"]}?`} confirmLabel="Delete" danger error={error} onClose={() => setRemoving(null)}
          onConfirm={() => void api("DELETE", `${base}/${removing["id"]}`).then(() => { setRemoving(null); void refresh(); }).catch(setError)}>
          <p>Requests using it are refused as soon as nodes hear of the change.</p>
        </Confirm>
      )}
    </Dialog>
  );
}

export function Consumers() {
  const [open, setOpen] = useState<Json | null>(null);
  const consumers = useCollection("consumers");
  const groups = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of consumers.data ?? []) for (const g of (c["groups"] ?? []) as string[]) map.set(g, (map.get(g) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [consumers.data]);
  const spec: ResourceSpec = {
    title: "Consumers", singular: "consumer", segment: "consumers", schemaPath: "resources/consumer.json",
    hide: ["credentials"],
    emptyHint: "A consumer is an identified caller: an application, a partner, a team.",
    columns: [
      { head: "Name", cell: (r) => <span className="row-link">{r["name"]}</span> },
      { head: "Custom id", cell: (r) => r["custom_id"] ?? <span className="dim">none</span> },
      { head: "Groups", cell: (r) => <Tags items={r["groups"]} /> },
      { head: "Created", cell: (r) => formatTime(r["created_at"]) },
    ],
  };
  return (
    <div className="page stack">
      <PageHead title="Consumers">Who calls your APIs, and what they authenticate with.</PageHead>
      <ResourcePage spec={spec} rowActions={(row) => (
        <button type="button" className="icon-btn" aria-label={`Credentials of ${row["name"]}`} title="Credentials" onClick={() => setOpen(row)}><KeyRound size={14} aria-hidden="true" /></button>
      )} />
      {groups.length > 0 && (
        <Card title="Groups" subtitle="Used by the acl plugin">
          <div className="card-body tags">{groups.map(([g, n]) => <Tag key={g}>{g} · {formatNumber(n)}</Tag>)}</div>
        </Card>
      )}
      {open && <Credentials consumer={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
