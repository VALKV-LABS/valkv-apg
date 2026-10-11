# Product guide

Everything valkv-apg does, in one place and in plain terms. Read it top to bottom to learn the product, or jump to a section. Each section ends with a link to the page that has the detail; the [reference](reference/configuration-file.md) has every key and its default.

For how the parts fit together, see [architecture and components](architecture.md).

## What it is

valkv-apg is an API gateway. Clients connect to it instead of to your services. For each request it:

1. terminates TLS, choosing the certificate by the host name the client asked for;
2. finds the *route* that matches the host, path, method, headers and query;
3. runs the *plugins* that apply: authentication, limits, transformations, caching;
4. forwards the request to a healthy *backend* of the route's *service*, retrying if that is safe;
5. records what happened: metrics, an access log line, and usage counters.

It is built for a platform that serves many customers through one set of gateways, and it asks nothing extra of you when you have one.

## Two ways to run it

| | Standalone | With a control plane |
|---|---|---|
| What runs | The gateway and one YAML file | Gateways, the control plane, Postgres |
| How you change configuration | Edit the file; the gateway reloads it | The Admin API, the console, or `apgctl` |
| Suits | One gateway, an edge box, development, CI | A fleet, several teams, many tenants |

The configuration means the same thing in both. A file that works standalone can be applied to a control plane, and a control plane's configuration can be exported as a file.

In both modes a gateway keeps serving when the thing it gets configuration from is unavailable. With a control plane, gateways keep their last configuration on disk, so they also come back from a restart while the control plane or Postgres is down. What stops during such an outage is changing configuration, issuing new certificates, and delivering usage counters, which wait on each gateway for up to 24 hours.

More: [architecture and the two modes](concepts/architecture.md), [five-minute start](getting-started/standalone.md), [with a control plane](getting-started/control-plane.md).

## The things you configure

| Thing | What it is |
|---|---|
| **Workspace** | A tenant. It owns everything below. There is always one called `default`, and you can ignore workspaces until you need a second. |
| **Domain** | A host name a workspace owns, and how it gets its certificate. |
| **Service** | One upstream application: its backends, and how to balance, check, time out and retry. |
| **Route** | Which requests go to which service. |
| **Plugin** | Something done to requests or responses, attached to everything, a workspace, a service or a route. |
| **Consumer** | An identified caller, with its credentials: API keys, passwords, client certificates. |
| **Certificate** | A certificate and key you supply, or one the gateway obtained. |

Every one of them has a name, optional labels for selecting groups of them, and a free-form `metadata` object the gateway stores and never reads, where a platform built on the gateway can keep its own data.

A small complete configuration:

```yaml
version: 1
services:
  - name: orders
    backends:
      - target: "10.0.0.1:8080"
      - target: "10.0.0.2:8080"
    health_check:
      active: { path: /healthz }
routes:
  - name: orders-api
    service: orders
    paths: [/orders]
    plugins:
      - type: key_auth
      - type: rate_limit
        config: { per_second: 50, burst: 100, scope: consumer }
consumers:
  - name: mobile-app
    credentials:
      - name: main
        type: key
        key: { $env: APG_SECRET_MOBILE_KEY }
```

**Nothing is accepted and then ignored.** An unknown key, a wrong type, or a setting this version does not act on is refused when you write it, with a pointer to the exact place. You never run with a setting that silently does nothing.

More: [resources](concepts/resources.md), [the configuration file](reference/configuration-file.md).

## Routing

A route matches on any combination of:

- **hosts**, exact or a one-level wildcard such as `*.example.com`;
- **paths**, by prefix (on whole segments: `/v1/stores` matches `/v1/stores/a`, not `/v1/storesx`), exactly, or by regular expression;
- **methods**;
- **headers** and **query parameters**, by exact value, by regular expression, or by presence.

When several routes match, the most specific wins, by a fixed order: higher `priority` first, then an exact host over a wildcard, then a longer or more exact path, then more header and query conditions. The order is total, so the same request always reaches the same route. How long matching takes does not grow with the number of routes.

On the way to the upstream a route can strip the matched prefix, rewrite the path, or set a deadline for the whole request including retries.

A route can also **split traffic** between services by weight, which is how you run a canary: 95 to the current version, 5 to the new one. Give it a key such as the consumer or a header, and each caller stays on one side.

The **route tester** answers "which route would this request hit, and why not the others". It asks a running gateway, so the answer is the real one. It is in the console, in `apgctl route match`, and in the Admin API.

More: [what happens to a request](concepts/request-lifecycle.md), [traffic splitting and canaries](guides/traffic-splitting.md).

## Upstreams

A service lists its backends as `host:port`, where the host is an address or a DNS name the gateway resolves and keeps resolving.

**Load balancing.** Weighted round robin (the default), weighted random, least connections, or a consistent hash of something in the request (client address, a header, a cookie, the consumer), which keeps one caller on one backend and moves only a small share of callers when a backend is added or removed.

**Health.** Two mechanisms, and they work together:

