#!/usr/bin/env node
// Decides whether a canary may be promoted (spec PKG-4).
//
// It reads the management endpoints of the stable nodes and of the canary
// nodes twice, a window apart, and compares what happened in between:
//
//   1. server-error ratio: canary no more than 0.1 percentage points worse
//   2. p99 latency:        canary no more than 10 % worse
//   3. change events the canary could not apply: none in the window
//   4. every canary node ready, converged and not serving stale configuration
//
//   node deploy/canary/check.mjs \
//     --stable http://node-a:9100,http://node-b:9100 \
//     --canary http://node-c:9100 --window 900
//
// Exit code: 0 promote, 1 roll back, 2 not enough traffic to tell (hold).
// Needs Node 20 or newer and nothing else. No Prometheus is required; when you
// have one, deploy/observability/alerts.yaml holds the same rules as queries.

const DEFAULTS = { window: 900, maxErrorDelta: 0.001, maxLatencyRatio: 1.1, latencyFloorMs: 5, minRequests: 100 };

/** Parses Prometheus text into [{ name, labels, value }]. */
export function parseMetrics(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = {};
    for (const pair of (m[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]] = pair[2];
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}

/** What one scrape of one node says, reduced to what the decision needs. */
export function summarise(samples) {
  const sum = (name, where = () => true) => samples.filter((s) => s.name === name && where(s.labels)).reduce((n, s) => n + s.value, 0);
  const buckets = new Map();
  for (const s of samples.filter((x) => x.name === "apg_request_duration_seconds_bucket")) {
    const le = s.labels.le === "+Inf" ? Infinity : Number(s.labels.le);
    buckets.set(le, (buckets.get(le) ?? 0) + s.value);
  }
  return {
    requests: sum("apg_requests_total"),
    errors: sum("apg_requests_total", (l) => l.status_class === "5xx"),
    skipped: sum("apg_changelog_errors_total"),
    buckets,
  };
}

/** Adds up several nodes' summaries. */
export function combine(list) {
  const out = { requests: 0, errors: 0, skipped: 0, buckets: new Map() };
  for (const s of list) {
    out.requests += s.requests;
    out.errors += s.errors;
    out.skipped += s.skipped;
    for (const [le, n] of s.buckets) out.buckets.set(le, (out.buckets.get(le) ?? 0) + n);
  }
  return out;
}

/** What happened between two summaries of the same nodes. A restarted node counts from zero. */
export function delta(before, after) {
  const d = (a, b) => (b >= a ? b - a : b);
  const buckets = new Map();
  for (const [le, n] of after.buckets) buckets.set(le, d(before.buckets.get(le) ?? 0, n));
  return { requests: d(before.requests, after.requests), errors: d(before.errors, after.errors), skipped: d(before.skipped, after.skipped), buckets };
}

/** A quantile from cumulative histogram buckets, in seconds, interpolated inside the bucket it falls in. */
export function quantile(buckets, q) {
  const edges = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const total = edges.length > 0 ? edges[edges.length - 1][1] : 0;
  if (total === 0) return null;
  const rank = q * total;
  let lowerEdge = 0;
  let lowerCount = 0;
  for (const [le, count] of edges) {
    if (count >= rank) {
      if (le === Infinity) return lowerEdge; // beyond the largest finite bucket: report its edge
      return count === lowerCount ? le : lowerEdge + ((le - lowerEdge) * (rank - lowerCount)) / (count - lowerCount);
    }
    lowerEdge = le;
    lowerCount = count;
  }
  return lowerEdge;
}

/** Applies the promotion criteria. `ready` lists the canary nodes' readiness. */
export function decide(stable, canary, ready, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pct = (x) => `${(x * 100).toFixed(3)} %`;
  const ms = (x) => (x === null ? "no data" : `${(x * 1000).toFixed(1)} ms`);
  const criteria = [];

  const notReady = ready.filter((r) => !r.ready || r.stale);
  criteria.push({
    name: "canary nodes ready, converged, not stale",
    ok: ready.length > 0 && notReady.length === 0,
    detail: ready.length === 0 ? "no canary node answered" : notReady.length === 0 ? `${ready.length} of ${ready.length}` : notReady.map((r) => `${r.url}: ${!r.ready ? "not ready" : "stale"}`).join("; "),
  });
  criteria.push({ name: "change events the canary could not apply", ok: canary.skipped === 0, detail: `${canary.skipped} in the window` });

  const enough = canary.requests >= o.minRequests && stable.requests >= o.minRequests;
  const [se, ce] = [stable.requests > 0 ? stable.errors / stable.requests : 0, canary.requests > 0 ? canary.errors / canary.requests : 0];
  criteria.push({
    name: "server-error ratio no more than 0.1 points worse",
    ok: ce - se <= o.maxErrorDelta,
    detail: `stable ${pct(se)} of ${stable.requests}, canary ${pct(ce)} of ${canary.requests}`,
  });
  const [sp, cp] = [quantile(stable.buckets, 0.99), quantile(canary.buckets, 0.99)];
  const latencyOk = sp === null || cp === null || cp <= sp * o.maxLatencyRatio || cp * 1000 <= o.latencyFloorMs;
  criteria.push({ name: "p99 latency no more than 10 % worse", ok: latencyOk, detail: `stable ${ms(sp)}, canary ${ms(cp)}${cp !== null && cp * 1000 <= o.latencyFloorMs ? ` (under the ${o.latencyFloorMs} ms floor)` : ""}` });

  const failed = criteria.filter((c) => !c.ok);
  // A failed criterion is a reason to roll back however little traffic there was;
  // a pass on too little traffic proves nothing yet.
  const verdict = failed.length > 0 ? "rollback" : enough ? "promote" : "hold";
  return { verdict, criteria, reason: failed.length > 0 ? failed.map((c) => c.name).join("; ") : enough ? "every criterion held for the whole window" : `fewer than ${o.minRequests} requests on one side; keep the stage running` };
}

async function scrape(urls) {
  return combine(await Promise.all(urls.map(async (url) => {
    const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${url}/metrics answered ${res.status}`);
    return summarise(parseMetrics(await res.text()));
  })));
}

async function readiness(urls) {
  return Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      return { url, ready: res.status === 200 && body.ready === true, stale: body.stale === true };
    } catch {
      return { url, ready: false, stale: false };
    }
  }));
}

/** Watches both groups for `window` seconds and returns the decision. `during` runs while waiting (tests send traffic there). */
export async function observe({ stable, canary, window = DEFAULTS.window, during, ...opts }) {
  const before = { stable: await scrape(stable), canary: await scrape(canary) };
  if (during) await during();
  else await new Promise((r) => setTimeout(r, window * 1000));
  const after = { stable: await scrape(stable), canary: await scrape(canary) };
  return decide(delta(before.stable, after.stable), delta(before.canary, after.canary), await readiness(canary), opts);
}

function printDecision(d) {
  for (const c of d.criteria) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(`\n${d.verdict.toUpperCase()}: ${d.reason}`);
}

// ── Command line ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check.mjs")) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  const list = (v) => (v ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const [stable, canary] = [list(args.stable), list(args.canary)];
  if (stable.length === 0 || canary.length === 0) {
    console.error("usage: check.mjs --stable <mgmt url,...> --canary <mgmt url,...> [--window seconds] [--min-requests n] [--latency-floor-ms n]");
    process.exit(2);
  }
  const window = Number(args.window ?? DEFAULTS.window);
  console.log(`watching ${stable.length} stable and ${canary.length} canary node(s) for ${window} s`);
  const decision = await observe({
    stable, canary, window,
    ...(args["min-requests"] ? { minRequests: Number(args["min-requests"]) } : {}),
    ...(args["latency-floor-ms"] ? { latencyFloorMs: Number(args["latency-floor-ms"]) } : {}),
  }).catch((err) => {
    console.error(`cannot read the nodes: ${err.message}`);
    process.exit(1);
  });
  printDecision(decision);
  process.exit(decision.verdict === "promote" ? 0 : decision.verdict === "hold" ? 2 : 1);
}

export { printDecision };
