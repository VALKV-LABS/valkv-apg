# Architecture and components

A high-level map of valkv-apg: what the parts are, what each is responsible for, how they talk to each other, and where each lives in the repository. For what the product does, read the [product guide](product-guide.md). For the code in more depth, read [architecture for contributors](contributing/architecture.md).

## The whole picture

```
  people and automation                 control plane (optional)
 ┌──────────────────────┐          ┌──────────────────────────────────┐
 │ console (browser)    │          │ admin                            │
 │ apgctl (terminal, CI)│── /v1 ──▶│   Admin API      background jobs │──▶ Postgres
 │ your own tooling     │          │   serves console                 │
 └──────────────────────┘          │   config API for nodes  (/dp)    │
                                   └───────────────▲──────────────────┘
                                                   │ nodes ask: "what changed?"
                                                   │ nodes report: health, usage
              data plane                           │
        ┌──────────────────────────────────────────┴───────────┐
        │  node                node                node        │
clients │   listeners           ...                 ...        │   your services
 ──────▶│   router                                             │──────▶
 HTTPS  │   plugins                                            │   (backends)
        │   upstreams (balancing, health, retries)             │
        │   TLS and certificates                               │
        │   usage, metrics, access log                         │
        │   configuration cache on disk                        │
        └──────────────────────────────────────────────────────┘
              ▲
              └── or one YAML file, and no control plane at all
```

Two rules shape everything:

1. **Clients only ever talk to nodes, and nodes never need anything else to serve.** A node holds the whole configuration in memory and a copy on disk. The control plane and the database can be down; traffic continues.
2. **Only the admin writes to the database.** Nodes hold no database connection. They ask the admin for changes over HTTP and report back the same way.

## Components

| Component | What it is | Responsible for | Written in | Lives in |
|---|---|---|---|---|
| **Node** | The gateway. One binary, image `valkv-apg` | Everything on the request path | Rust | `crates/apg-proxy` |
| **Core library** | Shared by the node | The resource model, validation, the route matcher, the configuration loader. No network or disk access, so it can be tested exhaustively | Rust | `crates/apg-core` |
| **Admin** | The control plane. Image `valkv-apg-admin` | The Admin API, the configuration feed for nodes, background jobs, serving the console | TypeScript | `admin/` |
| **Console** | A web application served by the admin | Managing everything in a browser, using only the Admin API | TypeScript, React | `ui/` |
| **`apgctl`** | A command-line client | Configuration as files: validate, diff, apply, sync, dump, roll back | TypeScript | `cli/` |
| **Schemas** | JSON Schema files | The one definition of every resource, every plugin's settings, the configuration file and the change event. The node and the admin both validate against them, the console builds its forms from them, and the reference pages are generated from them | JSON | `schemas/` |
| **Postgres** | A database you provide | Everything the control plane knows | | |

## Inside a node

| Part | Does |
|---|---|
| **Listeners** | HTTPS and HTTP for traffic. A separate management listener, private by default, for health, readiness, metrics, status and backend health. |
| **Configuration source** | Gets configuration from exactly one place: a file it watches, or a control plane it polls. Both feed the same apply step, so behaviour cannot differ by mode. |
| **Snapshot** | An immutable, indexed copy of the whole configuration. Each request uses one snapshot from start to finish. A change builds a new snapshot beside the old and swaps it in, so no request waits for a change and no change is half visible. |
| **Cache on disk** | The last configuration applied, so a restart does not depend on the control plane. Losing it is safe: the node fetches everything again. |
| **Router** | Finds the route for a request. Routes are indexed by host, so cost does not grow with the number of routes. |
| **Plugin runtime** | Works out which plugins apply to a request and runs them in order. Plugin instances are built when configuration changes, never per request. |
| **Upstreams** | Chooses a backend, resolves names, runs health checks and circuit breakers, applies timeouts and retries. This state is kept outside the snapshot and survives configuration changes. |
| **TLS** | Chooses a certificate per connection, and obtains and renews certificates from an ACME authority. |
| **Usage and telemetry** | Counters per workspace, service and route; Prometheus metrics; the access log; trace context. None of it can block a request. |

