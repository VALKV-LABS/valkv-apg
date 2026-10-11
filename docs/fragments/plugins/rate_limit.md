## When to use it

To cap how fast something may call a route: a consumer, a client address, a tenant, or everyone together. It is a token bucket: `per_second` refills it and `burst` is its size, so short spikes pass and a sustained flood does not.

Limits are counted on each node. With three nodes behind a load balancer, a caller spread evenly can reach about three times the configured rate. Size the limit with that in mind.

## Examples

Fifty requests a second for each API key, with room for bursts of a hundred:

```yaml
version: 1
services:
  - name: orders
    backends:
      - target: "10.0.0.21:8080"
routes:
  - name: orders-api
    service: orders
    paths: [/orders]
    plugins:
      - type: key_auth
      - type: rate_limit
        config:
          per_second: 50
          burst: 100
          scope: consumer
```

A slow, expensive endpoint: six a minute per client address, and a more generous allowance for one named consumer:

```yaml
version: 1
services:
  - name: reports
    backends:
      - target: "10.0.0.22:8080"
routes:
  - name: export
    service: reports
    paths: [/export]
    plugins:
      - type: key_auth
        config: { anonymous: guest }
      - type: rate_limit
        config:
          per_second: 0.1
          burst: 3
          scope: ip
      - type: rate_limit
        consumer: batch-job
        config:
          per_second: 5
          burst: 20
          scope: consumer
consumers:
  - name: guest
  - name: batch-job
```

## What clients see

`429 RATE_LIMITED` with `Retry-After`.

## Choosing a scope

| `scope` | One bucket per |
|---|---|
| `consumer` | authenticated consumer |
| `ip` | client address |
| `workspace` | workspace |
| `route` | route |
| `global` | node |
| `header:<name>` | value of a request header |

## Goes well with

`quota` for a total per day or month on top of a rate; metric `apg_limited_total{type="rate_limit"}` to see how often it bites.
