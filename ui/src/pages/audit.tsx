/** The audit log: who changed what, with the document before and after. */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Json, api, formatTime } from "../api";
import { Card, Dialog, Empty, ErrorState, Field, Loading, PageHead, Tag } from "../components/ui";
import { useSession } from "../session";

const KINDS = ["", "route", "service", "domain", "certificate", "ca_certificate", "consumer", "credential", "plugin", "workspace", "config", "token", "flag", "setting", "request"];

function Entry({ entry, onClose }: { entry: Json; onClose: () => void }) {
  const show = (doc: unknown) => (doc ? JSON.stringify(doc, null, 2) : "(nothing)");
  return (
    <Dialog title={`${entry["action"]} ${entry["kind"]} ${entry["resource_name"] ?? ""}`} onClose={onClose} foot={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="form">
        <p>{formatTime(entry["ts"])} by {entry["actor_name"]} ({entry["actor_kind"]}){entry["source_ip"] ? ` from ${entry["source_ip"]}` : ""}. Request <span className="mono">{entry["request_id"]}</span>.</p>
        <div className="split">
          <div><h3>Before</h3><pre className="code-block" tabIndex={0} aria-label="Before">{show(entry["before"])}</pre></div>
          <div><h3>After</h3><pre className="code-block" tabIndex={0} aria-label="After">{show(entry["after"])}</pre></div>
        </div>
        <p>Secrets are masked in the log.</p>
      </div>
    </Dialog>
  );
}

export function Audit() {
  const { workspace, fleetAdmin } = useSession();
  const [filters, setFilters] = useState({ actor: "", kind: "", from: "", to: "", everywhere: false });
  const [open, setOpen] = useState<Json | null>(null);
  const query = {
    ...(filters.everywhere && fleetAdmin ? {} : { workspace }),
    actor: filters.actor, kind: filters.kind,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(filters.to).toISOString() : undefined,
  };
  const log = useInfiniteQuery({
    queryKey: ["audit", query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ data: Json[]; next_cursor: string | null }>("GET", "/v1/audit", { query: { ...query, limit: 50, cursor: pageParam } }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (key: "actor" | "kind" | "from" | "to") => (e: { target: { value: string } }) => setFilters({ ...filters, [key]: e.target.value });

  return (
    <div className="page stack">
      <PageHead title="Audit log">Every change, and every change that was refused.</PageHead>
      <div className="filters">
        <Field label="Actor">{(id) => <input id={id} className="input" placeholder="Token name" value={filters.actor} onChange={set("actor")} />}</Field>
        <Field label="Kind">{(id) => <select id={id} className="select" value={filters.kind} onChange={set("kind")}>{KINDS.map((k) => <option key={k} value={k}>{k === "" ? "Any" : k.replace("_", " ")}</option>)}</select>}</Field>
        <Field label="From">{(id) => <input id={id} className="input" type="datetime-local" value={filters.from} onChange={set("from")} />}</Field>
        <Field label="To">{(id) => <input id={id} className="input" type="datetime-local" value={filters.to} onChange={set("to")} />}</Field>
        {fleetAdmin && <label className="check" style={{ height: 32 }}><input type="checkbox" checked={filters.everywhere} onChange={(e) => setFilters({ ...filters, everywhere: e.target.checked })} /> All workspaces</label>}
      </div>
      <Card title="Entries" subtitle="Newest first">
        {log.isLoading && <Loading />}
        {log.error && <ErrorState error={log.error} retry={() => void log.refetch()} />}
        {log.data && rows.length === 0 && <Empty title="No entries match" />}
        {rows.length > 0 && (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Kind</th><th scope="col">Resource</th><th scope="col">Outcome</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a["id"]}>
                  <td>{formatTime(a["ts"])}</td>
                  <td>{a["actor_name"]}</td>
                  <td>{a["action"]}</td>
                  <td>{a["kind"]}</td>
                  <td className="wrap">{a["resource_name"]}</td>
                  <td>{a["outcome"] === "ok" ? <Tag tone="ok">ok</Tag> : <Tag tone="danger">refused</Tag>}</td>
                  <td className="actions"><button type="button" className="btn btn-ghost btn-sm" aria-label={`Details of ${a["action"]} ${a["kind"]} ${a["resource_name"] ?? ""} at ${formatTime(a["ts"])}`} onClick={() => setOpen(a)}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {log.hasNextPage && <div className="card-body"><button type="button" className="btn btn-ghost" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>{log.isFetchingNextPage ? "Loading…" : "Load older entries"}</button></div>}
      </Card>
      {open && <Entry entry={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