- An *active health check* has every gateway probe every backend on a schedule, over HTTP or by opening a connection. A backend that fails several times in a row is taken out of rotation until it passes again.
- The *circuit breaker* watches real traffic. A backend that fails several requests in a row is skipped for a while, then tried with a single request.

If every backend of a service looks bad, the gateway sends traffic anyway, because a backend that might have recovered is better than a certain error.

**Seeing health.** The console's overview lists every failing backend with the reason, and the Services page shows each backend as each gateway sees it. A backend is reported in one of three states: *healthy* (it answered), *failing* (with why: connection refused, the host name does not resolve, a timeout, a bad status), or *not checked* (nothing has been sent to it yet). The gateway never calls a backend healthy before it has heard from it. See [observability](guides/observability.md#is-a-backend-up).

**Timeouts and retries.** Separate limits for connecting, reading and writing; a per-route deadline over everything. A retry goes to a different backend, and happens only when it cannot cause a request to be carried out twice, unless you say otherwise.

**Draining.** Mark a backend `draining` and it gets no new requests while the ones in flight finish.

**TLS to the upstream.** Verified by default, against the system's authorities or ones you supply, with an optional client certificate. HTTP/2 to the upstream, which gRPC needs, is one setting.

WebSocket, gRPC and server-sent events pass through without buffering.

More: [resources](concepts/resources.md), [the configuration file](reference/configuration-file.md).

## TLS and certificates

The gateway picks a certificate by the host name in the TLS handshake. Certificates come from three places:

- **You supply them**, in the file or through the API. The private key is never returned by any API.
- **An ACME authority** such as Let's Encrypt issues them. Declare a domain, and the gateway obtains its certificate and renews it 30 days before it expires, with the old one serving until the new one is installed. Challenges are answered over HTTP, or through DNS by calling a webhook you provide, which is what wildcard names need.
- **A fallback**, yours or one the gateway generates, for names it has no certificate for.

In a fleet one gateway does the issuing and every gateway serves the result. The others can answer the authority's challenge too, so issuance works behind a load balancer.

Certificates are only ever issued for domains you declared, never for whatever name a client asks for.

TLS 1.2 is the minimum and 1.3 is preferred; you can require 1.3.

More: [TLS and your own domains](guides/tls.md).

## Authentication

Authentication is done by plugins, and you can combine them.

| Plugin | Checks |
|---|---|
| `key_auth` | An API key in a header or query parameter |
| `basic_auth` | A user name and password |
| `jwt_auth` | A signed token from your identity provider: signature, expiry, issuer, audience. Keys are fetched from the provider and refreshed. |
| `mtls_auth` | A client certificate, against authorities you list |
| `forward_auth` | Whatever your own service decides: the gateway asks it about each request |
| `acl` | That the authenticated consumer is in an allowed group |

Each successful check identifies a **consumer**. From then on the consumer can be the key for limits, usage, load balancing and logging, and its identity is passed to your service in headers the client cannot forge.

Marking a plugin `anonymous` lets requests without that kind of credential through as a named consumer. That is how "an API key or a token" and "signed in or public, with a tighter limit" are expressed.

API keys and passwords are stored and sent to gateways as hashes. A generated key is shown once.

More: [authentication](guides/authentication.md).

## Limits

| Plugin | Limits |
|---|---|
| `rate_limit` | Requests per second, with a burst |
| `quota` | Requests per hour, day or month |
| `bandwidth_limit` | Bytes per second |
| `request_size_limit` | The size of a request body |
| `ip_restriction` | Which client addresses may call |

Each can count per consumer, per client address, per workspace, per route, per the value of a header, or globally. A refused request gets `429` with headers that say when to try again.

Limits are counted on each gateway separately. With three gateways behind a load balancer, a limit of 100 a second allows about 300 in total. Size limits with that in mind.

More: [rate limits, quotas and bandwidth](guides/limits.md).

## Changing requests and responses

| Plugin | Does |
|---|---|
| `request_transformer`, `response_transformer` | Set, add, remove and rename headers and query parameters; set and remove fields of a JSON body |
| `redirect` | Answers with a redirect |
| `static_response` | Answers without an upstream: maintenance pages, mocks |
| `cors` | Answers browser preflight requests and adds the right headers |
| `compression` | Compresses responses the client can accept compressed |
| `response_cache` | Keeps responses in memory and serves them again, per gateway |
| `http_callout` | Asks a service of yours what to do with each request. Custom logic in any language, without building the gateway |

Values can be templates, such as `{{ consumer.name }}` or `{{ request.header.x-tenant }}`. Error responses the gateway produces can be replaced with your own, per error and per route.

More: [the plugin reference](reference/plugins/index.md), [template variables](reference/templates.md), [writing a callout service](guides/callout-plugin.md).

## How plugins combine

A plugin is attached at a scope: everything, one workspace, one service, or one route, and optionally for one consumer only. For each kind of plugin the most specific one wins. Attach `rate_limit` globally as a default, and a route's own `rate_limit` replaces it for that route; disable it on a route, and that route has none.

Plugins run in a fixed order that makes sense: address restrictions, then authentication, then limits, then transformations. The console and the API can show, for any route, exactly which plugins apply and where each came from.

