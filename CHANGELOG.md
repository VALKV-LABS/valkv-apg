# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-10-28

### Added
- TCP routes: a route with `protocol: tcp` is matched by the SNI name of a TLS connection on
  a new TCP listener (`APG_LISTEN_TCP`, off unless set) and forwards the connection as a byte
  stream, so services such as Redis with TLS can be routed per tenant on one port. The node
  terminates TLS with the certificate it holds for the name, or with `tls_passthrough: true`
  forwards the client's TLS untouched. Host ownership, load balancing, connect retries, health
  checks, the circuit breaker, egress restriction, draining and `idle_timeout_ms` apply as for
  HTTP routes; HTTP-only route keys and plugins are refused on a tcp route. Metrics
  `apg_tcp_connections_total`, `apg_tcp_active_connections` and `apg_tcp_bytes_total`.
  Upgrade nodes before creating a tcp route: an older node would treat it as an HTTP route.

## [0.1.1] - 2026-10-14

### Added
- Limits can count per host (`scope: host`) and per leading path segments
  (`scope: path_prefix:<n>`), so each host or each `/db/<name>` under one route has its own
  budget. `path_prefix:<n>` is also a key for `hash_key` and `split_key`.
- `concurrency_limit`: a cap on requests in progress at once, per scope. A request over
  the cap gets `429 CONCURRENCY_LIMITED`; a WebSocket holds its slot until it closes.
- Route `idle_timeout_ms`: an upgraded (WebSocket) connection with no traffic either way
  for this long is closed (five minutes unless set). It was refused before. An upgraded
  connection was closed by the service's `read_ms` until now.
- Service `drain_timeout_ms`: an upgraded connection to a backend that is draining, down
  or removed is closed this long after the change, so its client reconnects to a backend
  that stays. It was refused before. Metrics `apg_upgraded_connections` and
  `apg_drained_connections_total`.

### Changed
- A limit scoped to a header keeps only a hash of the header's value, so a credential used
  as the key is never held in memory as itself.

## [0.1.0] - 2026-10-13

The first release.

### Fixed
- Writing a resource or a flag with what it already holds is no longer a change: the
  revision stays, nodes are sent nothing, and the audit log gets no entry. A caller can
  replay its whole configuration without making every node rebuild its tables.
- A backend name with an address the node cannot reach (an IPv6 address where there is no
  IPv6 route, for instance) no longer fails a share of requests with `502`. An address a
  connection could not be made to is passed over while the name has another, for 30
  seconds at first and longer each time it fails again.
- The node's JSON log no longer carries the source file, line and module path of library
  code in every line.
- A backend that answers on one node is reported healthy even when another node has sent
  it nothing yet.

### Added
- The node logs its state once a minute (`node status`, with `state` `ok`, `stale` or
  `unconverged`), so alarms can be raised from logs where metrics are not scraped.
- DNS challenges through Cloudflare, built in: `APG_ACME_DNS_PROVIDER=cloudflare` with
  `APG_CLOUDFLARE_API_TOKEN`. Wildcard certificates no longer need a webhook service when
  the zone is at Cloudflare.
- Backend health with reasons. A node reports each backend as healthy, failing (with why:
  connection refused, the host name does not resolve, a timeout, a bad status) or not
  checked. `GET /upstreams` on a node's management port; `GET /v1/workspaces/{ws}/health`
  and `.../services/{name}/health` on the Admin API, per backend and per node;
  `apgctl health`; a backend-health card on the console's overview and a per-backend
  view on the Services page.
- `examples/simple.yaml` and `examples/full.yaml` (every plugin type), checked by
  `make docs-check`.
- The console's Nodes page sums up the fleet and opens any node to show what that node
  holds and how it sees each backend. Per-node gauges on the admin's `/metrics`.
- A product guide and an architecture and components page in the documentation.
- Repository foundation: cargo workspace, admin service skeleton, JSON Schemas for
  every resource, `apg.yaml` and the changelog event (contract version 2), shared
  fixtures, Compose stack, Makefile, CI.
- Control plane: Postgres schema and migrations; Admin API for workspaces, domains,
  certificates, services, routes, plugins, consumers and credentials with roles,
  delegated JWT, audit log, optimistic concurrency and idempotent upserts; the
  data-plane config API (changes with long poll, snapshot), heartbeats, certificate
  leases and ACME challenge distribution; background jobs; OpenAPI 3.1 document.
- Node rebuilt on a shared core: contract-2 apply path, indexed route matcher with
  host ownership, path normalisation, plugin resolution, templates, and an `apg.yaml`
  loader validated against the same JSON Schemas as the admin.
- Standalone mode: `APG_CONFIG_SOURCE=file` (the default), hot reload that rejects an
  invalid file whole, and `valkv-apg validate`.
- `api_poll` mode: long-polling the config API, local cache for warm restarts, snapshot
  resync when the position is gone or the control plane changes, heartbeats.
- Forwarded and identity headers, request ids, one error shape with `X-Apg-Error`,
  custom error responses, a real management listener (`/healthz`, `/readyz`,
  `/metrics`, `/status`), HTTP to HTTPS redirect, HTTP/2 over TLS.
- Upstreams: `random`, `least_connections` and `hash` (weighted rendezvous) balancing
  next to weighted round robin; active health checks (HTTP and TCP) and a per-service
  circuit breaker; connect, read and write timeouts; a per-route deadline; retries on
  connection failure and on timeout that go to a different backend and never replay an
  unsafe request; upstream TLS with SNI, private CA bundles and client certificates;
  HTTP/2 to upstreams; idle-connection lifetime; traffic splits that are sticky for a
  key; background resolution of backend host names (`APG_DNS_REFRESH_SECS`).
