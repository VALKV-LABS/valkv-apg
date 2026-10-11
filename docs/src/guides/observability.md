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

## Is a backend up?

Each node works out backend health for itself and reports it. There are three answers, not two:

| State | Means |
|---|---|
| healthy | The node's last health check, or the last request it sent there, was answered |
| failing | The last check or request failed, or the circuit breaker has cut the backend off. The reason is given: `connection refused`, `the host name does not resolve`, `connecting timed out`, `the health check at /healthz answered 503`, and so on |
| not checked | The node has sent nothing to the backend yet, so it knows nothing about it |

A backend is never called healthy before something has been sent to it. Without a health check a node learns about a backend only from real requests, so a backend that gets no traffic stays "not checked", and two nodes can differ: the one that tried it says failing, the one that did not says not checked. Give the service a health check and every node finds out for itself within a few seconds:

```yaml
version: 1
services:
  - name: orders
    backends:
      - target: "10.0.0.1:8080"
    health_check:
      active: { type: tcp }
routes:
  - name: orders
    service: orders
    paths: [/orders]
```

`type: tcp` only opens a connection. The default, `http`, requests `path` (default `/healthz`) and expects a 2xx or 3xx status. A service created in the console starts with a `tcp` check.

Where to look:

- **The console.** The overview lists every failing backend with the reason and how many nodes see it. The Services page shows a state per service, and the health button on a row shows each backend as each node sees it.
- **`apgctl health`**, or `apgctl health <service>`. It exits 1 when a backend is failing, so it can gate a script.
- **The Admin API**, with any token that can read the workspace:

  ```sh
  curl -H "Authorization: Bearer $APG_ADMIN_TOKEN" https://admin.example.com/v1/workspaces/default/health
  curl -H "Authorization: Bearer $APG_ADMIN_TOKEN" https://admin.example.com/v1/workspaces/default/services/orders/health
  ```

  The answer has each backend's state, the reason, and what each live node reported. Nodes report every ten seconds, so it can be that old.
- **A node itself**, on its management port. This is the only view in standalone mode, and it is immediate:

  ```sh
  curl http://localhost:9100/upstreams
  curl 'http://localhost:9100/upstreams?service=orders'
  curl 'http://localhost:9100/upstreams?service=orders&backend=10.0.0.1:8080'
  ```

  The management port takes no token. It is bound to loopback by default and is meant to stay on a private network, like `/metrics`. A node cannot check an admin token: it holds no list of them.
- **Metrics**: `apg_backend_healthy` (only for services with a health check) and `apg_backend_circuit_open`.

**A backend on the same machine as a node in a container.** Inside a container, `localhost` and `127.0.0.1` are the container itself, so a backend given as `127.0.0.1:18080` fails with `connection refused` even though that port answers on the machine. Use the name the backend has on the container network (`echo:8080` in the Compose files here), or `host.docker.internal:18080` for something listening on the machine itself. The Compose files map that name for the node.

## Why did this request go there?

The route tester: the console's **Routes** page, `apgctl route match --host … --path …`, or `GET /debug/match` on a node's management port. It names the route that would be chosen and, for every other candidate, why it was not.

## Who changed what?

Every change through the Admin API, and every refused attempt, is in the audit log with the actor, the request id, the source address, and the resource before and after (secrets masked). Console: **Audit log**. API: `GET /v1/audit?workspace=…&actor=…&kind=…&from=…&to=…`. Entries are kept for 400 days by default (`APG_AUDIT_RETENTION_DAYS`).

## Usage

Requests, bytes, status classes and latency per workspace, service, route and consumer, by minute, hour and day. Console: **Usage**. See [usage for billing](usage-billing.md).

## Logs of the processes themselves

Both processes log JSON to standard output (`APG_LOG_FORMAT=text` for people). `APG_LOG_LEVEL` is `info` by default. Secrets are never logged; `make e2e-security` checks that against every container's output.
