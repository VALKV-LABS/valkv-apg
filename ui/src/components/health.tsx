/**
 * Backend health as nodes report it: the query, the tag shown per service, the
 * per-backend breakdown, and the card on the overview.
 *
 * Three answers, not two. A backend no node has sent anything to is "not
 * checked", never "healthy": nothing is known about it yet.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { type Json, api, relativeTime, ws } from "../api";
import { useSession } from "../session";
import { Card, Dialog, Empty, ErrorState, Loading, Tag } from "./ui";

export interface Health {
  data: Json[];
  live_nodes: number;
}

/** Health of every service in the selected workspace. Nodes report every ten seconds, so this asks as often. */
export function useHealth() {
  const { workspace } = useSession();
  return useQuery({ queryKey: ["ws", workspace, "health"], queryFn: () => api<Health>("GET", ws(workspace, "health")), refetchInterval: 10_000 });
}

const NOT_CHECKED = "No node has sent anything to it yet. Add a health check to the service to find out before traffic does.";

function StateTag({ state }: { state: string }) {
  if (state === "healthy") return <Tag tone="ok" dot>healthy</Tag>;
  if (state === "unhealthy") return <Tag tone="danger" dot>failing</Tag>;
  if (state === "down") return <Tag tone="warn" dot>marked down</Tag>;
  return <span title={NOT_CHECKED}><Tag dot>not checked</Tag></span>;
}

/** One service's health in a few words. */
export function HealthTag({ health, live }: { health: Json | undefined; live: number | undefined }) {
  if (live === 0) return <span className="dim">no node is reporting</span>;
  if (!health) return <span className="dim">not reported</span>;
  const total = Number(health["healthy"]) + Number(health["unhealthy"]) + Number(health["unknown"]);
  if (health["state"] === "unhealthy") {
    return <Tag tone={Number(health["unhealthy"]) === total ? "danger" : "warn"} dot>{health["unhealthy"]} of {total} failing</Tag>;
  }
  return <StateTag state={health["state"]} />;
}

/** Every backend of one service, with what each node says about it. */
export function HealthDialog({ name, health, onClose }: { name: string; health: Json | undefined; onClose: () => void }) {
  const backends = (health?.["backends"] ?? []) as Json[];
  return (
    <Dialog title={`Health of ${name}`} onClose={onClose} foot={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="form">
        {health && !health["health_check"] && (
          <div className="notice">This service has no health check, so a node learns about a backend only from the requests it sends there. To have every node check each backend on its own, edit the service and fill in the health check.</div>
        )}
        {!health ? <Empty title="Not reported yet">Nodes report every ten seconds.</Empty> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Backend</th><th scope="col">State</th><th scope="col">What nodes say</th></tr></thead>
            <tbody>
              {backends.map((b) => {
                const nodes = (b["nodes"] ?? []) as Json[];
                return (
                  <tr key={b["target"]}>
                    <td className="mono">{b["target"]}</td>
                    <td><StateTag state={b["state"]} /></td>
                    <td>
                      {nodes.length === 0 ? <span className="dim">{b["state"] === "down" ? "Not used" : "No node has reported on it"}</span> : (
                        <ul className="plain-list">
                          {nodes.map((n) => (
                            <li key={n["node_id"]}>
                              <span className="mono">{n["node_id"]}</span>: {n["state"] === "unhealthy" ? `failing${n["reason"] ? `, ${n["reason"]}` : ""}` : n["state"] === "healthy" ? "answering" : "nothing sent yet"}
                              {n["state"] !== "unknown" && n["seen_at"] ? ` (${relativeTime(n["seen_at"])})` : ""}
                              {b["status"] === "active" && !n["in_rotation"] ? "; not sending it traffic" : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
    </Dialog>
  );
}

/** Counts over every service of the workspace. */
export function healthTotals(health: Health | undefined): { healthy: number; unhealthy: number; unknown: number } {
  const sum = (key: string) => (health?.data ?? []).reduce((n, s) => n + Number(s[key] ?? 0), 0);
  return { healthy: sum("healthy"), unhealthy: sum("unhealthy"), unknown: sum("unknown") };
}

/** The overview's answer to "is anything behind the gateway down". */
export function HealthCard() {
  const health = useHealth();
  const failing = (health.data?.data ?? []).flatMap((s) => ((s["backends"] ?? []) as Json[]).filter((b) => b["state"] === "unhealthy").map((b) => ({ service: s["name"] as string, backend: b })));
  const totals = healthTotals(health.data);
  return (
    <Card title="Backend health" subtitle="As nodes report it" actions={<Link to="/services" className="btn btn-ghost btn-sm">Per backend</Link>}>
      {health.isLoading && <Loading />}
      {health.error && <ErrorState error={health.error} retry={() => void health.refetch()} />}
      {health.data && (health.data.live_nodes === 0
        ? <Empty title="No node is reporting">Health comes from nodes. None has been heard from in the last 30 seconds.</Empty>
        : failing.length === 0
          ? <Empty title="No backend is failing">{totals.healthy} answering{totals.unknown > 0 ? `, ${totals.unknown} not checked yet` : ""}.</Empty>
          : (
            <div className="table-scroll"><table className="t">
              <thead><tr><th scope="col">Service</th><th scope="col">Backend</th><th scope="col">Why</th><th scope="col">Nodes</th></tr></thead>
              <tbody>
                {failing.map(({ service, backend }) => {
                  const nodes = (backend["nodes"] ?? []) as Json[];
                  return (
                    <tr key={`${service} ${backend["target"]}`}>
                      <td>{service}</td>
                      <td className="mono">{backend["target"]}</td>
                      <td>{backend["reason"] ?? <span className="dim">no reason given</span>}</td>
                      <td className="num">{nodes.filter((n) => n["state"] === "unhealthy").length} of {nodes.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          ))}
    </Card>
  );
}
