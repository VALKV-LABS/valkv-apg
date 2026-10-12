# Usage for billing

The gateway counts what it serves, per workspace, service, route and consumer, and the control plane keeps the totals. Use them to bill, to show customers their consumption, or to see who uses what.

## What is counted

For every combination of workspace, service, route and consumer, per time window:

| Field | Meaning |
|---|---|
| `requests` | Requests handled |
| `status_2xx`, `status_3xx`, `status_4xx`, `status_5xx` | By class of response |
| `bytes_in`, `bytes_out` | Request and response sizes |
| `latency_ms_sum`, `upstream_latency_ms_sum` | Divide by `requests` for an average |

Requests the gateway refused (a missing key, a rate limit) are counted too, under their status.

## How it gets there

Each node adds requests up in memory in windows aligned to the clock, and reports closed windows to the control plane about once a minute. A report that is repeated replaces itself, so nothing is counted twice. If the control plane is unreachable the node queues windows on disk, for up to a day, and sends them when it is back.

The control plane keeps the reports as they came (7 days by default), and rolls them up by hour and by day (400 days by default). Usage is kept after the workspace, route or consumer it was counted for is deleted.

## Reading it

Console: **Usage**, with a time range, grouping, and CSV export.

Command line:

```sh
apgctl usage --group-by consumer --granularity day --from 2026-06-01 --to 2026-07-01
```

API:

```sh
curl -G "$APG_ADMIN_URL/v1/usage" -H "Authorization: Bearer $APG_ADMIN_TOKEN" \
  --data-urlencode workspace=acme \
  --data-urlencode granularity=day \
  --data-urlencode group_by=consumer \
  --data-urlencode from=2026-06-01T00:00:00Z \
  --data-urlencode to=2026-07-01T00:00:00Z
```

```json
{
  "granularity": "day",
  "group_by": ["consumer"],
  "data": [
    { "bucket": "2026-06-01T00:00:00.000Z", "consumer_id": "0193…", "requests": 18234, "status_2xx": 18001, "status_4xx": 230, "status_5xx": 3, "bytes_in": 912340, "bytes_out": 48211003, "latency_ms_sum": 401148, "upstream_latency_ms_sum": 364680 }
  ],
  "truncated": false
}
```

| Parameter | Values |
|---|---|
| `granularity` | `minute` (recent data only), `hour`, `day` |
| `group_by` | any of `workspace`, `service`, `route`, `consumer`, `region`, comma-separated |
| `workspace`, `service`, `route`, `consumer`, `region` | filter to one |
| `from`, `to` | times; default is the last 24 hours |

A caller scoped to a workspace must name it. Only a fleet administrator may ask across all workspaces.

Rows carry ids. Join them with names from the resource lists; ids stay valid after a rename.

## A monthly invoice run

```sh
apgctl usage --all-workspaces --group-by workspace --granularity day \
  --from 2026-06-01 --to 2026-07-01 -o json > usage-2026-06.json
```

Run it a few hours after the period ends: a node that was cut off from the control plane may deliver its last windows late, and the affected hours are recalculated when it does.

## Per consumer or not

By default usage is counted per workspace, service and route. Counting per consumer as well multiplies the number of rows, so it is off until you turn it on, on every node: `APG_USAGE_BY_CONSUMER=true`. Without it, grouping by consumer returns one row with an empty consumer.

## Standalone mode

Without a control plane, a node can append its windows to a file as JSON lines (`APG_USAGE_SINK=file:/var/lib/apg/usage.jsonl`), or discard them (the default).

## Limits and usage are different things

[`quota`](../reference/plugins/quota.md) enforces an allowance on each node in real time. Usage is the record of what was served, summed over all nodes. Enforce with the first; bill from the second.

## Not built yet

Pushing each closed hour to a webhook of yours. Today you pull from the API.
