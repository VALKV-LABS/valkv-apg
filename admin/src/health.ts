/**
 * Backend health as the fleet sees it (spec OBS-4).
 *
 * Nodes do not share health state: each one probes and counts failures for
 * itself and says what it found in its heartbeat. This puts those reports side
 * by side per backend, so that "is this backend up" has one answer and, when
 * nodes disagree, the disagreement is visible.
 */

import type { Json, Row } from "./store.js";

export type HealthState = "healthy" | "unhealthy" | "unknown" | "down";

const STATES: HealthState[] = ["unhealthy", "unknown", "healthy", "down"];

/** A service is as good as its worst backend: one that is failing, or that nobody has checked, is what needs looking at. */
function worst(states: HealthState[]): HealthState {
  return STATES.find((s) => states.includes(s)) ?? "unknown";
}

/**
 * What several nodes say about one backend. One node that cannot reach it
 * matters more than several that can. A node that has sent it nothing knows
 * nothing, so it does not outvote a node that got an answer.
 */
function agreed(states: HealthState[]): HealthState {
  return (["unhealthy", "healthy"] as const).find((s) => states.includes(s)) ?? "unknown";
}

function stateOf(value: unknown): HealthState {
  return STATES.includes(value as HealthState) ? (value as HealthState) : "unknown";
}

/**
 * The health of `services` (rows of `apg_services`) according to `nodes`
 * (live rows of `apg_nodes`).
 *
 * A backend no node has reported on is `unknown`, never `healthy`: a node that
 * has not applied the service yet, or one too old to report per backend, says
 * nothing about it.
 */
export function summarize(services: Row[], nodes: Row[]): Json[] {
  // service id -> node id -> that node's report on the service
  const reports = new Map<string, Map<string, Json>>();
  for (const node of nodes) {
    for (const entry of (Array.isArray(node["info"]?.["backends"]) ? node["info"]["backends"] : []) as Json[]) {
      if (typeof entry?.["service_id"] !== "string") continue;
      let byNode = reports.get(entry["service_id"]);
      if (!byNode) reports.set(entry["service_id"], (byNode = new Map()));
      byNode.set(node["node_id"], entry);
    }
  }

  return services.map((service) => {
    const byNode = reports.get(service["id"]) ?? new Map<string, Json>();
    const backends = ((service["spec"]?.["backends"] ?? []) as Json[]).map((backend) => {
      const seen: Json[] = [];
      for (const [nodeId, entry] of byNode) {
        const b = (Array.isArray(entry["backends"]) ? (entry["backends"] as Json[]) : []).find((x) => x?.["target"] === backend["target"]);
        if (!b) continue;
        seen.push({
          node_id: nodeId,
          state: stateOf(b["state"]),
          ...(typeof b["reason"] === "string" ? { reason: b["reason"] } : {}),
          in_rotation: b["in_rotation"] === true,
          health_check: b["health_check"] === true,
          circuit: typeof b["circuit"] === "string" ? b["circuit"] : "closed",
          ...(Number.isFinite(b["seen_at"]) ? { seen_at: new Date(Number(b["seen_at"]) * 1000).toISOString() } : {}),
        });
      }
      const configuredDown = backend["status"] === "down";
      const state: HealthState = configuredDown ? "down" : agreed(seen.map((n) => n["state"]));
      const failing = seen.find((n) => n["state"] === "unhealthy" && n["reason"]);
      return {
        target: backend["target"],
        status: backend["status"] ?? "active",
        state,
        ...(state === "unhealthy" && failing ? { reason: failing["reason"] } : {}),
        nodes: seen,
      };
    });
    const counted = backends.filter((b) => b.state !== "down");
    const count = (s: HealthState) => counted.filter((b) => b.state === s).length;
    return {
      service_id: service["id"],
      name: service["name"],
      state: counted.length === 0 ? "down" : worst(counted.map((b) => b.state)),
      health_check: service["spec"]?.["health_check"]?.["active"] !== undefined && service["spec"]["health_check"]["active"]["enabled"] !== false,
      healthy: count("healthy"),
      unhealthy: count("unhealthy"),
      unknown: count("unknown"),
      nodes_reporting: byNode.size,
      backends,
    };
  });
}
