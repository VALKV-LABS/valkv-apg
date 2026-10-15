# Summary

[What valkv-apg is](index.md)
[Product guide](product-guide.md)
[Architecture and components](architecture.md)

# Getting started

- [A gateway from one file, in five minutes](getting-started/standalone.md)
- [With a control plane and the console](getting-started/control-plane.md)
- [A first route with a key and a rate limit](getting-started/first-route.md)

# Concepts

- [Architecture and the two modes](concepts/architecture.md)
- [Resources](concepts/resources.md)
- [Workspaces and who owns a host](concepts/workspaces.md)
- [How configuration reaches nodes](concepts/config-propagation.md)
- [What happens to a request](concepts/request-lifecycle.md)
- [Plugin scopes and order](concepts/plugins.md)

# Guides

- [TLS and your own domains](guides/tls.md)
- [Authentication](guides/authentication.md)
- [Rate limits, quotas and bandwidth](guides/limits.md)
- [Many tenants on one gateway](guides/multi-tenant.md)
- [Traffic splitting and canaries](guides/traffic-splitting.md)
- [Observability](guides/observability.md)
- [GitOps with apgctl](guides/gitops.md)
- [Single sign-on for the console](guides/single-sign-on.md)
- [Writing a callout service](guides/callout-plugin.md)
- [Embedding the console](guides/embedding-ui.md)
- [Usage for billing](guides/usage-billing.md)
- [Coming from another gateway](guides/coming-from-other-gateways.md)

# Reference

- [The configuration file](reference/configuration-file.md)
- [Plugins](reference/plugins/index.md)
  - [ip_restriction](reference/plugins/ip_restriction.md)
  - [cors](reference/plugins/cors.md)
  - [request_size_limit](reference/plugins/request_size_limit.md)
  - [mtls_auth](reference/plugins/mtls_auth.md)
  - [jwt_auth](reference/plugins/jwt_auth.md)
  - [key_auth](reference/plugins/key_auth.md)
  - [basic_auth](reference/plugins/basic_auth.md)
  - [forward_auth](reference/plugins/forward_auth.md)
  - [acl](reference/plugins/acl.md)
  - [rate_limit](reference/plugins/rate_limit.md)
  - [quota](reference/plugins/quota.md)
  - [bandwidth_limit](reference/plugins/bandwidth_limit.md)
  - [concurrency_limit](reference/plugins/concurrency_limit.md)
  - [http_callout](reference/plugins/http_callout.md)
  - [redirect](reference/plugins/redirect.md)
  - [static_response](reference/plugins/static_response.md)
  - [request_transformer](reference/plugins/request_transformer.md)
  - [response_cache](reference/plugins/response_cache.md)
  - [response_transformer](reference/plugins/response_transformer.md)
  - [compression](reference/plugins/compression.md)
  - [access_log](reference/plugins/access_log.md)
- [Template variables](reference/templates.md)
- [Admin API](reference/admin-api.md)
- [apgctl](reference/cli.md)
- [Environment variables](reference/environment.md)
- [Metrics](reference/metrics.md)
- [Error codes](reference/error-codes.md)
- [The change feed nodes read](reference/change-feed.md)

# Operations

- [Deploying](ops/deploy.md)
- [Rolling out a new version, and rolling it back](ops/rollout.md)
- [Backup and restore](ops/backup.md)
- [Capacity planning](ops/capacity.md)
- [Security hardening](ops/hardening.md)
- [Threat model](ops/threat-model.md)
- [Runbooks](ops/runbooks.md)

# Contributing

- [Development environment](contributing/development.md)
- [Architecture for contributors](contributing/architecture.md)
- [Adding a plugin type](contributing/adding-a-plugin.md)
- [Releasing](contributing/releasing.md)
