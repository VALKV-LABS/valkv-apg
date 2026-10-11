# valkv-apg

[![ci](https://github.com/VALKV-LABS/valkv-apg/actions/workflows/ci.yml/badge.svg)](https://github.com/VALKV-LABS/valkv-apg/actions/workflows/ci.yml)
[![release](https://github.com/VALKV-LABS/valkv-apg/actions/workflows/release.yml/badge.svg)](https://github.com/VALKV-LABS/valkv-apg/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Docker: gateway](https://img.shields.io/docker/v/valkv-labs/valkv-apg?label=valkv-apg&sort=semver)](https://hub.docker.com/r/valkv-labs/valkv-apg)
[![Docker: control plane](https://img.shields.io/docker/v/valkv-labs/valkv-apg-admin?label=valkv-apg-admin&sort=semver)](https://hub.docker.com/r/valkv-labs/valkv-apg-admin)

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
| Packaging: images for amd64 and arm64, a Helm chart with a canary track, a systemd unit with zero-downtime binary upgrade, a Terraform reference for AWS, signed releases | Working; the chart and the Terraform reference are linted and validated, not applied by CI |
| Configuration as files: `apgctl validate`, `diff`, `apply`, `sync`, `dump`; revisions, drift detection and rollback | Working, tested against a running control plane |
| Admin console at `/ui/`: every resource, a route tester, usage, config review, audit log; light and dark themes; embeddable | Working, tested in a browser with an accessibility scan |
| Single sign-on (OpenID Connect) for the console, DNS-01 through Cloudflare or Route 53 directly, WebAssembly plugins, a shared (Redis) store for limits, exporting trace spans, a usage webhook | Not built yet |

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

## Deploy it

| Where | How |
|---|---|
| Docker Compose | [`deploy/compose/standalone.yml`](deploy/compose/standalone.yml) for one node and a file; [`deploy/compose/database.yml`](deploy/compose/database.yml) for a control plane, Postgres and two nodes |
| Kubernetes | `helm install apg deploy/helm/valkv-apg -f my-values.yaml`. It expects a Postgres you provide. See [`values.yaml`](deploy/helm/valkv-apg/values.yaml) |
| A Linux host | The release tarball holds the binary, [`valkv-apg.service`](deploy/systemd/valkv-apg.service) and its environment file. `systemctl reload valkv-apg` swaps in a new binary without dropping a connection (standalone mode) |
| A cloud trial in one command | [`deploy/lightsail`](deploy/lightsail/README.md): one Amazon Lightsail instance with the gateway, control plane, console and sample upstreams, followed by a smoke test of every feature |
| AWS | [`deploy/terraform/aws`](deploy/terraform/aws/README.md): load balancers, auto-scaling groups, managed Postgres, with a [cost estimate](deploy/terraform/aws/COST.md) |

Upgrade the control plane first, then the nodes. A node keeps serving from its cache while the control plane is away. [Rolling out a new version, and rolling it back](docs/ops/rollout.md) has the stages, the promotion criteria and the exact commands.

### Images

Two images are published for `linux/amd64` and `linux/arm64`:

| Image | What it is | When you need it |
|---|---|---|
| `valkv-labs/valkv-apg` | The gateway (the node) | Always. On its own it is a complete gateway driven by one YAML file |
| `valkv-labs/valkv-apg-admin` | The control plane: Admin API, the console at `/ui/`, and the configuration API nodes poll | When configuration lives in Postgres and is managed through the API, the console or `apgctl` |

They are kept apart on purpose: nodes are many, face the internet and hold no database connection; the control plane is small, private and holds the secrets. A tagged release publishes both, signed, with a bill of materials; each merge to `main` publishes both as `edge`.

## Layout

| Path | What |
|---|---|
| `crates/apg-core` | Decisions with no I/O: resource model, route matcher, config loader |
| `crates/apg-proxy` | The node (`valkv-apg` binary) |
| `crates/apg-plugin-sdk` | Plugin phases and ordering |
| `admin/` | Control plane (TypeScript): Admin API and the config API nodes poll |
| `cli/` | `apgctl`, the command-line client ([README](cli/README.md)) |
| `ui/` | The admin console (React), built into the admin image |
| `schemas/` | JSON Schemas: the single source of truth for resources, `apg.yaml` and the change event |
| `tests/` | Shared fixtures, end-to-end suites, benchmarks |
| `deploy/` | Compose files, the Helm chart, the systemd unit, the Terraform reference, a Grafana dashboard and alert rules |

## Development

Everything runs in Docker; you need Docker and `make`, nothing else.

```sh
make unit             # Rust, admin, CLI and console unit tests, shared fixtures
make up               # control plane, Postgres, two nodes, sample upstream
make integ            # admin, CLI and browser tests, then end-to-end suites
make e2e MODE=file    # the routing and upstream suites against a standalone node
make e2e-resilience   # control plane down, restart from cache, resync
make e2e-upgrade      # a new binary takes over the listeners; no request fails
make e2e-skew         # nodes step over events from a newer control plane
make smoke            # every feature, expected against actual
make canary-rehearsal # promote a healthy canary, roll back a faulty one
make lint-helm lint-terraform
make down
make lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
