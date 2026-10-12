/** Usage explorer: by workspace, service, route and consumer over a time range, with CSV export. */

import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { type Json, formatBytes, formatNumber } from "../api";
import { BarChart, byBucket } from "../components/chart";
import { Card, Empty, ErrorState, Field, Loading, PageHead } from "../components/ui";
import { useNames, useUsage } from "../hooks";
import { useSession } from "../session";

const RANGES: Array<[string, string, number, "minute" | "hour" | "day"]> = [
  ["1h", "Last hour", 3600_000, "minute"],
  ["24h", "Last 24 hours", 24 * 3600_000, "hour"],
  ["7d", "Last 7 days", 7 * 24 * 3600_000, "hour"],
  ["30d", "Last 30 days", 30 * 24 * 3600_000, "day"],
];
const COLUMN: Record<string, string> = { workspace: "workspace_id", service: "service_id", route: "route_id", consumer: "consumer_id" };

/** Rows as CSV. Values are quoted so a name with a comma or a quote stays one cell. */
export function toCsv(rows: Json[], columns: string[]): string {
  const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [columns.join(","), ...rows.map((r) => columns.map((c) => quote(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(","))].join("\r\n") + "\r\n";
}

export function Usage() {
  const { workspace, workspaces, fleetAdmin } = useSession();
  const [range, setRange] = useState("24h");
  const [group, setGroup] = useState("route");
  const [everywhere, setEverywhere] = useState(false);
  const chosen = RANGES.find((r) => r[0] === range)!;
  const window = useMemo(() => {
    const to = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
    return { from: new Date(to.getTime() - chosen[2]).toISOString(), to: to.toISOString() };
  }, [chosen]);
  const scope = everywhere && fleetAdmin ? {} : { workspace };
  const series = useUsage({ ...scope, granularity: chosen[3], ...window });
  const grouped = useUsage({ ...scope, granularity: chosen[3], group_by: group, ...window });
  const names: Record<string, Map<string, string>> = {
    route: useNames("routes"), service: useNames("services"), consumer: useNames("consumers"),
    workspace: useMemo(() => new Map(workspaces.map((w) => [w["id"] as string, w["name"] as string])), [workspaces]),
  };

  const table = useMemo(() => {
    const column = COLUMN[group]!;
    const map = new Map<string, Json>();
    for (const r of grouped.data?.data ?? []) {
      const key = String(r[column] ?? "");
      const e = map.get(key) ?? { key, requests: 0, status_2xx: 0, status_4xx: 0, status_5xx: 0, bytes_in: 0, bytes_out: 0, latency_ms_sum: 0 };
      for (const k of Object.keys(e)) if (k !== "key") e[k] += Number(r[k] ?? 0);
      map.set(key, e);
    }
    return [...map.values()].sort((a, b) => b["requests"] - a["requests"]);
  }, [grouped.data, group]);
  const label = (key: string) => names[group]?.get(key) ?? (key === "" ? "(none)" : key);

  const download = () => {
    const rows = table.map((r) => ({ [group]: label(r["key"]), id: r["key"], requests: r["requests"], status_2xx: r["status_2xx"], status_4xx: r["status_4xx"], status_5xx: r["status_5xx"], bytes_in: r["bytes_in"], bytes_out: r["bytes_out"], average_latency_ms: r["requests"] > 0 ? Math.round(r["latency_ms_sum"] / r["requests"]) : 0 }));
    const url = URL.createObjectURL(new Blob([toCsv(rows, [group, "id", "requests", "status_2xx", "status_4xx", "status_5xx", "bytes_in", "bytes_out", "average_latency_ms"])], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage-${everywhere ? "all" : workspace}-${group}-${range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page stack">
      <PageHead title="Usage" actions={<button type="button" className="btn btn-ghost" disabled={table.length === 0} onClick={download}><Download size={13} aria-hidden="true" /> Export CSV</button>}>
        Counted by the nodes and reported about once a minute.
      </PageHead>

      <div className="filters">
        <Field label="Time range">{(id) => <select id={id} className="select" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select>}</Field>
        <Field label="Group by">{(id) => (
          <select id={id} className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="route">Route</option><option value="service">Service</option><option value="consumer">Consumer</option>
            {fleetAdmin && <option value="workspace">Workspace</option>}
          </select>
        )}</Field>
        {fleetAdmin && <label className="check" style={{ height: 32 }}><input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> All workspaces</label>}
      </div>

      <Card title="Requests over time" subtitle={`Per ${chosen[3]}; server errors in red`}>
        {series.isLoading && <Loading />}
        {series.error && <ErrorState error={series.error} retry={() => void series.refetch()} />}
        {series.data && (series.data.data.length === 0 ? <Empty title="No traffic in this range" /> : <div className="card-body"><BarChart points={byBucket(series.data.data)} label={`Requests per ${chosen[3]}`} /></div>)}
      </Card>

      <Card title={`By ${group}`} subtitle={grouped.data?.truncated ? "Only part of the data is shown; choose a shorter range." : undefined}>
        {grouped.isLoading && <Loading />}
        {grouped.error && <ErrorState error={grouped.error} retry={() => void grouped.refetch()} />}
        {grouped.data && (table.length === 0 ? <Empty title="No traffic in this range" /> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">{group}</th><th scope="col">Requests</th><th scope="col">2xx</th><th scope="col">4xx</th><th scope="col">5xx</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Avg latency</th></tr></thead>
            <tbody>
              {table.map((r) => (
                <tr key={r["key"]}>
                  <td>{label(r["key"])}</td>
                  <td className="num">{formatNumber(r["requests"])}</td>
                  <td className="num">{formatNumber(r["status_2xx"])}</td>
                  <td className="num">{formatNumber(r["status_4xx"])}</td>
                  <td className="num">{formatNumber(r["status_5xx"])}</td>
                  <td className="num">{formatBytes(r["bytes_in"])}</td>
                  <td className="num">{formatBytes(r["bytes_out"])}</td>
                  <td className="num">{r["requests"] > 0 ? `${Math.round(r["latency_ms_sum"] / r["requests"])} ms` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </Card>
    </div>
  );
}
