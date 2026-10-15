# Coming from another gateway

A map of terms, then an honest list of what valkv-apg has, what it lacks, and which of the gaps matter.

## The same ideas under other names

| valkv-apg | Kong | Apache APISIX | Envoy-based gateways | NGINX | AWS API Gateway |
|---|---|---|---|---|---|
| Route | Route | Route | Route, in a route configuration | `location` in a `server` | Resource and method |
| Service | Service with its Upstream | Upstream | Cluster | `upstream` | Integration |
| Backend | Target | Node | Endpoint | `server` in an `upstream` | Integration endpoint |
| Consumer | Consumer | Consumer | (none built in) | (none built in) | API key holder |
| Credential | Credential of a consumer | Consumer plugin config | (none built in) | (none built in) | API key |
| Plugin | Plugin | Plugin | HTTP filter | Module or directive | Authorizer, usage plan, mapping template |
| Workspace | Workspace | (none built in) | (none built in) | (none built in) | Account or stage |
| Domain | SNI with a certificate | SSL object | Filter chain match | `server_name` | Custom domain name |
| `apg.yaml` and `apgctl` | Declarative config and decK | Standalone YAML and ADC | xDS resources | `nginx.conf` | Infrastructure-as-code templates |
| Node / control plane | Data plane / control plane | Gateway / control plane with its store | Proxy / xDS server | Instance | Managed |

Things that work differently here:

- **A route names its service; plugins hang off either.** There is no separate "upstream" object: backends, balancing and health checks are part of the service.
- **Plugin order is by type, not by where you wrote it.** See [plugin scopes and order](../concepts/plugins.md).
- **Host ownership is enforced.** A tenant's route must use a host its workspace owns. In most gateways that is a convention.
- **A setting the gateway does not act on is an error**, not something silently ignored.
- **Nodes pull.** They ask the control plane for changes and keep a copy on disk. Nothing is pushed, and nodes hold no database connection.

## What is here

| Area | Built and tested |
|---|---|
| Routing | Host (exact and wildcard), path (prefix, exact, pattern), method, header and query conditions, priorities, rewrites, path stripping |
| Upstreams | Weighted round robin, random, least connections, consistent hashing; active health checks; circuit breaker; timeouts and per-route deadlines; retries; upstream TLS with private CAs and client certificates; HTTP/2 upstreams |
| Traffic management | Weighted splits, sticky per consumer, address, header, cookie or query |
| TLS | Uploaded certificates; automatic certificates (ACME HTTP-01, and DNS-01 through a webhook) issued once and shared by all nodes, with renewal; SNI; HTTP/2; client certificates |
| Authentication | API keys, basic, JWT (static keys, JWKS, shared secret), mutual TLS, delegating to your own service; several schemes on one route |
| Authorisation | Groups (allow and deny), networks |
| Traffic control | Rate limit, quota per hour, day or month, bandwidth, request size |
| Transformation | Request and response headers, query, JSON body; redirects; static responses; templates |
| Performance | Response cache with purge; compression |
| Extensibility | Callout to an HTTP service you write, with signed calls |
| Multi-tenancy | Workspaces with host ownership, per-workspace limits, suspension, isolation of credentials, limits and cache; scoped tokens; delegated JWTs |
| Management | Admin API with an OpenAPI description, optimistic concurrency, idempotent writes, dry runs; console; CLI; declarative apply, diff, sync; revisions, drift detection, rollback; audit log |
| Console access | Admin tokens; single sign-on with OpenID Connect, roles from a group claim |
| Observability | Prometheus metrics, JSON access log with sampling and custom fields, request ids, trace-context propagation, a dashboard and alerts |
| Usage | Metering per workspace, service, route and consumer, with hourly and daily totals and an API |
| Operations | Runs from one file with no database; serves through control-plane and database outages; safe upgrades in either order; zero-downtime binary upgrade; Helm chart with a canary track; Terraform reference for AWS; signed images |

## What is not here

Grouped by how much it is likely to matter to an enterprise evaluation.

**Often required.** If one of these is a hard requirement for you, valkv-apg is not ready for you yet.

| Missing | What you can do today |
|---|---|
| Rate limits and quotas counted across nodes (a shared store) | Limits are per node. Divide by the number of nodes, or keep callers on one node at the load balancer |
| Exporting traces (OpenTelemetry) | Trace context is passed on and logged, so your services' traces connect; the gateway emits no spans of its own |
| gRPC and gRPC-Web as first-class protocols, server-sent events verified end to end | Not tested; do not rely on them. WebSocket is tested end to end, with an idle timeout and draining |
| OAuth 2.0 token introspection and the OpenID Connect relying-party flow *for API callers* | `jwt_auth` verifies tokens locally; `forward_auth` can delegate to a service that introspects |
| A stable release, and the record of running in production that comes with one | None yet |

**Common, but with a workable substitute.**

| Missing | Substitute |
|---|---|
| Plugins loaded into the gateway (WebAssembly, Lua, or similar) | `http_callout` to your own service |
| Request and response body rewriting beyond JSON fields; validation against an OpenAPI or JSON Schema | A callout, or your service |
| Shipping access logs to an HTTP endpoint, Kafka or a log service directly | Write to standard output or a file and use your log agent |
| DNS-01 with a DNS provider's API built in | Cloudflare is built in; for any other, the DNS webhook, a few lines of your own |
| A Kubernetes Ingress or Gateway API controller | Deploy with the Helm chart and manage routes through the API or `apgctl` |
| Service discovery (Consul, Kubernetes endpoints, DNS SRV) | Backends by DNS name, re-resolved in the background |
| Pushing usage to a webhook | Pull from the usage API |
| A developer portal, API products and self-service key issuing | The console embedded in your own portal, and the Admin API |
| Secrets from a vault | Environment variables or files on the node; encrypted values through the control plane |
| Mirroring traffic, fault injection, request hedging | None |

**Deliberately out of scope.** A web application firewall, bot detection, GraphQL-aware routing, API monetisation, and a service mesh. Put a dedicated product in front or behind.

## Is OpenID Connect supported?

Two different things go by that name:

- **Signing people in to the console**: yes. See [single sign-on for the console](single-sign-on.md).
- **Authenticating callers of your APIs**: tokens issued by an OpenID Connect provider are verified by [`jwt_auth`](../reference/plugins/jwt_auth.md) against the provider's published keys. The gateway does not itself run the browser redirect flow for an API route, and does not call the provider's introspection or user-info endpoints.

## Moving over

1. Write your routes and services as one `apg.yaml` and check it with `valkv-apg validate`. The [first-route page](../getting-started/first-route.md) and the [plugin reference](../reference/plugins/index.md) cover most of what a typical configuration uses.
2. Run a standalone node beside your current gateway and send it a copy of a few routes' traffic, or a small share at your load balancer.
3. Compare with `tests/smoke.sh`, your own tests, and the access log.
4. Move routes over host by host.
