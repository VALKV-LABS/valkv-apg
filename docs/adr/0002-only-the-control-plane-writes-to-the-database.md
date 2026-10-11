# 2. Only the control plane talks to Postgres

Status: accepted

## Context

Nodes face the internet. The database holds every tenant's configuration and every encrypted secret. A node that held a database connection would give whoever compromised it a path to all of that, and would make nodes depend on the database being reachable.

## Decision

The control plane is the only reader and writer of Postgres. Nodes get configuration by asking the control plane for changes, and send usage, heartbeats and certificate coordination through the same API. A node token opens that API and nothing else.

## Consequences

- A compromised node cannot read or change the database.
- Nodes serve through a database outage, and through a control-plane outage, from memory and from their cache on disk.
- The control plane can be upgraded, moved or restored without touching nodes; they notice a different control plane by its identity and resynchronise.
- Everything nodes need must be expressible as an entry in the change feed, which is therefore a versioned contract.
- A change reaches nodes a little later than a direct database subscription would deliver it. Measured, it is well under a second, which is why the direct mode that was specified has not been built.