## Inside the admin

| Part | Does |
|---|---|
| **Admin API** (`/v1`) | Every read and write of configuration, with roles and workspace scoping. |
| **Store** | One transaction per change writes three things together: the resource, an entry in the change feed for nodes, and an entry in the audit log. There is no way to write one without the others. |
| **Config API for nodes** (`/dp`) | A full snapshot, and "changes since N", which a node holds open until something happens. Also where nodes send heartbeats and usage, and coordinate certificate issuance. It can be put on its own listener, so the network that reaches nodes need not reach the Admin API. |
| **Jobs** | Trimming the change feed, rolling up usage, cleaning up expired leases and sessions. Each takes a lock, so several admins can run and only one does each job. |
| **Console host** | Serves the console's files and its sign-in. |

The admin keeps no state of its own. Run two or more behind a load balancer.

## How a configuration change reaches traffic

1. Someone saves a route in the console, or CI runs `apgctl apply`.
2. The admin validates it against the schemas and the rules (does this workspace own that host?), and in one transaction stores it, appends it to the change feed, and records it in the audit log.
3. Every node has a request open asking for changes after the last one it applied. The admin answers it at once.
4. Each node applies the change to a new snapshot, swaps it in, and writes it to its cache.
5. The node's next heartbeat tells the admin how far it has got, which is how the console shows that every node is up to date.

This typically takes well under a second. If a node falls too far behind, or is pointed at a different control plane, it discards what it has and takes a full snapshot instead of trusting its position.

A change a node does not understand, such as one from a newer admin, is counted, logged and stepped over. One bad change never stops the ones after it.

In standalone mode steps 1 to 3 are "you save the file". A file with a mistake is rejected whole and the node keeps the configuration it had.

## How a request flows

1. The TLS handshake picks a certificate by host name.
2. The request gets an id; the client's address is worked out, trusting forwarding headers only from proxies you listed.
3. The router finds a route, or the answer is `404`.
4. The request is attributed to a workspace.
5. Request plugins run: restrictions, authentication, limits, transformations. Any of them may answer and end the request.
6. A backend is chosen, skipping ones that are draining, failing or cut off.
7. The request is forwarded, with retries where that is safe.
8. Response plugins run as the response streams back.
9. Always, at the end: metrics, usage, the access log, and the outcome recorded against the backend.

## What talks to what

| From | To | How | Why |
|---|---|---|---|
| Clients | Node | HTTPS, HTTP | Traffic |
| Node | Your services | HTTP or HTTPS | Traffic, health checks |
| Node | Admin | HTTPS, with a node token | Fetch changes; report heartbeat, health and usage; coordinate certificates |
| Console, `apgctl`, your tooling | Admin | HTTPS, with a token or a session | Manage configuration |
| Admin | Postgres | SQL | Everything it stores |
| Node | ACME authority | HTTPS | Certificates |
| Prometheus | Node, Admin | HTTP | Metrics |

The admin never connects to a node, with one exception you opt into: the route tester asks one node you name.

## Where secrets are

Private keys and secret settings are encrypted by the admin before they are stored, and stay encrypted in the change feed and in each node's cache. They are in the clear only in the memory of a process that uses them. API keys, passwords and tokens are stored and distributed as hashes.

## Design choices worth knowing

- **Ready means "has a complete configuration", not "the control plane is reachable".** Every node shares one control plane; if losing it made nodes unready, an outage of the control plane would take all traffic down with it.
- **Each node decides health and counts limits for itself.** Nothing on the request path waits on another machine. The cost is that limits are per node and that two nodes can disagree about a backend, which is why health is reported per node.
- **One definition, used everywhere.** The schemas drive validation on both sides, the console's forms and the reference pages, so they cannot drift apart.
- **What is accepted is enforced.** A setting the running version does not act on is refused, not ignored.

The reasoning behind the larger decisions is recorded under [`docs/adr`](https://github.com/valkv-labs/valkv-apg/tree/main/docs/adr).
