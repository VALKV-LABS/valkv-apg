# Releasing

## Versions

Semantic versioning. Three things are public interfaces and change incompatibly only in a major release: the Admin API (`/v1`), the configuration file (`version: 1`), and the change feed between control plane and nodes (contract version 2).

Within a major version, a node and a control plane one minor release apart, in either direction, must work together. `make e2e-skew` guards the node's side of that.

## What a release publishes

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`, which:

1. builds both images for `linux/amd64` and `linux/arm64`, each on its own hardware, with a bill of materials and build provenance;
2. publishes them as `valkvlabs/valkv-apg` and `valkvlabs/valkv-apg-admin` under `X.Y.Z`, `X.Y` and `latest`, and signs them with cosign (keyless);
3. packages the node binary with its systemd unit as a tarball per platform, and the Helm chart;
4. writes checksums, signs them, and creates the GitHub release with the changelog section for that version as its notes.

A pre-release tag (`v1.2.0-rc.1`) publishes only its own version and never moves `latest`.

Every merge to `main` publishes both images as `edge`.

The workflow needs two repository secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

## Steps

1. **Check `main` is green**, then start the "full suite" workflow by hand from the Actions tab and wait for it to pass. It holds the slower suites and never runs on its own.
2. **Update versions** in `Cargo.toml` (workspace), `admin/package.json`, `cli/package.json`, `ui/package.json`, the `VERSION` constants in `admin/src/index.ts` and `cli/src/run.ts`, and `deploy/helm/valkv-apg/Chart.yaml` (`version` and `appVersion`).
3. **Update `CHANGELOG.md`:** rename "Unreleased" to the version and date, and start a new "Unreleased". Mark anything that needs action when upgrading.
4. **Regenerate** what embeds the version: `make unit-admin` (it tells you if `admin/openapi.json` is stale) and `make docs`.
5. **Merge**, then tag the merge commit and push the tag:

   ```sh
   git tag -s v0.2.0 -m "valkv-apg 0.2.0"
   git push origin v0.2.0
   ```

6. **Verify** the result:

   ```sh
   cosign verify valkvlabs/valkv-apg:0.2.0 \
     --certificate-identity-regexp 'https://github.com/VALKV-LABS/valkv-apg/' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

   Start the published images with `deploy/lightsail/up.sh` and run `tests/smoke.sh` against them.

## If a release is bad

Do not delete or move a tag. Publish a fixed patch release. If an image must not be used, say so at the top of its release notes; `latest` moves with the next release.

## Database migrations

Migrations are numbered pairs in `admin/migrations/`, applied by the control plane at start under a lock. Rules:

- Every migration has a working `down`.
- A migration must not break the previous minor release of the control plane, because during a rolling upgrade both run against the same database. Add first; remove in a later release.
- A migration never rewrites the change feed.
