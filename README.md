# valkv-apg

Open-source API gateway for multi-tenant platforms. Runs from a single YAML
file or a Postgres-backed control plane, with per-tenant routing, limits, usage
metering and automatic TLS. Built in Rust on [Pingora](https://github.com/cloudflare/pingora).

> **Status: early build, not released.** The table below says what works today.
> Do not run this in production yet.

## Why another gateway

- **Runs alone.** One binary and one YAML file are a complete gateway. No database.
- **Postgres is the only control-plane dependency** when you want an Admin API.
- **Bring your own control plane.** A node can poll any HTTP endpoint that serves the config contract (`GET /changes`, `GET /snapshot`).
- **Serving never depends on the control plane.** Nodes keep their last configuration on disk and keep serving when the control plane is down.
- **Multi-tenant by construction.** Workspaces own hostnames, routes, consumers and usage. A tenant can only route hosts it owns.
- **Everything accepted is enforced.** A configuration key the gateway cannot enforce is a validation error, never silently ignored.

## What works today

| Area | State |
|---|---|
| Standalone mode (`apg.yaml`), hot reload, `valkv-apg validate` | Working, tested end to end |
| Control plane: Admin API, roles, delegated JWT, audit, OpenAPI | Working, tested against Postgres |
| Nodes polling the control plane, local cache, resync | Working, tested end to end including control-plane outages |
| Routing: hosts, paths (prefix, exact, regex), methods, headers, query, priorities, rewrites, traffic split by weight | Working |
| Workspaces, host ownership, base domains | Working |
| Plugins, 20 types: authentication (`key_auth`, `basic_auth`, `jwt_auth`, `mtls_auth`, `forward_auth`), `acl`, `ip_restriction`, `cors`, `request_size_limit`, `rate_limit`, `quota`, `bandwidth_limit`, `redirect`, `static_response`, request and response transformers, `response_cache`, `compression`, `http_callout`, `access_log` | Working, tested end to end |
| Consumers and credentials (API keys, passwords, client certificates), stored and distributed as hashes | Working |
| TLS with configured certificates, HTTP/2, HTTP to HTTPS redirect | Working |
| Upstreams: weighted round robin, random, least connections and consistent hashing; active health checks and a circuit breaker; timeouts, route deadlines and retries; upstream TLS with private CAs; HTTP/2 upstreams; sticky traffic splits | Working, tested end to end |
| Certificates from an ACME authority (HTTP-01, and DNS-01 through a webhook), issued by one node and served by all; renewal; private keys encrypted at rest and in transit between control plane and nodes | Working, tested end to end against a test authority |
| Usage metering by workspace, service, route and consumer, with hourly and daily rollups and a usage API | Working, tested end to end |
| Observability: Prometheus metrics by route and service, JSON access log, trace-context propagation, a Grafana dashboard and alert rules | Working |
| DNS-01 through Cloudflare or Route 53 directly, WebAssembly plugins, a shared (Redis) store for limits, exporting trace spans, a usage webhook, UI, CLI, Helm chart | Not built yet |

## Try it

You need Docker.

```sh
docker compose -f deploy/compose/standalone.yml up --build
curl -k https://localhost:8443/hello          # answered by the sample upstream, through the gateway
```

The configuration is [`deploy/compose/standalone/apg.yaml`](deploy/compose/standalone/apg.yaml):

```yaml
version: 1
services:
  - name: echo
    backends:
      - target: "echo:8080"
routes:
  - name: everything
    service: echo
    paths: [/]
```

Edit the file and the node reloads it. An invalid file is rejected whole and
the node keeps serving the previous one. Check a file without starting anything:

```sh
docker run --rm -v "$PWD/deploy/compose/standalone:/cfg:ro" valkv-labs/valkv-apg:dev validate --config /cfg/apg.yaml
```

## Layout

| Path | What |
|---|---|
| `crates/apg-core` | Decisions with no I/O: resource model, route matcher, config loader |
| `crates/apg-proxy` | The node (`valkv-apg` binary) |
| `crates/apg-plugin-sdk` | Plugin phases and ordering |
| `admin/` | Control plane (TypeScript): Admin API and the config API nodes poll |
| `schemas/` | JSON Schemas: the single source of truth for resources, `apg.yaml` and the change event |
| `tests/` | Shared fixtures, end-to-end suites, benchmarks |
| `deploy/compose/` | `standalone.yml` (file mode) and `database.yml` (control plane, Postgres, two nodes) |

## Development

Everything runs in Docker; you need Docker and `make`, nothing else.

```sh
make unit             # Rust and TypeScript unit tests, shared fixtures
make up               # control plane, Postgres, two nodes, sample upstream
make integ            # admin integration tests, then end-to-end suites
make e2e MODE=file    # the routing and upstream suites against a standalone node
make e2e-resilience   # control plane down, restart from cache, resync
make down
make lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
