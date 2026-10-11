# Architecture and the two modes

## Two processes

**The gateway**, also called a *node*, is the only thing clients talk to. It terminates TLS, matches each request to a route, runs the plugins that apply, and forwards to an upstream. It is one binary, written in Rust.

**The control plane**, also called the *admin*, is where configuration is managed. It serves the Admin API, the console, and a feed of changes that nodes read. It keeps everything in Postgres. Nodes never talk to Postgres.

```
                         ┌──────────── control plane ────────────┐
 console, apgctl, CI ───▶│ Admin API   console   change feed     │──▶ Postgres
                         └───────────────────▲───────────────────┘
                                             │ nodes ask for changes
        ┌────────────────────────────────────┴───────────┐
clients │  node            node            node           │ your services
 ──────▶│  (cache on disk) (cache on disk) (cache on disk)│──────▶
        └─────────────────────────────────────────────────┘
```

## Two modes

A node gets its configuration from exactly one place, chosen by `APG_CONFIG_SOURCE`.

| | `file` (standalone) | `api_poll` (with a control plane) |
|---|---|---|
| Configuration lives in | one YAML file, or a directory of them | Postgres |
| You change it by | editing the file | the Admin API, the console, `apgctl` |
| A change takes effect | when the file is saved | on every node, typically within a second |
| Needs | nothing else | the control plane and Postgres |
| Certificates from an ACME authority | kept in the node's data directory | issued by one node, shared with all |
| Usage metering | written to a file, or discarded | reported to the control plane |
| Good for | one gateway, edge boxes, development, CI | fleets, many tenants, teams |

The configuration format is the same in both. A document that works as a file can be applied to a control plane with `apgctl apply`, and `apgctl dump` gives it back.

## What keeps working when something is down

The design goal is that serving traffic depends on as little as possible.

| What is down | Traffic through existing configuration | What stops |
|---|---|---|
| The control plane | Unaffected. Nodes serve from memory, and from their disk cache after a restart | Configuration changes; new certificates; usage is queued on the node for up to 24 hours |
| Postgres | Unaffected | The same, and the Admin API answers 503 on `/readyz` |
| One node | Other nodes are unaffected | Nothing else |
| An upstream | Other upstreams are unaffected; a failing backend is taken out of rotation | Requests to that service get `502` or `503` |

A node reports itself *ready* once it holds a complete configuration, whether it came from the control plane or from its cache. It reports itself *stale* when it has not heard from the control plane for a while, and keeps serving.

## Inside a node

- **A snapshot** is an immutable, indexed view of the whole configuration. Every request is matched against one snapshot from start to finish.
- **Applying a change** builds a new snapshot beside the current one and swaps it in. No request waits for a configuration change, and no change is half visible.
- **Upstream state** (health, circuit breakers, connection pools) lives outside the snapshot and survives configuration changes.

## Inside the control plane

- **One transaction per change** writes the resource, an entry in the change feed for nodes, and an entry in the audit log. There is no way to write one without the others.
- **It is stateless.** Run several copies behind a load balancer; background jobs take a lock so only one copy runs each.
- **Secrets** (private keys, plugin secrets) are encrypted before they are stored and stay encrypted in the change feed. API keys and tokens are stored as hashes.

## Ports

| Process | Port | For |
|---|---|---|
| Node | 8443 | Client traffic, TLS |
| Node | 8080 | Client traffic in clear, or a redirect to HTTPS; ACME challenges |
| Node | 9100 | Health, readiness, metrics, the route tester. Never exposed to clients |
| Admin | 9000 | Admin API, console, and the change feed |

See [how configuration reaches nodes](config-propagation.md) for the feed itself, and [deploying](../ops/deploy.md) for how to run all this.
