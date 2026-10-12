# 6. System routes are matched before any tenant's

Status: accepted

## Context

On a gateway shared by tenants, the operator has routes of its own: a platform API, a status page, a default answer. Tenants write routes too. If all routes competed in one ordering, a tenant could give a route a high priority, or a more specific path, and take traffic meant for an operator route.

## Decision

Routes are matched in two tiers. Routes of the system workspace are tried first, in their own order. Only when none of them matches are tenant routes considered, and then only those of the workspace that owns the request's host.

## Consequences

- A tenant can never shadow an operator route, whatever priority it sets.
- A tenant can never match a host it does not own, because its routes are not even candidates for other hosts.
- The operator must take care with catch-all system routes: a system route for `/` on every host takes everything, and tenants get nothing. A catch-all belongs on a specific host.
- Looking up a route costs the size of one host's routes, not of all routes, since tenants' routes are indexed by workspace and host.
- The route tester reports the tier of each candidate, so that "why did the operator's route win" has a direct answer.
