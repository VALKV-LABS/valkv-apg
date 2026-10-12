# Development environment

You need Docker and `make`. Nothing is built or run on your machine directly: no Rust toolchain, no Node.js.

```sh
git clone https://github.com/VALKV-LABS/valkv-apg && cd valkv-apg
make unit          # every unit test: Rust, control plane, CLI, console
make up            # control plane, Postgres, two nodes, sample upstream, a test ACME authority
make integ         # control plane, CLI and browser tests, then every end-to-end suite
make down
```

The first Rust build takes several minutes; later ones use a build cache.

## Layout

| Path | What |
|---|---|
| `crates/apg-core` | Decisions with no I/O: the resource model, the route matcher, the configuration loader, templates |
| `crates/apg-plugin-sdk` | Plugin phases and default priorities |
| `crates/apg-proxy` | The node: listeners, upstreams, TLS and ACME, plugins, usage, configuration sources |
| `admin/` | The control plane (TypeScript): Admin API, node feed, jobs |
| `cli/` | `apgctl` |
| `ui/` | The console (React) |
| `schemas/` | JSON Schemas: the single definition of every resource, every plugin's settings, the configuration file and the change feed |
| `tests/` | Shared fixtures, end-to-end suites, the smoke test, benchmarks |
| `deploy/` | Compose files, Helm chart, systemd unit, Terraform reference, dashboards |
| `docs/` | This documentation |

## Make targets

| Target | Does |
|---|---|
| `make unit` | `unit-rust`, `unit-admin`, `unit-cli`, `unit-ui` |
| `make lint` | Clippy with warnings as errors |
| `make up` / `make down` | Start and remove the stack |
| `make integ` | Control plane integration tests against Postgres, the CLI against the stack, the console in a browser, then end-to-end suites |
| `make e2e MODE=file` | End-to-end suites against a standalone node |
| `make e2e-resilience`, `e2e-skew`, `e2e-security`, `e2e-upgrade` | Outages and recovery; version skew; tenant isolation and a search of logs for secrets; binary hand-over |
| `make smoke`, `make canary-rehearsal` | The deployment smoke test; a canary promoted and one rolled back |
| `make docs`, `make docs-check` | Regenerate the reference pages and build the book; fail if generated pages are stale or an example is invalid |
| `make lint-helm`, `make lint-terraform` | Chart and Terraform checks |

## A faster loop

For Rust, run cargo in the toolchain image with cached volumes instead of rebuilding an image each time:

```sh
docker build -q -f crates/apg-proxy/Dockerfile --target toolchain -t valkv-apg:toolchain .
docker run --rm -v "$PWD:/app" -v apg-cargo-registry:/usr/local/cargo/registry \
  -v apg-target:/target -e CARGO_TARGET_DIR=/target -w /app valkv-apg:toolchain \
  cargo test -p apg-core matcher
```

For the console, `npm run dev` in `ui/` (in a Node container) serves it with hot reload and proxies the API to a control plane on `localhost:9000`.

## Tests, and what kind goes where

| You changed | Add a test in |
|---|---|
| A decision with no I/O (matching, validation, a plugin's logic) | A unit test beside the code |
| An Admin API endpoint or a rule about resources | `admin/test/integ/`, against a real Postgres. SQL is never mocked |
| Behaviour a client or an upstream can observe | `tests/e2e/`, as a `step()` in the matching suite. It runs in both modes |
| A configuration key | Any of the above, as long as a test sets the key and shows that it matters. `node tools/check-tested-keys.mjs` lists keys no test sets |
| The console | A component test in `ui/src/`, and a browser test in `ui/e2e/` for a journey |
| `apgctl` | `cli/src/cli.test.ts`, and `cli/test/integ/` for anything that needs a server |

## Rules that are checked

- **Everything accepted is enforced.** A schema key the node does not act on must be listed in `schemas/unbuilt.yaml`, where both loaders refuse it. A key with no test fails `check-tested-keys`.
- **The two loaders agree.** The Rust and TypeScript sides read the same schemas and run the same fixtures in `tests/fixtures/`.
- **Generated things are committed and checked:** `admin/openapi.json`, and the reference pages under `docs/src/reference/`.
- **No secret in any output.** `admin/test/integ/secrets.test.ts` and `make e2e-security`.

## Sending a change

See `CONTRIBUTING.md` in the repository: one logical change per pull request, tests in the same change, an entry in `CHANGELOG.md` for anything a user would notice.
