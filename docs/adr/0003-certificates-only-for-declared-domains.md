# 3. Certificates are issued only for declared domains

Status: accepted

## Context

A gateway that obtains certificates automatically could do so for any host name a client asks for in a TLS handshake ("on-demand" issuance). That is convenient, and it lets anyone on the internet make the gateway request certificates for names of their choosing, exhausting the authority's rate limits or issuing for names the operator never meant to serve.

## Decision

A certificate is requested only for a Domain resource, or for a base domain the operator configured. Never for a host name seen in a handshake, and never for a host that merely appears on a route.

## Consequences

- Issuance cannot be triggered from outside. The set of names the gateway will ever ask a certificate for is what is in its configuration.
- A new customer domain needs one explicit step, creating the domain, before it has a certificate.
- With domain verification on, a tenant must also prove control of the name before a certificate is requested for it.
- For a host with no certificate the gateway presents its fallback certificate rather than failing the handshake.
