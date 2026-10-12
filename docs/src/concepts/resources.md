# Resources

Configuration is made of a handful of kinds of resource. Each has a name that is unique within its workspace.

```
workspace
 ├─ domain ──────────▶ certificate
 ├─ service ─ backends
 ├─ route ───────────▶ service (or a split across services)
 ├─ consumer ─ credentials
 └─ plugin ──────────▶ attached to a route, a service, the workspace, or everything
```

| Resource | What it is |
|---|---|
| **Workspace** | A tenant. Owns everything below. The built-in workspace `default` is the *system workspace*, for the operator's own routes. |
| **Domain** | A host name the workspace owns, and how its certificate is obtained: automatically, uploaded, or none. |
| **Certificate** | A TLS certificate and its private key. Uploaded by you, or obtained by the gateway. |
| **CA certificate** | An authority to trust: for upstream TLS, or for client certificates. |
| **Service** | One upstream application: its backends, how to balance between them, health checks, timeouts, retries, upstream TLS. |
| **Route** | Which requests go to which service: hosts, paths, methods, header and query conditions, a priority. A route can split traffic across services by weight. |
| **Consumer** | A caller you can name. Has credentials (API keys, passwords, client-certificate identities) and belongs to groups. |
| **Plugin** | Something the gateway does to requests in a scope: authenticate, limit, transform, cache, log. |

Two things are fleet-wide and not resources of a workspace: **flags** (switches, such as turning one plugin type off everywhere) and **settings** (for example base domains for workspaces, or the access log's destination).

## Names and ids

Every resource has an id, assigned by the server, and a name, chosen by you. Wherever one resource refers to another (a route to its service, a plugin to its route) you may write either. The API always answers with ids, so what you read can be sent back unchanged.

In a configuration file there are no ids; you refer to things by name.

## One document for everything

All of this can be written as one YAML document:

```yaml
version: 1
domains:
  - hostname: api.example.com
    tls: { mode: none }
services:
  - name: orders
    backends:
      - target: "10.0.0.1:8080"
      - target: "10.0.0.2:8080"
    health_check:
      active: { path: /healthz }
routes:
  - name: orders-api
    service: orders
    hosts: [api.example.com]
    paths: [/orders]
    plugins:
      - type: key_auth
consumers:
  - name: mobile-app
    groups: [partners]
plugins:
  - type: cors
    scope: workspace
    config:
      origins: ["https://app.example.com"]
```

A plugin written under a route or a service is attached to it. A plugin in the top-level `plugins` list says its own `scope`.

## Concurrency and history

Each resource carries a revision number that goes up by one with every change. Through the API you can make a write conditional on the revision you last saw, so two people editing the same route cannot silently overwrite each other.

Every change is in the audit log with who made it and the resource before and after. Applying a whole document with `apgctl` also records a *revision* of the workspace that you can go back to.

The full list of fields is in [the configuration file reference](../reference/configuration-file.md).