- A second egress check on the node: a service written by a caller who may not reach
  private addresses is checked again on every connection (`APG_BACKEND_ALLOW_CIDRS`).
- Metrics `apg_backend_healthy`, `apg_backend_circuit_open`, `apg_upstream_retries_total`
  and `apg_dns_failures_total`.
- Packaging: a Helm chart (`deploy/helm/valkv-apg`) with autoscaling, disruption
  budgets, a network policy, a ServiceMonitor and a canary track; a systemd unit; a
  Terraform reference for AWS with a cost estimate; a release workflow that publishes
  signed images for amd64 and arm64 with a bill of materials, binary tarballs and the
  packaged chart.
- Configuration as files: `/v1/config/validate`, `diff`, `apply`, `sync` and `dump`. A
  document lands whole or not at all; resources it does not change are left untouched.
  Each apply is a revision; a workspace changed some other way is reported as drifted;
  a revision can be applied again (rollback). Secrets in stored revisions are encrypted.
- `apgctl`: the command-line client, with offline validation against the same schemas,
  a diff whose exit code tells CI whether anything would change, and named contexts.
- The admin console at `/ui/`: overview, workspaces, domains and certificates, services,
  routes with a route tester, plugins with schema-driven forms, consumers, usage with
  CSV export, nodes, config review and revisions, audit log, settings and tokens. Light
  and dark themes, usable from 360 px, keyboard operable, embeddable in another page.
- Single sign-on for the console with OpenID Connect: `APG_OIDC_ISSUER`, `_CLIENT_ID`,
  `_CLIENT_SECRET`, `_ROLE_CLAIM`, `_ROLE_MAP` and `APG_PUBLIC_URL`. Roles and workspaces
  come from a claim; someone in no mapped group gets no session.
- Browser sessions for the console: `POST /v1/session` exchanges an admin token for an
  HttpOnly cookie and a CSRF token.
- Route tester: nodes answer `GET /debug/match` on the management listener with the
  route a request would hit and why the others were not chosen; `GET /v1/debug/match`
  and `apgctl route match` ask a node (`APG_DEBUG_NODE_URL`).
- Documentation: getting started, concepts, guides, a reference generated from the
  schemas and the code, operations pages with runbooks and a threat model, and a
  comparison with other gateways. `make docs-check` validates every example.
- The node now uses every available core for proxying. It ran on one worker thread
  before, whatever the machine had.
- `jwt_auth.jwks_cache_secs` below 30 is now honoured; it was held back by the limit on
  refreshes that tokens can provoke.
- A smoke test for any deployment (`tests/smoke.sh`): it configures routes of its own,
  sends requests through every class of plugin and prints expected against actual.
- `deploy/canary/check.mjs` decides promote, hold or roll back from the nodes' own
  metrics; `docs/src/ops/rollout.md` is the rollout and rollback runbook for Kubernetes,
  Compose, systemd and the AWS reference.
- `deploy/lightsail`: one command starts a trial on an Amazon Lightsail instance and
  smoke-tests it.
- `valkv-apg --upgrade`: a new process takes over the listening sockets of a running
  standalone node, which then drains and exits. No request is dropped.
- `schemas/unbuilt.yaml`: the keys no node enforces yet. The file loader and the admin
  both refuse them, so nothing is accepted and then ignored.
- Certificates: nodes open keys the control plane sealed (`APG_SECRET_KEY`) and serve
  manually uploaded certificates; domains with `tls.mode: acme` get a certificate from
  an ACME authority without anyone asking, through HTTP-01 or DNS-01 (webhook
  provider), and are renewed 30 days before expiry. With a control plane one node
  issues under a lease, every node answers the challenge, and the certificate is
  distributed to the fleet; in standalone mode the node keeps its certificates in its
  data directory.
- `APG_TLS_MIN_VERSION`, `APG_ACME_EMAIL`, `APG_ACME_DIRECTORY_URL`,
  `APG_ACME_DNS_PROVIDER` and the webhook settings; metrics `apg_certs_expiring`,
  `apg_acme_issuances_total` and `apg_acme_failures_total`.
- Upstream client certificates now work from a control plane as well as from a file.
- Plugins: a runtime that builds each instance once and runs them in priority order,
  and twenty plugin types: `key_auth`, `basic_auth`, `jwt_auth`, `mtls_auth`,
  `forward_auth`, `acl`, `ip_restriction`, `cors`, `request_size_limit`, `rate_limit`,
  `quota`, `bandwidth_limit`, `redirect`, `static_response`, `request_transformer`,
  `response_transformer`, `response_cache`, `compression`, `http_callout` and
  `access_log`. Kill switches per type; per-consumer and per-tenant overrides.
- Consumers and credentials. Nodes hold hashes only; a credential works in its own
  workspace and on operator routes.
- Templates in plugin configuration, checked when written; secret-typed values read
  from the node's environment or a file, or sealed by the control plane.
- The TLS listener asks for a client certificate on names where `mtls_auth` applies.
- Usage metering: requests, statuses, transferred body bytes and latency per workspace,
  service, route and optionally consumer, in clock-aligned windows that survive a
  control-plane outage and a node restart; hourly and daily rollups; `GET /v1/usage`;
  a file sink in standalone mode.
- Observability: request metrics labelled by route and service with a cap on label
  pairs, upstream time and body bytes; a JSON access log with a chosen sink, sampling
  and custom fields, credentials in the query masked; W3C trace context continued and
  sent upstream; backend health in node heartbeats; a Grafana dashboard and Prometheus
  alert rules in `deploy/observability/`.
- Node sources imported from the seed and moved to the `apg` namespace
  (environment variables, metrics, crate and binary names).
