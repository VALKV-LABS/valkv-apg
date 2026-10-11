# What valkv-apg is

valkv-apg is an API gateway: it sits in front of your services, terminates TLS, decides which service a request goes to, and applies what you configure on the way: authentication, rate limits, transformations, caching.

It is built for platforms that serve many tenants from one gateway, and it stays simple when you have one.

## What sets it apart

- **It runs alone.** One binary and one YAML file are a complete gateway. No database, no control plane.
- **It also runs as a fleet.** Add the control plane and Postgres, and you manage many gateways through an API, a console and a command-line client. Gateways keep serving if the control plane or the database goes away.
- **Tenants are a first-class thing.** A *workspace* owns its domains, routes, services and consumers. One workspace cannot route another's host, use another's key, or see another's configuration.
- **Nothing is accepted and then ignored.** A setting the gateway does not act on is refused when you write it, in a file and through the API alike.
- **Configuration is data.** The same document works in a file and through the API. You can review a change before applying it, see every revision, and go back.

## The pieces

| Piece | What it is | You need it |
|---|---|---|
| The gateway (`valkv-apg`, "node") | Serves traffic | Always |
| The control plane (`valkv-apg-admin`) | Admin API, console, and the configuration feed nodes read | To manage configuration through an API |
| Postgres | Where the control plane keeps configuration | With the control plane |
| `apgctl` | Command-line client | When you keep configuration in files and apply it from CI |

## Where to start

- To learn what it does, feature by feature: the [product guide](product-guide.md).
- To see how the parts fit together: [architecture and components](architecture.md).
- To see it work: [a gateway from one file, in five minutes](getting-started/standalone.md).
- To run it for a team: [with a control plane and the console](getting-started/control-plane.md).
- To understand it first: [architecture and the two modes](concepts/architecture.md).
- If you know another gateway: [coming from another gateway](guides/coming-from-other-gateways.md) has a map of terms and an honest list of what is and is not here.

## Status

valkv-apg has not had a stable release yet. Every page of this documentation describes what is built and tested; where something is planned but not built, the page says so.
