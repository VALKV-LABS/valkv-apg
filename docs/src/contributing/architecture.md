# Architecture for contributors

How the code is put together, and the decisions that are easy to undo by accident. This page names the libraries used; user-facing pages do not.

## The node

Built on Pingora (the proxy framework), in three crates.

**`apg-core` has no I/O.** It defines the resource model (`model.rs`), applies change events to a set of resources (`resources.rs`), and builds an immutable `Snapshot` from them (`snapshot.rs`): the route index, plugin resolution, consumers. It also holds the configuration-file loader, path normalisation and templates. Anything that can be decided without a socket belongs here, where it is cheap to test.

**`apg-proxy` is the process.** The pieces:

| File | Role |
|---|---|
| `main.rs`, `config.rs` | Start-up, environment |
| `source_file.rs`, `source_api.rs`, `applier.rs`, `cache.rs` | Where configuration comes from, applying it, the disk cache |
| `gateway.rs` | The shared state: the current snapshot (swapped atomically), upstream state, health |
| `proxy.rs` | The request path: Pingora's hooks, the plugin driver, logging |
| `upstream.rs` | Balancing, health checks, circuit breaker, DNS, retries |
| `tls.rs`, `acme.rs`, `secrets.rs` | Certificates, issuance, opening sealed values |
| `plugins.rs`, `auth.rs`, `callout.rs`, `transform.rs`, `response_cache.rs`, `limits.rs`, `mtls.rs` | Plugin implementations |
| `usage.rs`, `accesslog.rs`, `metrics.rs`, `mgmt.rs` | Metering, the access log, metrics, the management listener |

**Invariants:**

- A request sees one snapshot from start to finish. Never read "the current snapshot" twice in one request.
- Applying configuration never blocks a request, and no lock is held across an `await` on the request path.
- Plugin instances are built once per configuration change (`plugins::Runtime`), not per request.
- State keyed by request data (limit buckets, caches, metric series) has a cap and an eviction rule.
- An event the node cannot decode is skipped and counted, never fatal.

**Things the proxy framework will do to you:** creating an upstream peer from a host name blocks, so always resolve first and pass a socket address; to hold a request body back, return an empty chunk rather than nothing; compression must be switched on before the request filter runs for the response to be compressed.

## The control plane

TypeScript on Fastify and Postgres (postgres.js), no ORM.

| File | Role |
|---|---|
| `store.ts` | Every write to a resource. One transaction writes the row, the change-feed entry and the audit row |
| `kinds.ts` | Per kind: how a validated document becomes a row, an API representation and a feed entry; what depends on it |
| `declarative.ts` | Documents: apply, diff, sync, dump, revisions. A diff is an apply that is rolled back |
| `auth.ts`, `oidc.ts` | Tokens, delegated JWTs, sessions, single sign-on |
| `routes/api.ts`, `routes/config.ts`, `routes/dp.ts` | The Admin API, documents and sessions, the node feed |
| `schemas.ts` | Loads `schemas/` and validates against it |
| `jobs.ts`, `usage.ts` | Background jobs under an advisory lock; usage ingestion and roll-up |

**Invariants:**

- No code path writes a resource without its feed entry and its audit row. If you need a new kind of write, add it to the store.
- Feed entries are committed in sequence order; the store takes a row lock for that. Do not insert into the feed from elsewhere.
- Out of scope is `404`, not `403`, with the same message as a missing resource.
- A secret is returned only by the response that creates it.
- Validation comes from the schemas. Rules a schema cannot express live in `kinds.ts`, with a JSON pointer on every fault.

## The schemas are the contract

`schemas/` is read by the Rust loader, the control plane, `apgctl` (offline validation), the console (forms), the OpenAPI document and the documentation generator. Adding a field means adding it there, and then:

1. the node acts on it, with a test; or
2. it goes into `schemas/unbuilt.yaml` and both loaders refuse it.

There is no third state.

## The console and the CLI

Both use only the public `/v1` API. The console draws its forms from the schemas the server publishes (`ui/src/components/schema-form.tsx`), so a new field usually needs no console change. Styling is one stylesheet of design tokens; there is no component library.

`apgctl` is a thin client: `document.ts` (reading and merging files, offline checks), `run.ts` (commands). Everything it prints comes from the server's answers.

## Decisions worth knowing before changing them

| Decision | Why |
|---|---|
| Nodes pull; nothing is pushed | A node behind any firewall works, and the control plane needs no inventory of nodes |
| Nodes never connect to Postgres | A compromised node must not reach the database |
| System routes always match first | A tenant can never shadow an operator route |
| Limits are local to a node | No shared store on the request path; the cost is documented imprecision |
| A diff is a rolled-back apply | One implementation of every rule, so diff and apply cannot disagree |
| Refuse what is not enforced | A gateway that accepts a security setting and ignores it is worse than one that refuses it |
| Readiness means "has a complete configuration" | A control-plane outage must not take nodes out of rotation |
