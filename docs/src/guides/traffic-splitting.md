# Traffic splitting and canaries

A route normally sends everything to one service. With `split` it shares traffic between several by weight. That is how you try a new version of *your* service on a little traffic first. (For rolling out a new version of the *gateway*, see [rolling out a new version](../ops/rollout.md).)

## Five per cent to a new version

```yaml
version: 1
services:
  - name: orders-v1
    backends:
      - target: "10.0.0.1:8080"
  - name: orders-v2
    backends:
      - target: "10.0.1.1:8080"
routes:
  - name: orders
    paths: [/orders]
    split:
      - { service: orders-v1, weight: 95 }
      - { service: orders-v2, weight: 5 }
```

Weights are relative: 95 and 5 behave like 19 and 1. A weight of 0 sends nothing.

## Keeping one caller on one side

Without more, each request is placed on its own, so one user would see both versions. `split_key` makes the choice sticky:

```yaml
version: 1
services:
  - name: orders-v1
    backends:
      - target: "10.0.0.1:8080"
  - name: orders-v2
    backends:
      - target: "10.0.1.1:8080"
routes:
  - name: orders
    paths: [/orders]
    split_key: consumer
    split:
      - { service: orders-v1, weight: 95 }
      - { service: orders-v2, weight: 5 }
    plugins:
      - type: key_auth
```

| `split_key` | Sticky per |
|---|---|
| `consumer` | authenticated consumer |
| `client_ip` | client address |
| `header:<name>`, `cookie:<name>`, `query:<name>` | that value |
| `host`, `path`, `workspace` | that part of the request |

When you move the weights from 95/5 to 75/25, only the callers in the share that changed sides move. Nobody already on the new version goes back.

## Comparing the two sides

The service that handled each request is in the access log (`service`) and is a label on `apg_requests_total` and the latency histogram. So the error ratio and latency of `orders-v2` against `orders-v1` can be read directly, in Prometheus or in the console's Usage page grouped by service.

## Promoting, and going back

Move the weights step by step: 5, 25, 50, 100. Each change reaches every node within a second or two.

To go back, set the new side's weight to 0. That is one small change, which is the reason to split at the gateway rather than redeploy.

With files and `apgctl`, each step is a commit, and each apply is a revision you can return to:

```sh
apgctl diff -f gateway/        # /split: [..95.., ..5..] -> [..75.., ..25..]
apgctl apply -f gateway/ -m "orders-v2 to 25 %"
```

## Other ways to route a subset

A split is by share. To send a *chosen* group to another version, use a second route with a condition and a higher priority:

```yaml
version: 1
services:
  - name: orders-v1
    backends:
      - target: "10.0.0.1:8080"
  - name: orders-v2
    backends:
      - target: "10.0.1.1:8080"
routes:
  - name: orders
    service: orders-v1
    paths: [/orders]
  - name: orders-beta
    service: orders-v2
    paths: [/orders]
    priority: 10
    headers:
      - { name: X-Beta, value: "1" }
```

Requests with `X-Beta: 1` go to the new version; everyone else is untouched. The route tester shows which of the two a given request would hit.
