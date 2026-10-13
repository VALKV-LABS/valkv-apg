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

Or all of what CI runs on a pull request, in one command:

```sh
make prepush   # about 20 minutes; starts its own containers and leaves a `make up` stack alone
```

To have that run before every `git push` from your clone, so that a push which would fail in CI fails on your machine first:

```sh
make hooks     # once per clone
```

`APG_SKIP_PREPUSH=1 git push` skips it for one push, for a change that touches no code.

## Rules that reviewers enforce

1. **Schemas first.** A new field or resource starts in `schemas/`, with a fixture in `tests/fixtures/`. The Rust and the TypeScript side both validate against the same files.
2. **No accepted-but-ignored configuration.** If the gateway cannot enforce a key, validation rejects it. `schemas/` may describe a key before the node implements it; until then the loader refuses it (see `UNBUILT_*` in `crates/apg-core/src/config.rs`).
3. **Tests ship with the change.** Database code is tested against a real Postgres, never mocked SQL. Request handling is tested end to end against a real node (`tests/e2e/routing.js` and `tests/e2e/upstream.js` run in every config mode).
4. **One apply path.** Every config source feeds the same code. A routing behaviour that differs by source is a bug.
5. **No secrets in output.** Not in logs, errors, audit rows or change events.
6. **Serving never depends on the control plane.** A change that makes a node need its config source to answer a request will not be merged.

Comments in the code cite requirement ids such as `CFG-9` or `PL-1`. They refer to the maintainers' requirements document; the comment beside each one says what the rule is.

## The changelog

A pull request that changes what a user can see adds a line under "Unreleased" in `CHANGELOG.md`, written for someone deciding whether to upgrade: what changed for them, with the exact name of any setting, endpoint or command. Those lines become the release notes word for word. [Writing release notes](docs/src/contributing/releasing.md#writing-release-notes) has the rules and an example.

## Releasing

A release is made by pushing a tag `vX.Y.Z`; the steps, and the things that look like releasing and are not, are in [Releasing](docs/src/contributing/releasing.md).

## Commit and pull request style

Small, focused pull requests. Say what changed and why.

By contributing you agree that your contribution is licensed under Apache-2.0.
