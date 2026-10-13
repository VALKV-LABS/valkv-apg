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

Every merge to `main` publishes both images as `edge`: the tip of development, for trying things out. `latest` is the newest release and moves only when a version tag is pushed. Deployments should name an exact version.

The workflow needs two repository secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

## Steps

A release is made by pushing a tag. Nothing else publishes a version: not the "Run workflow" button, and not creating a release on GitHub by hand.

1. **Check `main` is green.** Then start the "full suite" workflow by hand from the Actions tab and wait for it to pass. It holds the slower suites and never runs on its own.

2. **Choose the version.** See [Versions](#versions). A change that breaks one of the three public interfaces is a major release; a new feature is a minor one; fixes only are a patch.

3. **Open a pull request that prepares the release.** In it:

   - **Set the version** in `Cargo.toml` (workspace), `admin/package.json`, `cli/package.json`, `ui/package.json`, the `VERSION` constants in `admin/src/index.ts` and `cli/src/run.ts`, and `deploy/helm/valkv-apg/Chart.yaml` (`version` and `appVersion`). Skip this when they already say the version you are releasing, as they do for the first release.
   - **Turn the changelog's "Unreleased" section into this release's.** Rename the heading to the version and today's date, and start a new, empty "Unreleased" above it:

     ```md
     ## [Unreleased]

     ## [0.2.0] - 2026-11-03
     ```

     The heading must contain the version in square brackets, without a `v`. The workflow copies everything under that heading into the GitHub release; if it finds no such heading, the release notes say only "See CHANGELOG.md."
   - **Read the section as someone upgrading would**, and fix it where it falls short. See [Writing release notes](#writing-release-notes).
   - **Regenerate** what embeds the version: `make unit-admin` (it tells you if `admin/openapi.json` is stale) and `make docs`.

4. **Merge it**, and wait for CI on `main` to pass on the merge commit.

5. **Tag the merge commit and push the tag.** The tag is the version with a `v` in front:

   ```sh
   git checkout main && git pull
   git tag -a v0.2.0 -m "valkv-apg 0.2.0"
   git push origin v0.2.0
   ```

   The `v` matters. The workflow starts only for tags of the form `vX.Y.Z` (or `vX.Y.Z-something` for a pre-release). A tag `0.2.0` starts nothing, and no images are published for it.

   Sign the tag (`-s` instead of `-a`) if you have a signing key set up.

6. **Watch the "release" workflow** in the Actions tab. Building the node for two platforms takes a while. When it ends there should be:

   - `valkvlabs/valkv-apg` and `valkvlabs/valkv-apg-admin` on Docker Hub under `0.2.0`, `0.2` and `latest`;
   - a GitHub release named `v0.2.0`, created by the workflow, with the node tarballs, the Helm chart, `SHA256SUMS` and its signature attached, and the changelog section as its text.

7. **Verify** what was published:

   ```sh
   cosign verify valkvlabs/valkv-apg:0.2.0 \
     --certificate-identity-regexp 'https://github.com/VALKV-LABS/valkv-apg/' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

   Start the published images with `deploy/lightsail/up.sh` and run `tests/smoke.sh` against them.

### Things that look like releasing and are not

| What you did | What happens |
|---|---|
| Pushed a tag without the `v` (`0.2.0`) | Nothing. Delete that tag (`git push origin --delete 0.2.0`) and push `v0.2.0` |
| Created a release on GitHub by hand | A release page with no images and no files. Delete it; the workflow creates the real one when the tag is pushed |
| Pressed "Run workflow" on the release workflow | From `main` it republishes `edge`, the same as a merge does. From any other branch it is skipped. It never publishes a version |
| Merged to `main` | `edge` is published. `latest` and version tags do not move |

### A pre-release

Tag it `v0.2.0-rc.1`. It is published under `0.2.0-rc.1` only, never as `latest` or `0.2`, and its GitHub release is marked as a pre-release. Give the changelog a `## [0.2.0-rc.1]` heading if you want notes on it.

## Writing release notes

The release notes are the changelog section for the version, word for word. So the changelog is written for the person deciding whether and how to upgrade, not for the people who made the changes.

**As you go.** Every pull request that changes what a user can see adds a line under "Unreleased", in the same pull request. A change with no line is not in the release notes. Changes to tests, CI or internals need no line.

**Where a line goes.** Use the headings of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), in this order, leaving out the empty ones:

| Heading | For |
|---|---|
| Changed | Something that behaves differently from the last release |
| Deprecated | Something that still works and will be removed |
| Removed | Something that no longer works |
| Fixed | A defect |
| Security | A vulnerability. Say which versions are affected |
| Added | Something new |

**How to write a line.**

- Say what changed for the user, in terms they use: the setting, the endpoint, the command, the status code. Not the function or the file.
- Lead with the outcome. "A backend name with an address the node cannot reach no longer fails a share of requests with `502`" tells an operator whether it matters to them. "Fix address selection" does not.
- Give the exact name of anything they would type or search for, in backticks: `APG_ACME_DNS_PROVIDER=cloudflare`, `GET /upstreams`, `apgctl health`.
- One change, one line. Two sentences at most.
- Do not mention internal library names, issue numbers alone, or who did the work.

**Before tagging, add to the top of the section when it applies:**

- **Upgrading.** Anything someone must do, or must know, to move to this version: a setting that is now required, a default that changed, a migration that takes long, an order to upgrade in. If there is nothing, say nothing. Start each such line with "**Upgrading:**" so it is found.
- **Breaking changes**, in a major release, each with what to do instead.
- **Not built.** If the release accepts something in its schemas that it refuses at run time, the README's table says so; do not let the notes suggest otherwise.

A good section, shortened:

```md
## [0.2.0] - 2026-11-03

**Upgrading:** nodes now need `APG_SECRET_KEY` to serve certificates sent by a control plane. Set it on every node before upgrading the control plane.

### Changed
- A tenant with no running backend answers `404`, not `502`.

### Fixed
- Writing a resource with what it already holds is no longer a change: nodes are sent nothing.

### Added
- DNS challenges through Cloudflare: `APG_ACME_DNS_PROVIDER=cloudflare` with `APG_CLOUDFLARE_API_TOKEN`.
```

## If a release is bad

Do not delete or move a published version tag. Publish a fixed patch release. If an image must not be used, say so at the top of its release notes; `latest` moves with the next release.

If the workflow fails partway, look at how far it got. Before any image was tagged, fix the cause and push the next patch version. After images were published, the same: the next patch version, with a line in its notes saying what was wrong with the one before.

## Database migrations

Migrations are numbered pairs in `admin/migrations/`, applied by the control plane at start under a lock. Rules:

- Every migration has a working `down`.
- A migration must not break the previous minor release of the control plane, because during a rolling upgrade both run against the same database. Add first; remove in a later release.
- A migration never rewrites the change feed.
