# Threat model

What valkv-apg defends, against whom, and where it relies on you. It is organised by the four boundaries where trust changes.

## What is worth protecting

| Asset | Why |
|---|---|
| Private keys of certificates | Whoever has one can impersonate your sites |
| Credentials of consumers, admin tokens | Access to your APIs, and to the gateway's configuration |
| Plugin secrets (signing keys, shared secrets) | Forging tokens or callout calls |
| Configuration | Whoever can change routing can redirect traffic |
| One tenant's traffic, configuration and usage | Must stay invisible and untouchable to other tenants |
| Availability | The gateway is in front of everything |

## Boundary 1: clients to nodes

*An anonymous party on the internet sends anything it likes.*

| Threat | Defence |
|---|---|
| Malformed or ambiguous requests meant to confuse the gateway and an upstream differently | Requests are parsed strictly and re-serialised for the upstream rather than passed through as bytes. Paths are normalised before matching, and a path that climbs out of the root is refused with `400` |
| Forging identity towards an upstream | `X-Apg-*` headers from a client are discarded and rewritten. Credentials are removed before forwarding |
| Forging the client address | `X-Forwarded-For` is believed only from addresses in `APG_TRUSTED_PROXIES` |
| Guessing credentials | API keys are long and random; passwords are verified with argon2id; failures do not say which check failed. Add `rate_limit` by address in front of authentication for a ceiling on attempts |
| Exhausting the gateway | Size limits, rate limits, bounded caches and counters, timeouts on every upstream phase. Counters keyed by request data are dropped when idle, so they cannot grow without bound |
| Reading secrets from responses or logs | The access log never holds header values; sensitive query parameters are masked; error bodies are fixed text |
| Downgrade | A minimum TLS version; HTTP redirects to HTTPS by default |

**Left to you:** volumetric denial of service (use a network-level service in front), application-layer attacks on your own services, and bots. The gateway is not a web application firewall.

## Boundary 2: nodes to the control plane

*A node is exposed to the internet and may be compromised. The control plane must survive that.*

| Threat | Defence |
|---|---|
| A stolen node token used to change configuration | A node token opens the node feed only. It cannot read or write through the Admin API |
| A compromised node learning credentials | Nodes receive only hashes of keys and passwords |
| A compromised node learning private keys | It does: a node must hold the keys of the certificates it serves, and the secret key that opens them. This is inherent in terminating TLS |
| Someone on the network reading or altering the feed | Serve the control plane over TLS. Nodes can present a client certificate (`APG_CONFIG_CLIENT_CERT`) and verify the server against a private CA |
| A node pointed at the wrong control plane serving the wrong configuration | A cache is tied to the control plane's identity; a different identity discards it |
| The control plane sending something a node cannot understand | The node skips it and keeps serving |

**Consequence to plan for:** a compromised node means every private key and plugin secret is compromised. Revoke and reissue certificates, rotate plugin secrets and the secret key, and replace the node token.

## Boundary 3: the control plane to Postgres

*Someone obtains a copy of the database: a backup, a snapshot, a replica.*

| Threat | Defence |
|---|---|
| Reading private keys and plugin secrets | Stored encrypted (AES-256-GCM) under `APG_SECRET_KEY`, which is not in the database. Each value is bound to the resource it belongs to, so a ciphertext cannot be moved to another |
| Reading credentials | API keys and tokens are SHA-256 hashes of high-entropy values; passwords are argon2id hashes |
| Reading secrets from the audit log, the change feed or stored revisions | Secrets are masked in the audit log, ciphertext in the feed, and sealed in revisions. A test writes distinctive secrets through every door and searches every table for them |
| Altering configuration directly | Not defended. Whoever can write to the database controls the gateway. Restrict it to the control plane |

**Left to you:** keeping the secret key away from the database and its backups.

## Boundary 4: tenant to tenant

*A tenant holds a valid, scoped token and is hostile.*

| Threat | Defence |
|---|---|
| Reading another tenant's configuration | Every lookup is scoped to the caller's workspaces. Anything outside reads as "not found", in the same words as something that does not exist |
| Routing another tenant's traffic | A tenant's route must name hosts covered by an active domain of its own workspace. A host can be claimed once, and proof by DNS record can be required |
| Shadowing an operator route | System routes are matched first, always |
| Using its credentials on another tenant's API | A credential is valid in its own workspace and on system routes only |
| Draining another tenant's rate limit, or reading its cached responses | Every limit counter and cache entry is keyed by workspace |
| Reaching the operator's internal network through the gateway | Backend and callout addresses that resolve to private, loopback or link-local ranges are refused when written, and again by the node at connection time |
| Reading the node's environment through templates | Templates can read only variables the operator listed |
| Exhausting the control plane | Per-caller rate limit on the Admin API; per-workspace limits on the number of resources |
| Escalating its own role | Roles come from the token. Token management, settings, flags and workspaces need a fleet-wide admin |

These are exercised end to end by the security suite (`make e2e-security`).

## The console

| Threat | Defence |
|---|---|
| Stealing a session from a script | The session cookie is HttpOnly. The admin token is exchanged for it and not kept in the browser |
| Cross-site request forgery | SameSite=Strict cookie, and a CSRF token required on every change |
| Clickjacking | Framing is refused unless you list an origin |
| Injected script | A content policy that allows scripts only from the console's own origin; no inline script |
| A secret shown twice | A generated key or token is in the one response that creates it, and nowhere after |

## Known limits

- No certificate revocation checking for client certificates.
- Limits are per node, so a distributed caller can exceed a configured rate by a factor of the node count.
- A bulk re-encryption command for rotating the secret key does not exist yet; see the [runbook](runbooks.md#rotating-the-secret-key).
- The project has had no independent security review.

## Reporting a vulnerability

Privately, through the repository's security advisories. See `SECURITY.md`.