Every kind of plugin has a switch that turns it off across the whole fleet within seconds, without a deploy.

More: [plugin scopes and order](concepts/plugins.md).

## Many tenants

A workspace is a tenant. It owns its domains, services, routes, plugins and consumers.

- **A workspace can only route hosts it owns.** That is what stops one tenant taking another's traffic.
- **A workspace's API keys work only on its own routes.**
- **Someone scoped to a workspace sees nothing of the others**, not even whether a name exists.
- **Each workspace can get a host for free**: declare a base domain, and every workspace owns `its-name.base-domain` under one wildcard certificate.
- **A workspace can be capped** (how many routes, services, domains, consumers) and **suspended**.
- **Tenants cannot point the gateway at your internal network.** Backends and callout addresses written by someone who is not an administrator must be public addresses, unless you allow a range. The check is made when the configuration is written and again on every connection.

The `default` workspace is the operator's. Its routes are tried first and may match any host, so a tenant can never shadow one.

To let customers manage their own routes with tokens your platform already issues, configure the control plane to accept those tokens; each one is confined to the workspace named in it.

More: [workspaces and who owns a host](concepts/workspaces.md), [many tenants on one gateway](guides/multi-tenant.md).

## Managing it

**The Admin API** does everything; the console and the command-line client are built on it and have no private access. It supports safe retries, concurrent edits that do not overwrite each other, and a dry run for any change. Its description in OpenAPI form is served by the control plane.

**The console** covers every resource, with forms generated from the same definitions the server validates against, the route tester, usage charts, backend health, a review-then-apply editor for configuration documents, revision history and the audit log. It has light and dark themes and can be embedded in another product's pages.

**`apgctl`** treats configuration as files. `diff` shows what would change, `apply` makes the changes, `sync` also removes what the files no longer mention, `dump` exports. A change is applied whole or not at all. Every applied document is kept as a revision you can return to, and the control plane can tell you whether someone has changed things by hand since.

**Access.** Tokens have a role (administrator, editor, viewer) and a set of workspaces. The console can sign people in through your identity provider with OpenID Connect, mapping groups to roles. Every change, and every refused attempt, is in the audit log with who, what, and the before and after.

More: [GitOps with apgctl](guides/gitops.md), [single sign-on](guides/single-sign-on.md), [embedding the console](guides/embedding-ui.md), [the Admin API](reference/admin-api.md), [the CLI](reference/cli.md).

## Seeing what it does

- **Metrics** for Prometheus: requests, errors and latency per route and service; backend health; configuration lag; certificate expiry. A Grafana dashboard and alert rules come with it.
- **An access log**, one JSON object per request, to standard output or a file, with sampling and your own fields. Credentials are never written to it.
- **Trace context** is continued or started on every request and passed to your services, and the trace id is in the access log.
- **Backend health** per gateway, with reasons.
- **Fleet state**: each gateway's version, how far behind the latest configuration it is, and when it was last heard from.

More: [observability](guides/observability.md), [metrics](reference/metrics.md).

## Usage, for billing

Every gateway counts requests, bytes in and out, status classes and latency per workspace, service and route, and per consumer if you turn that on. Bytes are what was actually transferred, streams included. The control plane adds the counters up by hour and by day, and a retried report never counts twice. You read them through the usage API or the console and price them however you like; the gateway does no pricing.

More: [usage for billing](guides/usage-billing.md).

## Running it

- **Packaging.** Two container images (the gateway, and the control plane with the console and `apgctl`) for amd64 and arm64; a Helm chart; a systemd unit; Compose files; a Terraform reference for AWS; a one-command trial on a small cloud instance.
- **Upgrades.** Upgrade the control plane, then gateways a few at a time. A gateway one release older or newer than the control plane works. Rolling back is deploying the previous image.
- **Secrets.** Private keys and secret settings are encrypted before they are stored and stay encrypted on the way to gateways. One key, which you hold, opens them, and it can be rotated.
- **Backups.** The Postgres database and that key are everything needed to rebuild.

More: [deploying](ops/deploy.md), [upgrades and rollback](ops/rollout.md), [backup and restore](ops/backup.md), [hardening](ops/hardening.md), [capacity planning](ops/capacity.md), [runbooks](ops/runbooks.md).

## What it does not do

By design:

- It proxies HTTP: HTTP/1.1, HTTP/2, WebSocket, gRPC, server-sent events. It does not proxy raw TCP or UDP, and does not speak HTTP/3.
- It finds backends through DNS only.
- It is not a Kubernetes ingress controller, a developer portal, or a billing system.
- It does not sign your users in to your applications. It verifies tokens your identity provider issued, or asks a service of yours.

Not built yet, and refused with a clear message if configured:

- obtaining certificates through a DNS provider's own API (the DNS webhook works with any provider);
- WebAssembly plugins;
- limits shared between gateways through a common store;
- exporting trace spans;
- pushing usage to a webhook.

The project has not had a stable release. [Capacity planning](ops/capacity.md) says what has been measured and what has not.
