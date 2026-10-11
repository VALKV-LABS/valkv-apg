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
- Node sources imported from the seed and moved to the `apg` namespace
  (environment variables, metrics, crate and binary names).
