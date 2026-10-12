# The change feed nodes read

This is the contract between the control plane and the nodes. You need it only if you build something that reads the feed, or replace the control plane with your own.

The JSON Schema is `schemas/changelog-event.json` in the repository.

## An entry

```json
{ "v": 2, "kind": "route", "op": "upsert", "id": "0193f2a1-…", "workspace_id": "0193f2a0-…", "revision": 7,
  "data": { "name": "orders-api", "service": "0193f2a3-…", "hosts": ["api.example.com"], "paths": [{ "type": "prefix", "value": "/orders" }], "priority": 0, "enabled": true } }
```

| Field | Meaning |
|---|---|
| `v` | Contract version. `2` |
| `kind` | `workspace`, `domain`, `certificate`, `ca_certificate`, `service`, `route`, `plugin`, `consumer`, `credential`, `flag`, `setting`, `acme_challenge` |
| `op` | `upsert` or `delete` |
| `id` | The resource's id. For a flag or a setting, its name |
| `workspace_id` | Present for everything that belongs to a workspace |
| `revision` | With `upsert`: the resource's revision. A node ignores an entry whose revision is not newer than what it holds |
| `data` | With `upsert`: the resource as a node needs it. References are ids |

## Rules a reader must follow

- **Skip what you do not understand.** An unknown `kind`, an unknown `op`, or unknown fields inside `data` are not errors. This is what allows the control plane to be upgraded before the nodes.
- **Entries are ordered by sequence number**, and the control plane commits them in that order. Apply them in order.
- **An entry may refer to something that arrives later** only within a snapshot's ordering guarantee (below). In the feed, a route can arrive before its service after a resynchronisation; keep it aside until the service is there.

## What `data` never contains

- A private key in clear. Certificates carry `key_ciphertext`; plugin secrets carry `{ "$secret_ciphertext": "…" }`. Both are AES-256-GCM under the fleet's secret key, bound to the resource they belong to.
- An API key or a password. Credentials carry `key_hash` (SHA-256) or `password_hash` (argon2id).

## Endpoints

All need a token with the `node` role.

| Endpoint | Purpose |
|---|---|
| `GET /dp/changes?after=<seq>&limit=<n>&wait_ms=<ms>` | Entries after a sequence number. With `wait_ms`, the request is held until there is one. `410 RESYNC_REQUIRED` when `after` is older than what is kept |
| `GET /dp/snapshot` | The whole configuration as of one sequence number, one entry per line, in an order in which every reference is already defined: CA certificates, certificates, domains, services, routes, consumers, credentials, plugins |
| `POST /dp/heartbeat` | A node's version, applied sequence, staleness and upstream health |
| `POST /dp/usage` | Usage windows |
| `POST /dp/certs/lease`, `POST /dp/certs/lease/release`, `POST /dp/certs` | Coordinating certificate issuance: one node issues, all receive |
| `POST /dp/acme/challenges`, `DELETE /dp/acme/challenges/{token}`, `GET /dp/acme/account` | Sharing ACME challenge answers and the account key |
| `GET /dp/nodes/applied` | The lowest applied sequence among live nodes |

Each answer carries the identity of the control plane (`cluster_id`). A node that finds a different identity than its cache was built from discards the cache and takes a snapshot.

## Compatibility

Within contract version 2, kinds and fields are only ever added. A change that an existing node could not skip safely would be version 3, in a major release.
