# Contributing

Thanks for looking. The project is early; the README says what works today.

## Setup

You need Docker and `make`. No Rust or Node toolchain on the host.

```sh
make unit    # must pass before you open a pull request
make lint
make up && make integ && make down
make e2e MODE=file
```

## Rules that reviewers enforce

1. **Schemas first.** A new field or resource starts in `schemas/`, with a fixture in `tests/fixtures/`. The Rust and the TypeScript side both validate against the same files.
2. **No accepted-but-ignored configuration.** If the gateway cannot enforce a key, validation rejects it. `schemas/` may describe a key before the node implements it; until then the loader refuses it (see `UNBUILT_*` in `crates/apg-core/src/config.rs`).
3. **Tests ship with the change.** Database code is tested against a real Postgres, never mocked SQL. Request handling is tested end to end against a real node (`tests/e2e/routing.js` runs in every config mode).
4. **One apply path.** Every config source feeds the same code. A routing behaviour that differs by source is a bug.
5. **No secrets in output.** Not in logs, errors, audit rows or change events.
6. **Serving never depends on the control plane.** A change that makes a node need its config source to answer a request will not be merged.

Comments in the code cite requirement ids such as `CFG-9` or `PL-1`. They refer to the maintainers' requirements document; the comment beside each one says what the rule is.

## Commit and pull request style

Small, focused pull requests. Say what changed and why.

By contributing you agree that your contribution is licensed under Apache-2.0.
