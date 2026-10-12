# How configuration reaches nodes

This page is about the mode with a control plane. In standalone mode there is nothing to propagate: the node watches its file.

## The change feed

Every change to a resource is appended, in the same database transaction as the change itself, to an ordered list: the *change feed*. Each entry has a sequence number, the kind of resource, whether it was written or deleted, and the resource as nodes need it.

A node remembers the sequence number of the last entry it applied, and asks the control plane for what comes after. The request waits at the control plane until there is something new (a long poll), so a change usually reaches a node well under a second after it is committed.

```
you ──PUT /v1/…/routes/x──▶ control plane ──▶ Postgres: route row + feed entry #812 + audit row (one transaction)
node ──GET /dp/changes?after=811──▶ control plane ──▶ [#812]
node applies #812, builds a new snapshot, swaps it in
```

## Starting up

A node with nothing on disk asks for a *snapshot*: the whole configuration as of one sequence number, in an order in which every reference can be resolved. It applies it, reports itself ready, and continues from the feed.

A node that has run before starts from its cache on disk and is ready at once, before it has reached the control plane. Then it catches up from the feed.

## When a node falls far behind

The feed is trimmed after a retention period (a week by default). A node that asks for entries older than that is told to resynchronise; it takes a fresh snapshot and carries on. The same happens when a node finds that the control plane is not the one its cache came from.

## What a node does with an entry it does not understand

It steps over it and counts it (`apg_changelog_errors_total`). This is what makes upgrades safe in either order: a control plane one release newer may send kinds of resource or fields that an older node has never heard of, and the node keeps working. See [rolling out a new version](../ops/rollout.md).

A route that refers to a service the node has not received yet is kept aside and becomes active the moment the service arrives.

## Seeing where every node is

```sh
apgctl nodes
```

```
NODE     VERSION  SOURCE    APPLIED  LAG  LIVE  STALE  REGION  LAST SEEN
edge-1   0.1.0    api_poll  812      0    true  false  eu      2026-06-01T12:00:03Z
edge-2   0.1.0    api_poll  812      0    true  false  us      2026-06-01T12:00:02Z
```

`LAG` is how many changes the node has yet to apply. The console's Nodes page shows the same. On a node itself, `GET /readyz` on the management port answers with `ready`, `stale` and `applied_seq`.

## What nodes are sent, and what they are not

- API keys and passwords: only hashes.
- Private keys and plugin secrets: only ciphertext. A node needs `APG_SECRET_KEY` to open them.
- Nothing about the audit log, admin tokens or other administrative state.

## Authentication of nodes

A node presents a token with the `node` role. That token opens the change feed and nothing else: it cannot read or change configuration through the Admin API. The feed can be served on its own port (`APG_DP_LISTEN`) so that the network nodes live in need not reach the Admin API at all.

The exact shape of the feed is in [the change feed reference](../reference/change-feed.md).
