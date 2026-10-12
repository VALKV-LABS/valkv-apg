# Capacity planning

What each part needs, what makes it need more, and what to watch. The sizes below are guidance to start from. Measure with your own traffic before committing to one; `make bench-throughput` and `make bench-scale` are the project's own measurements, and [what they showed](#what-has-been-measured) is at the end of this page.

## Nodes

A node is CPU-bound. Memory use follows the size of the configuration, not the traffic.

**What costs CPU, most first:** TLS handshakes (new connections, not requests on an existing one); compression; JSON body transformation; password verification in `basic_auth`; everything else.

**Starting points:**

| Traffic | Nodes |
|---|---|
| A trial, or a small internal API | 1 node, 1 vCPU, 512 MB |
| Production with modest traffic | 2 nodes, 2 vCPU and 1 GB each, in two zones |
| Beyond that | Add nodes when average CPU passes 60 % |

Run at least two nodes for anything that matters, so one can be replaced. Scale out rather than up: nodes share nothing and need no coordination to serve.

**Memory** grows with: routes, consumers and credentials (all held in memory); the response cache, bounded by `APG_CACHE_MEMORY_BYTES`; metric series, bounded by `APG_METRICS_MAX_SERIES`; counters of rate limits, which are dropped when idle.

**File descriptors.** Each client connection and each upstream connection uses one. Raise the limit (`ulimit -n`, `LimitNOFILE`, or `--ulimit nofile`) to well above your peak connection count; the images and the systemd unit do not raise it for you.

**Disk.** A few megabytes for the configuration cache; more only if usage queues up during a control-plane outage.

**Remember limits are per node.** Adding nodes loosens every `rate_limit` and `quota` in proportion. See [rate limits, quotas and bandwidth](../guides/limits.md).

## The control plane

It does little work per change and none per request. Two small instances are plenty for almost any fleet, and the second is for availability.

What makes it work harder: many nodes long-polling (one open connection each); very frequent configuration changes; usage reports, which grow with nodes × active routes × consumers.

## Postgres

| Data | Growth | Kept for |
|---|---|---|
| Configuration | Small. Kilobytes per route | Until deleted |
| The change feed | One row per change | 7 days (`APG_CHANGELOG_RETENTION_HOURS`) |
| Audit log | One row per change, with the resource before and after | 400 days (`APG_AUDIT_RETENTION_DAYS`) |
| Usage, as reported | Nodes × active (route, consumer) pairs, per minute | 7 days (`APG_USAGE_RAW_RETENTION_DAYS`) |
| Usage, hourly and daily | Active pairs, per hour and per day | 400 days (`APG_USAGE_HOURLY_RETENTION_DAYS`) |

Usage dominates. If per-consumer metering is on and you have many consumers, estimate rows per day as *active consumers × routes they use × 24* for the hourly table, and size from there. Turning per-consumer metering off (`APG_USAGE_BY_CONSUMER=false`, the default) removes the multiplier.

A small managed instance (2 vCPU, 4 GB) carries a large configuration. Use a highly available one: while Postgres is down nothing can be changed, though traffic is unaffected.

## How fast a change arrives

Typically well under a second from the control plane committing a change to a node serving it. `tests/bench/propagation.js` measures it on your deployment:

```sh
make bench-propagation
```

## What to alert on

| Signal | Meaning |
|---|---|
| Node CPU above 80 % for 10 minutes | Add nodes |
| `apg_nodes_max_lag` above 0 for more than a minute | A node is not applying changes |
| `apg_config_source_age_seconds` rising | A node cannot reach the control plane |
| `apg_backend_healthy == 0` for a service | An upstream is down |
| `apg_usage_windows_pending` rising | Usage is queuing on nodes |
| `apg_usage_windows_dropped_total` increasing | Usage was lost: the queue passed its limit |
| `apg_access_log_dropped_total` increasing | The log destination cannot keep up |
| `apg_certs_expiring{within="7d"}` above 0 | Renewal is failing |

Ready-made rules are in `deploy/observability/alerts.yaml`.

## What has been measured

Two benchmarks are in the repository. Their results depend on the machine; these are from a development laptop, not from server hardware, and are here so that you know what was and was not shown.

**A large configuration** (`make bench-scale`): one node's configuration with 100,000 routes, 20,000 workspaces, 100,000 domains and 200,000 consumers.

| | Result |
|---|---|
| Building the snapshot | 1.5 s |
| Matching a request to a route | median 1.2 µs, 99th percentile 7 µs |
| Memory for the configuration | about 730 MiB |

Matching does not slow down as the number of routes grows, because routes are indexed by workspace and host.

**Throughput** (`make bench-throughput`): one node, a release build, against a fast upstream, with the load generator, the node and the upstream sharing 8 logical CPUs inside Docker Desktop.

| | Requests per second | 99th percentile latency at full load |
|---|---|---|
| The upstream alone | 55,000 | 17 ms |
| Through the gateway | 11,900 | 29 ms |
| Through the gateway with an API key and a rate limit | 10,700 | 29 ms |

An API key check and a rate limit together cost about a tenth of the gateway's throughput. The gateway's own figure here is well below the project's goal of 30,000 requests a second per node; that goal has not been demonstrated yet, and these numbers should not be read as what server hardware would do. Size from your own measurement.
