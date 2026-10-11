# Workspaces and who owns a host

A workspace is a tenant: a customer, a team, an environment. Everything a tenant configures lives in its workspace, and the gateway guarantees that tenants cannot reach into each other.

## The system workspace

There is always a workspace named `default`. It is the *system workspace*, for the operator of the gateway. Its routes are tried before any tenant's, may match any host, and may have no host at all. If you have no tenants, you only ever use this one.

## What a tenant can and cannot do

A tenant is whoever holds a token scoped to one workspace (see [roles](../guides/multi-tenant.md)). Within its workspace it can create domains, services, routes, consumers and plugins. The gateway holds it to these rules:

| Rule | What it prevents |
|---|---|
| A route must name at least one host, and each host must be covered by an active domain of the same workspace | Routing someone else's traffic |
| A host name can be claimed by one workspace only | Two tenants answering for one name |
| A consumer's credential works on routes of its own workspace, and on system routes | A key from tenant A opening tenant B's API |
| Every limit bucket and every cache entry includes the workspace | One tenant using up another's rate limit, or being served another's cached response |
| A resource in another workspace reads as "not found", with the same words as one that does not exist | Learning what other tenants have |
| A backend or a callout address may not be private unless the operator allows the range | Pointing the gateway at the operator's internal network |

These are enforced when configuration is written and again by the nodes when they serve.

## How a host gets an owner

A request's host decides which tenant's routes are considered.

1. **A domain.** A workspace creates a domain for `api.acme.com` (or `*.acme.com`). If the operator has turned on domain verification, the domain stays *pending* until a DNS record proves control of the name.
2. **A base domain.** The operator sets `workspace_base_domains`, for example `apps.example.com`. Every workspace then owns `<its slug>.apps.example.com` without creating anything. This is how a platform gives each customer a working address on day one.

## How a request finds its route

1. System routes are tried first, in order of priority and then of how specific they are.
2. If none matches, the host's owner is looked up, and only that workspace's routes are tried.
3. If nothing matches: `404 NO_ROUTE`.

So a tenant can never shadow an operator route, and a host nobody owns reaches system routes only.

The route tester (in the console, or `apgctl route match`) shows exactly this for any request: which route wins and why each other one did not.

## Suspending a tenant

Set a workspace's status to `suspended`. Within a second or two every node answers its traffic with `403 WORKSPACE_SUSPENDED`. Its configuration is kept; set the status back to `active` to resume.

## Limits per workspace

A workspace can be capped in how many routes, services, domains and consumers it may hold. Creating one more is refused with `LIMIT_EXCEEDED`.

## Shared services

A service in the system workspace can be marked `shared`. Any workspace may then route to it by name. Use it for an upstream every tenant uses, so that each tenant does not need (and cannot misconfigure) its own copy.
