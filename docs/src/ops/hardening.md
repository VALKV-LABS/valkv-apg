# Security hardening

A checklist for a deployment that faces the internet. The reasoning behind it is in the [threat model](threat-model.md).

## Network

- [ ] Only ports 80 and 443 of the nodes are reachable from the internet.
- [ ] The nodes' management port (9100) is reachable only from your monitoring. It needs no credentials and shows configuration details.
- [ ] The control plane is reachable only from nodes, operators and CI. It is not on the internet.
- [ ] The control plane is served over TLS: set `APG_ADMIN_TLS_CERT` and `APG_ADMIN_TLS_KEY`, or put it behind something that terminates TLS. Tokens travel in every request.
- [ ] If nodes and operators are on different networks, serve the node feed on its own port (`APG_DP_LISTEN`) and let the node network reach only that.
- [ ] Postgres accepts connections only from the control plane, with TLS (`sslmode=require` or stricter in `APG_DATABASE_URL`).

## Secrets

- [ ] `APG_SECRET_KEY` comes from a secret store, not from an image, a repository or a shell history. Use `APG_SECRET_KEY_FILE` to read it from a mounted file.
- [ ] The secret key and database backups are stored apart.
- [ ] The bootstrap admin token was replaced: create named tokens for people and for CI, then revoke `bootstrap-admin`.
- [ ] Tokens are as narrow as their job: `viewer` or `editor`, scoped to the workspaces they need, with an expiry. Only break-glass access is a fleet-wide `admin`.
- [ ] People sign in to the console through your identity provider ([single sign-on](../guides/single-sign-on.md)) rather than sharing tokens.
- [ ] Configuration files in Git hold no secrets: `{ $env: … }` on nodes, `${VAR}` with `apgctl`.

## Nodes

- [ ] `APG_TRUSTED_PROXIES` lists exactly your own load balancers and CDN ranges, and nothing else. Whoever is on that list can set the client address the gateway believes.
- [ ] `APG_TLS_MIN_VERSION=1.3` if every client supports it.
- [ ] `APG_HTTP_MODE` is left at `redirect` unless TLS is terminated in front of the nodes.
- [ ] The container runs as its non-root user with a read-only root filesystem; only the data directory is writable.
- [ ] `APG_TEMPLATE_ENV_ALLOW` is empty, or lists only names that are safe for any tenant to read.

## Tenants

Only if people other than you can write configuration.

- [ ] `APG_DOMAIN_VERIFICATION=dns_txt`, so that a tenant cannot claim a host name it does not control.
- [ ] `APG_BACKEND_ALLOW_CIDRS` and `APG_EGRESS_ALLOW_CIDRS` are empty unless tenants' services really are on private networks, and then list only those ranges. By default a tenant cannot point the gateway at private, loopback or link-local addresses, which includes the cloud metadata address.
- [ ] Workspaces have limits (`max_routes` and the rest).
- [ ] Baseline plugins every tenant must have (a size limit, a rate limit per address) are attached at `global` scope in the system workspace, where tenants cannot remove them.
- [ ] `workspace_plugin_types` lists the plugin types tenants may use, if not all.
- [ ] Tenants get scoped tokens or delegated JWTs, never an `admin` token.

## The console

- [ ] `APG_UI_EMBED_ORIGINS` is empty unless you embed the console, and then lists exact origins.
- [ ] `APG_UI_ENABLED=false` on a control plane where nobody should use a browser.

## Monitoring

- [ ] Alerts from `deploy/observability/alerts.yaml` are loaded.
- [ ] Someone looks at refused entries in the audit log (`outcome: refused`): repeated refusals for one actor are worth a question.
- [ ] Logs are shipped somewhere nodes cannot rewrite.

## Supply chain

- [ ] Images are pulled by digest, or by an exact version tag, and their signature is checked:

  ```sh
  cosign verify valkvlabs/valkv-apg:0.1.0 \
    --certificate-identity-regexp 'https://github.com/VALKV-LABS/valkv-apg/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

## Keeping it that way

- [ ] Upgrades are applied within a release or two; see [rolling out a new version](rollout.md).
- [ ] The smoke test and `make e2e-security` (in a test environment) run after each upgrade.
- [ ] You know how to report a vulnerability: `SECURITY.md` in the repository.
