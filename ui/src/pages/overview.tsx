import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { type Json, api, formatNumber, formatTime, relativeTime } from "../api";
import { BarChart, byBucket } from "../components/chart";
import { Card, Empty, ErrorState, Loading, PageHead, Tag } from "../components/ui";
import { useCollection, useNames, useUsage } from "../hooks";
import { useSession } from "../session";

const DAY = 24 * 3600_000;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-delta">{note}</div>}
    </div>
  );
}

export function Overview() {
  const { workspace, fleetAdmin } = useSession();
  // One fixed window per visit, so the queries below share a cache key.
  const range = useMemo(() => {
    const to = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000);
    return { from: new Date(to.getTime() - DAY).toISOString(), to: to.toISOString() };
  }, []);
  const usage = useUsage({ workspace, granularity: "hour", ...range });
  const byRoute = useUsage({ workspace, granularity: "hour", group_by: "route", ...range });
  const byWorkspace = useUsage({ granularity: "hour", group_by: "workspace", ...range }, fleetAdmin);
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api<{ data: Json[] }>("GET", "/v1/nodes"), enabled: fleetAdmin, refetchInterval: 15_000 });
  const certificates = useCollection("certificates");
  const audit = useQuery({ queryKey: ["audit", workspace, "recent"], queryFn: () => api<{ data: Json[] }>("GET", "/v1/audit", { query: { workspace, limit: 8 } }) });
  const routeNames = useNames("routes");
  const { workspaces } = useSession();

  const totals = useMemo(() => {
    const rows = usage.data?.data ?? [];
    const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    const requests = sum("requests");
    return { requests, errors: sum("status_5xx"), latency: requests > 0 ? sum("latency_ms_sum") / requests : 0 };
  }, [usage.data]);

  const top = (rows: Json[], column: string) => {
    const map = new Map<string, { requests: number; errors: number }>();
    for (const r of rows) {
      const e = map.get(r[column]) ?? { requests: 0, errors: 0 };
      e.requests += Number(r["requests"]);
      e.errors += Number(r["status_5xx"]);
      map.set(r[column], e);
    }
    return [...map.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 6);
  };

  const live = (nodes.data?.data ?? []).filter((n) => n["live"]);
  const worstLag = Math.max(0, ...live.map((n) => Number(n["lag"])));
  const expiring = (certificates.data ?? [])
    .filter((c) => new Date(c["not_after"]).getTime() < Date.now() + 30 * DAY)
    .sort((a, b) => String(a["not_after"]).localeCompare(b["not_after"]));

  return (
    <div className="page">
      <PageHead title="Overview">The last 24 hours of {workspace}.</PageHead>

      <div className="stat-grid">
        <Stat label="Requests" value={usage.data ? formatNumber(totals.requests) : "…"} note={usage.data ? `${formatNumber(totals.requests / 86400)} per second on average` : undefined} />
        <Stat label="Server errors" value={usage.data ? (totals.requests > 0 ? `${((totals.errors / totals.requests) * 100).toFixed(2)}%` : "0%") : "…"} note={usage.data ? `${formatNumber(totals.errors)} responses with a 5xx status` : undefined} />
        <Stat label="Average latency" value={usage.data ? `${Math.round(totals.latency)} ms` : "…"} note="Measured at the gateway" />
        {fleetAdmin && <Stat label="Nodes" value={nodes.data ? String(live.length) : "…"} note={nodes.data ? (worstLag === 0 ? "All up to date" : `Furthest behind by ${worstLag} change${worstLag === 1 ? "" : "s"}`) : undefined} />}
      </div>

      <div className="stack">
        <Card title="Requests per hour" subtitle="Server errors in red">
          {usage.isLoading && <Loading />}
          {usage.error && <ErrorState error={usage.error} retry={() => void usage.refetch()} />}
          {usage.data && (usage.data.data.length === 0
            ? <Empty title="No traffic yet">Requests appear here about a minute after nodes report them.</Empty>
            : <div className="card-body"><BarChart points={byBucket(usage.data.data)} label="Requests per hour" /></div>)}
        </Card>

        <div className="split">
          <Card title="Busiest routes" actions={<Link to="/usage" className="btn btn-ghost btn-sm">Explore usage</Link>}>
            {byRoute.isLoading && <Loading />}
            {byRoute.error && <ErrorState error={byRoute.error} retry={() => void byRoute.refetch()} />}
            {byRoute.data && (top(byRoute.data.data, "route_id").length === 0 ? <Empty title="No traffic yet" /> : (
              <div className="table-scroll"><table className="t">
                <thead><tr><th scope="col">Route</th><th scope="col">Requests</th><th scope="col">5xx</th></tr></thead>
                <tbody>
                  {top(byRoute.data.data, "route_id").map(([id, n]) => (
                    <tr key={id}><td>{routeNames.get(id) ?? <span className="mono dim">{id || "no route"}</span>}</td><td className="num">{formatNumber(n.requests)}</td><td className="num">{formatNumber(n.errors)}</td></tr>
                  ))}
                </tbody>
              </table></div>
            ))}
          </Card>

          {fleetAdmin && (
            <Card title="Busiest workspaces">
              {byWorkspace.isLoading && <Loading />}
              {byWorkspace.error && <ErrorState error={byWorkspace.error} retry={() => void byWorkspace.refetch()} />}
              {byWorkspace.data && (top(byWorkspace.data.data, "workspace_id").length === 0 ? <Empty title="No traffic yet" /> : (
                <div className="table-scroll"><table className="t">
                  <thead><tr><th scope="col">Workspace</th><th scope="col">Requests</th><th scope="col">5xx</th></tr></thead>
                  <tbody>
                    {top(byWorkspace.data.data, "workspace_id").map(([id, n]) => (
                      <tr key={id}><td>{workspaces.find((w) => w["id"] === id)?.["name"] ?? <span className="mono dim">{id}</span>}</td><td className="num">{formatNumber(n.requests)}</td><td className="num">{formatNumber(n.errors)}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              ))}
            </Card>
          )}

          <Card title="Certificates expiring soon" subtitle="Within 30 days" actions={<Link to="/domains" className="btn btn-ghost btn-sm">Certificates</Link>}>
            {certificates.isLoading && <Loading />}
            {certificates.error && <ErrorState error={certificates.error} retry={() => void certificates.refetch()} />}
            {certificates.data && (expiring.length === 0 ? <Empty title="None">Every certificate is good for more than 30 days.</Empty> : (
              <div className="table-scroll"><table className="t">
                <thead><tr><th scope="col">Certificate</th><th scope="col">Expires</th></tr></thead>
                <tbody>
                  {expiring.map((c) => (
                    <tr key={c["id"]}><td>{c["name"]}</td><td><Tag tone={new Date(c["not_after"]).getTime() < Date.now() ? "danger" : "warn"}>{relativeTime(c["not_after"])}</Tag></td></tr>
                  ))}
                </tbody>
              </table></div>
            ))}
          </Card>

          <Card title="Recent changes" actions={<Link to="/audit" className="btn btn-ghost btn-sm">Audit log</Link>}>
            {audit.isLoading && <Loading />}
            {audit.error && <ErrorState error={audit.error} retry={() => void audit.refetch()} />}
            {audit.data && (audit.data.data.length === 0 ? <Empty title="Nothing has changed yet" /> : (
              <div className="table-scroll"><table className="t">
                <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr></thead>
                <tbody>
                  {audit.data.data.map((a) => (
                    <tr key={a["id"]}><td title={formatTime(a["ts"])}>{relativeTime(a["ts"])}</td><td>{a["actor_name"]}</td><td>{a["action"]} {a["kind"]} {a["resource_name"]}</td></tr>
                  ))}
                </tbody>
              </table></div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
