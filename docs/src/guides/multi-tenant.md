# Many tenants on one gateway

This guide sets up a gateway where each customer manages its own routes and nobody can affect anybody else. Read [workspaces and who owns a host](../concepts/workspaces.md) first for the rules behind it.

## 1. One workspace per customer

```sh
curl -X POST "$APG_ADMIN_URL/v1/workspaces" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "acme", "limits": {"max_routes": 50, "max_services": 20, "max_domains": 5, "max_consumers": 1000}}'
```

You can supply the `id` yourself, so that the workspace has the same id as the customer in your own system.

## 2. Give every customer an address at once

Set a base domain. Every workspace then owns `<slug>.apps.example.com` with no further step:

```sh
curl -X PUT "$APG_ADMIN_URL/v1/settings/workspace_base_domains" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"value": [{"domain": "apps.example.com", "tls": {"mode": "none"}}]}'
```

Customers who bring their own name create a domain for it. Turn on proof of ownership so that nobody can claim a name that is not theirs:

```sh
APG_DOMAIN_VERIFICATION=dns_txt     # on the control plane
```

A new domain is then *pending* and shows a TXT record to create; the customer creates it and presses **Verify** (or calls `POST …/domains/{name}/verify`).

## 3. Let customers in

Three ways, from least to most integrated.

**A token per customer.** Scoped to one workspace, with a role:

```sh
apgctl tokens create --name acme-ci --role editor --workspaces <workspace id>
```

| Role | May |
|---|---|
| `viewer` | Read its workspaces |
| `editor` | Also create, change and delete resources there |
| `admin` | With all workspaces: everything, including tokens, settings and workspaces themselves |

**Your platform's own tokens.** If your customers already sign in to your product, let the control plane accept the JWTs you issue. A token then acts as an editor of exactly the workspace named in one of its claims:

```sh
APG_ADMIN_JWT_JWKS_URL=https://platform.example.com/.well-known/jwks.json
APG_ADMIN_JWT_ISSUER=https://platform.example.com
APG_ADMIN_JWT_AUDIENCE=gateway
APG_ADMIN_JWT_WORKSPACE_CLAIM=tenant_id
APG_ADMIN_JWT_ROLE_CLAIM=gateway_role      # optional: viewer or editor
```

**The console inside your product.** See [embedding the console](embedding-ui.md).

## 4. Stop customers pointing the gateway inward

A tenant may not name a backend or a callout address that resolves to a private, loopback or link-local address. If your customers' services really are on private networks, allow those ranges explicitly, on the control plane and on the nodes:

```sh
APG_BACKEND_ALLOW_CIDRS=10.20.0.0/16
APG_EGRESS_ALLOW_CIDRS=10.20.0.0/16
```

Nodes check again at connection time, so a public name that later resolves to a private address is refused too.

## 5. Things every tenant gets, set once

Put them in the system workspace at `global` scope: a size limit, a rate limit per address, security headers. Tenants cannot remove them, and can only add their own on top.

You can also limit which plugin types tenants may create with the `workspace_plugin_types` setting.

## 6. Know what each tenant uses

```sh
apgctl usage --all-workspaces --group-by workspace --granularity day --from 2026-06-01
```

See [usage for billing](usage-billing.md).

## 7. When a tenant must stop

```sh
curl -X PATCH "$APG_ADMIN_URL/v1/workspaces/acme" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"status": "suspended"}'
```

Its traffic gets `403 WORKSPACE_SUSPENDED` on every node within a second or two. Deleting the workspace (`DELETE …?cascade=true`) removes everything in it.

## What is tested

The isolation rules are exercised end to end by `tests/e2e/security.js`: two tenants, and every way one might reach into the other through the API and through real nodes. Run it with `make e2e-security`.
