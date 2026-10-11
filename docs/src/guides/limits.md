# Rate limits, quotas and bandwidth

Three plugins, three questions.

| Question | Plugin | Refusal |
|---|---|---|
| How fast may they call? | [`rate_limit`](../reference/plugins/rate_limit.md) | `429 RATE_LIMITED` |
| How many calls this hour, day or month? | [`quota`](../reference/plugins/quota.md) | `429 QUOTA_EXCEEDED` |
| How many bytes a second? | [`bandwidth_limit`](../reference/plugins/bandwidth_limit.md) | `429 BANDWIDTH_LIMIT_EXCEEDED` |

They combine: a plan can be "10 requests a second, 100,000 a month, 5 MB a second".

## Who shares a limit: `scope`

| `scope` | One counter per |
|---|---|
| `consumer` | authenticated consumer |
| `ip` | client address |
| `workspace` | workspace |
| `route` | route |
| `global` | node |
| `header:<name>` | value of a request header |

Counters of different workspaces are always separate, whatever the scope.

Behind a load balancer or CDN, `ip` is the proxy's address unless you list the proxy in `APG_TRUSTED_PROXIES`.

## A plan with tiers

A default for everyone, and more for named consumers. An instance for a consumer overrides the general one of the same type:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.1:8080"
routes:
  - name: api
    service: api
    paths: [/v1]
    plugins:
      - type: key_auth
      - type: rate_limit
        config: { per_second: 5, burst: 20, scope: consumer }
      - type: quota
        config: { limit: 10000, window: month, scope: consumer }
      - type: rate_limit
        consumer: gold-customer
        config: { per_second: 100, burst: 400, scope: consumer }
      - type: quota
        consumer: gold-customer
        config: { limit: 5000000, window: month, scope: consumer }
consumers:
  - name: gold-customer
```

## Protecting the gateway itself

A limit at workspace or global scope, by client address, before anything expensive:

```yaml
version: 1
services:
  - name: site
    backends:
      - target: "10.0.0.2:8080"
routes:
  - name: site
    service: site
    paths: [/]
plugins:
  - type: rate_limit
    scope: workspace
    config: { per_second: 20, burst: 100, scope: ip }
  - type: request_size_limit
    scope: workspace
    config: { max_bytes: 1048576 }
```

## Limits are counted per node

Each node keeps its own counters in memory. A caller whose requests are spread over three nodes can reach about three times a configured rate, and each node starts a quota afresh when it restarts.

In practice: divide a rate by the number of nodes if the total matters, or route by consumer at your load balancer. A shared store that makes limits exact across nodes is not built yet; the `store` setting exists in the schema and anything but `local` is refused.

For billing, do not use `quota` as the record. Use [usage](usage-billing.md), which is reported by every node and added up.

## Memory

Counters are kept only while they are in use; idle ones are dropped. A scope with very many values (`ip` on a public site) is safe.

## Seeing limits at work

`apg_limited_total{type}` counts refusals by plugin type. In the access log, a refused request has `error_code` set.
