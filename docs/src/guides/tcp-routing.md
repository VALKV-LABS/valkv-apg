# TCP routing by SNI (Redis and friends)

Some protocols are not HTTP but do speak TLS from the first byte: Redis with TLS
(`rediss://`), MQTT over TLS, AMQPS, LDAPS, and any service you wrap in TLS
yourself. The gateway can route these by the name the client asks for in its
TLS handshake (SNI), so many tenants' databases can share one public port:

```
rediss://cache.acme.redis.example.com:6380   ->  acme's Redis
rediss://cache.globex.redis.example.com:6380 ->  globex's Redis
```

## Turning on the listener

The TCP listener is off unless you give it an address:

```sh
APG_LISTEN_TCP=0.0.0.0:6380
```

It is separate from the HTTPS listener. Routes with `protocol: tcp` are matched
here and nowhere else; ordinary routes are never matched here.

## A route

```yaml
version: 1
services:
  - name: acme-redis
    backends:
      - target: "redis-acme.internal:6379"
routes:
  - name: acme-redis
    protocol: tcp
    hosts: ["cache.acme.redis.example.com"]
    service: acme-redis
```

`hosts` are SNI names, matched exactly like HTTP hosts: an exact name, or a
wildcard `*.redis.example.com` that covers one label. A tcp route must list at
least one. When several routes list the same name, `priority` decides, then an
exact name beats a wildcard; system routes come before workspace routes; and a
workspace can only list names it owns. All of this is the same as for HTTP
routes; see [workspaces and who owns a host](../concepts/workspaces.md).

A client that sends no SNI name, or a name no route lists, is disconnected.

## Who handles TLS

By default the gateway **terminates** TLS. It presents the certificate it holds
for the SNI name (configured, or issued through ACME, exactly as for HTTPS; see
[TLS and your own domains](tls.md)) and forwards the decrypted bytes. The backend
then speaks plain Redis, and needs no certificate of its own. With
`scheme: https` on the service, the gateway opens TLS to the backend too, with
the service's `tls` settings (verification, SNI, private CAs, a client
certificate).

With `tls_passthrough: true` the gateway **does not decrypt anything**. It reads
the SNI name from the ClientHello without consuming it and forwards every byte,
handshake included. The backend must terminate TLS with a certificate for the
name the client used:

```yaml
version: 1
services:
  - name: redis-tls
    backends:
      - target: "redis-tls.internal:6380"
routes:
  - name: redis-passthrough
    protocol: tcp
    tls_passthrough: true
    hosts: ["*.redis.example.com"]
    service: redis-tls
```

Use passthrough when the backend must see the client's own certificate, or when
the gateway must not hold the traffic in clear.

## What carries over from HTTP routes, and what does not

Carries over: `service` or a weighted `split`, `priority`, `enabled`, and
`idle_timeout_ms` (a connection with no traffic either way for this long is
closed; five minutes unless set). On the service: load balancing (`hash` uses
the client address), connect timeouts, retries on `connect_failure` to another
backend, active health checks (use `type: tcp`), the circuit breaker, egress
restriction, and draining: a connection to a backend that is drained or removed
is closed after the service's `drain_timeout_ms`, so the client reconnects
elsewhere.

Does not apply, and is refused rather than ignored: `paths`, `methods`,
`headers`, `query`, `strip_path`, `rewrite`, `split_key`, `timeout_ms`,
`error_responses`, and plugins. The gateway sees bytes, not requests, so there
is nothing for a plugin to act on. A plugin scoped to a tcp route is refused; a
global or service plugin applies to that service's HTTP routes only.

Connections on the TCP listener are not counted in usage records yet.

## Seeing it work

```sh
redis-cli --tls --sni cache.acme.redis.example.com -h gateway.example.com -p 6380 PING
```

Metrics: `apg_tcp_connections_total` by route, service and outcome (`proxied`,
`no_route`, `no_sni`, `not_tls`, `handshake_failed`, `upstream_failed`, …),
`apg_tcp_active_connections`, and `apg_tcp_bytes_total` by direction. See
[metrics](../reference/metrics.md).

## Upgrading

Upgrade every node before you create a tcp route. A node from before tcp routes
ignores `protocol` and would treat the route as an HTTP route for its hosts.
