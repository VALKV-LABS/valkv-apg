# Observability

Four sources tell you what the gateway is doing: metrics, the access log, the nodes list, and the audit log.

## Metrics

Each node serves Prometheus metrics on its management port (9100), and the control plane on its API port. Neither needs credentials, so keep both ports off the internet.

```yaml
scrape_configs:
  - job_name: valkv-apg-nodes
    static_configs:
      - targets: ["edge-1:9100", "edge-2:9100"]
  - job_name: valkv-apg-admin
    static_configs:
      - targets: ["admin:9000"]
```

The ones to start with:

| Question | Metric |
|---|---|
| How much traffic, and how much of it fails? | `apg_requests_total{route, service, status_class}` |
| How slow? | `apg_request_duration_seconds` (histogram) |
| Is the gateway refusing, and why? | `apg_gateway_errors_total{code}`, `apg_limited_total{type}` |
| Are upstreams healthy? | `apg_backend_healthy`, `apg_backend_circuit_open`, `apg_upstream_retries_total` |
| Does every node have current configuration? | `apg_config_converged`, `apg_config_applied_seq`, `apg_config_source_age_seconds`; on the control plane `apg_nodes_max_lag` |
| Are certificates about to expire? | `apg_certs_expiring{within}` |

A Grafana dashboard and alert rules built on these are in `deploy/observability/`. The complete list is in the [metrics reference](../reference/metrics.md).

The Helm chart can create a `ServiceMonitor` (`serviceMonitor.enabled`).

## The access log

One JSON object per request, on the node's standard output by default:

```json
{"ts":"2026-06-01T12:00:00.123Z","request_id":"01a1…","trace_id":"89e7…","method":"GET","scheme":"https",
 "host":"api.example.com","path":"/orders/17","status":200,"duration_ms":12,"upstream_duration_ms":10,
 "bytes_in":0,"bytes_out":512,"route":"orders-api","service":"orders","backend":"10.0.0.1:8080",
 "workspace":"acme","consumer":"mobile-app","client_ip":"203.0.113.9","retries":0,"cache":"","error_code":""}
```

Header values are never logged. The query string is logged (`query`), with the values of parameters that usually carry secrets replaced. `APG_LOG_REDACT_QUERY` lists those parameter names; the default is `apikey,token,access_token,signature`. Add the name of any parameter your API takes a key in.

Where it goes and how much of it is set fleet-wide with the `access_log` setting (`sink` is `stdout`, `off` or `file:<path>`; `sample_rate` from 0 to 1), and per route, service or workspace with the [`access_log` plugin](../reference/plugins/access_log.md), which can also add fields of your own.

At high volume the log is written from a bounded queue: if the destination cannot keep up, lines are dropped rather than requests delayed, and `apg_access_log_dropped_total` counts them.

## Following one request

`X-Request-Id` is on every response and in every access-log line, and is sent to your upstream. A client that sends its own id keeps it.

The gateway also continues a W3C trace (`traceparent`) or starts one, and logs the trace id, so its lines can be joined with your services' traces. It does not export spans of its own yet.

## Is every node up to date?

```sh
apgctl nodes
```

or the console's **Nodes** page: version, applied sequence, how far behind, whether it is serving stale configuration, when it last reported. On a node:

```sh
curl http://localhost:9100/readyz     # ready, stale, applied_seq
curl http://localhost:9100/status     # counts of what it holds, per kind
```

## Why did this request go there?

The route tester: the console's **Routes** page, `apgctl route match --host … --path …`, or `GET /debug/match` on a node's management port. It names the route that would be chosen and, for every other candidate, why it was not.

## Who changed what?

Every change through the Admin API, and every refused attempt, is in the audit log with the actor, the request id, the source address, and the resource before and after (secrets masked). Console: **Audit log**. API: `GET /v1/audit?workspace=…&actor=…&kind=…&from=…&to=…`. Entries are kept for 400 days by default (`APG_AUDIT_RETENTION_DAYS`).

## Usage

Requests, bytes, status classes and latency per workspace, service, route and consumer, by minute, hour and day. Console: **Usage**. See [usage for billing](usage-billing.md).

## Logs of the processes themselves

Both processes log JSON to standard output (`APG_LOG_FORMAT=text` for people). `APG_LOG_LEVEL` is `info` by default. Secrets are never logged; `make e2e-security` checks that against every container's output.
