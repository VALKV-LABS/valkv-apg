# What happens to a request

From the moment a connection arrives to the line written in the access log.

## 1. Connection and TLS

On the HTTPS port the client says which host it wants (SNI). The node picks the certificate for that host: one you uploaded, one it obtained from an ACME authority, or a fallback. HTTP/2 is offered. If a route on that host uses client certificates, one is asked for.

On the HTTP port the node answers ACME challenges, and then either redirects to HTTPS (the default) or serves the request (`APG_HTTP_MODE=proxy`).

## 2. A request id, and who the client is

Every request gets an id. A well-formed `X-Request-Id` from the client is kept; otherwise one is made. It is sent to the upstream, returned to the client, and written in the access log, so one request can be followed everywhere. W3C trace context (`traceparent`) is passed on, and started if absent.

The client's address is the address the connection came from. If that address is one of your own proxies (`APG_TRUSTED_PROXIES`), it is taken from `X-Forwarded-For` instead.

## 3. Matching a route

The path is normalised first: `.` and `..` segments are resolved, repeated slashes merged. A path that climbs out of the root is refused with `400`.

Then the route is chosen ([workspaces and who owns a host](workspaces.md)): system routes first, then the routes of the workspace that owns the host. Among candidates the order is: higher `priority`; an exact host before a wildcard before none; an exact path before a longer prefix before a shorter one before a pattern; more header and query conditions; a method condition before none.

No match: `404 NO_ROUTE`.

## 4. Plugins, before forwarding

The plugins that apply to the route run in order of priority ([plugin scopes and order](plugins.md)). In the default order:

1. `ip_restriction`, `cors`, `request_size_limit`
2. Authentication: `mtls_auth`, `jwt_auth`, `key_auth`, `basic_auth`, `forward_auth`
3. `acl`
4. Limits: `rate_limit`, `quota`, `bandwidth_limit`
5. `http_callout`
6. `redirect`, `static_response` (these answer without an upstream)
7. `request_transformer`
8. `response_cache` (a stored response is served here)

Any of them can end the request with its own response. If authentication found a consumer, everything after it knows who is calling.

## 5. Choosing a backend

The route names a service, or splits across several by weight. Within the service a backend is chosen by the service's strategy (round robin, random, least connections, or a consistent hash of something in the request), skipping backends that are draining, failing their health check, or cut off by the circuit breaker.

No backend available: `503 NO_HEALTHY_BACKEND`.

## 6. Forwarding

The request is sent with these headers set by the gateway, whatever the client sent under the same names:

| Header | Value |
|---|---|
| `X-Forwarded-For` | The client's address, appended to any chain from a trusted proxy |
| `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port` | How the client reached the gateway |
| `X-Real-Ip` | The client's address |
| `X-Request-Id`, `traceparent` | The request's ids |
| `X-Apg-Workspace` | The workspace the request belongs to |
| `X-Apg-Consumer-Id`, `X-Apg-Consumer-Name`, `X-Apg-Consumer-Custom-Id` | The authenticated consumer, if any |

A client cannot forge the `X-Apg-*` headers: they are removed from what it sent and written by the gateway.

If connecting fails or times out, the request may be retried on another backend, as the service's `retries` allow. A request that is not safe to repeat is never replayed once any of it has been sent.

Upstream failure after retries: `502 UPSTREAM_ERROR` or `504 UPSTREAM_TIMEOUT`.

## 7. The response

On the way back: `response_transformer`, storing in `response_cache`, `compression`, and the CORS headers. The response carries `X-Request-Id`; one produced by the gateway itself (not by your upstream) also carries `X-Apg-Error` with a code from the [list](../reference/error-codes.md).

## 8. Afterwards

- One JSON line in the access log, unless an `access_log` plugin switched it off or sampled it out.
- Counters: `apg_requests_total` by route, service and status class, and a latency histogram.
- Usage: the request is added to the current window for its workspace, service, route and consumer, and reported to the control plane about once a minute.
- The byte count is charged to a `bandwidth_limit` budget, if one applies.

## What can replace the upstream entirely

A `redirect`, a `static_response`, a hit in `response_cache`, an answer from `http_callout` or `forward_auth`, and any refusal. In all of those the upstream is never contacted.
