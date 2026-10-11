# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
- Browser sessions for the console: `POST /v1/session` exchanges an admin token for an
  HttpOnly cookie and a CSRF token.
- Route tester: nodes answer `GET /debug/match` on the management listener with the
  route a request would hit and why the others were not chosen; `GET /v1/debug/match`
  and `apgctl route match` ask a node (`APG_DEBUG_NODE_URL`).
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
