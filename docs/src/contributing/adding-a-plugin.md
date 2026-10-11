# Adding a plugin type

A plugin type touches six places. The checks will tell you if you miss one.

## 1. The schema

`schemas/plugins/<type>.json`: the plugin's settings. Give every property a description (it becomes the documentation and the console's field hint) and a default where there is one. Set `additionalProperties: false`.

Mark secret values with `"x-apg-secret": true` and the shared `secretValue` definition; the control plane will then encrypt them and never return them.

Add the type to the list in `schemas/resources/plugin.json`, and the file to `FILES` in `crates/apg-core/src/schema.rs`.

## 2. Phase and priority

In `crates/apg-plugin-sdk/src/lib.rs`, add the type with the phases it runs in and its default priority. Pick the priority by what must have happened before it: after authentication if it needs the consumer, before the transformers if it may refuse.

Mirror the entry in `admin/src/plugin-types.ts`. A test fails if the two differ.

## 3. The implementation

In `crates/apg-proxy/src/plugins.rs`:

- Add a variant to `Built`, constructed once from the validated configuration in `Runtime::build`. Parse and compile everything here (patterns, templates, keys), so that a request does no setup work.
- Handle the variant in the driver for each phase it declared. A plugin that refuses returns a `Verdict::Deny` with a status, an error code and a fixed message.

If the plugin keeps state keyed by request data, give it a cap and an eviction rule. If it calls another service, give it a timeout and decide what happens on failure: plugins that guard a route fail closed.

Add the type to `ENFORCED_PLUGIN_TYPES` in `crates/apg-core/src/config.rs`. Until it is there, the file loader refuses the type.

## 4. A flag

Each type can be switched off fleet-wide by the flag `plugin_<type>`. The driver checks it; add the flag's name where the others are listed.

## 5. Tests

- Unit tests of the plugin's logic beside it.
- A route and at least one `step()` in `tests/e2e/plugins.js` showing the success path, each refusal with its error code, and that **every key of the schema changes something observable**. `node tools/check-tested-keys.mjs` fails on a key no test sets.
- If the control plane has rules for it beyond the schema (references, egress), a case in `admin/test/integ/admin.test.ts`.

## 6. Documentation

`docs/fragments/plugins/<type>.md`: when to use it, two complete examples, what clients see, what it goes well with. The settings table, phases and priority are generated above it. Add the page to `docs/src/SUMMARY.md`, then:

```sh
make docs          # regenerates docs/src/reference/plugins/<type>.md
make docs-check    # the examples must be valid configuration
```

Add a check to `tests/smoke.mjs` if the plugin is something a deployment should be smoke-tested for.

## What you do not need to touch

- **The console.** It lists types from the server and draws the form from your schema.
- **`apgctl`.** It validates against the schemas it bundles.
- **The OpenAPI document**, beyond regenerating it (`make unit-admin` tells you when it is stale).

## If the node cannot enforce part of it yet

List the key in `schemas/unbuilt.yaml` with its default. Both loaders then refuse any other value, the reference page says "not available yet", and nobody runs with a setting that silently does nothing. Remove the entry in the change that implements it.
