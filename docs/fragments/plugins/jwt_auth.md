## When to use it

When callers already hold a signed token from an identity provider. The gateway checks the signature, the issuer, the expiry and (when you list any) the audience, so your upstream does not have to. A token can also be mapped to a consumer, so limits and access rules written for consumers apply.

## Examples

Verify tokens against the provider's published keys, and pass two claims to the upstream as headers:

```yaml
version: 1
services:
  - name: accounts
    backends:
      - target: "10.0.0.7:8080"
routes:
  - name: accounts-api
    service: accounts
    paths: [/accounts]
    plugins:
      - type: jwt_auth
        config:
          issuer: https://login.example.com/
          jwks_url: https://login.example.com/.well-known/jwks.json
          audiences: [accounts-api]
          claims_to_headers:
            sub: X-User-Id
            tenant: X-Tenant
```

Tokens signed with a shared secret, each mapped to a consumer by its `sub` claim:

```yaml
version: 1
services:
  - name: partners
    backends:
      - target: "10.0.0.8:8080"
routes:
  - name: partner-api
    service: partners
    paths: [/partner]
    plugins:
      - type: jwt_auth
        config:
          issuer: partner-portal
          algorithms: [HS256]
          secret: { $env: APG_SECRET_PARTNER_JWT }
          consumer_claim: sub
          leeway_secs: 10
consumers:
  - name: acme
    custom_id: acme-corp
```

## What clients and upstreams see

- A missing, expired, wrongly signed or wrongly addressed token: `401 UNAUTHENTICATED`. The message does not say which check failed.
- The key set cannot be fetched and no copy is held yet: `503 AUTH_UNAVAILABLE`. Once fetched, the copy keeps being used while the provider is unreachable.
- Tokens with `alg: none`, or an algorithm you did not list, are refused.

## Goes well with

`acl` once tokens are mapped to consumers; `rate_limit` with `scope: consumer`. Keys published at `jwks_url` are fetched again after `jwks_cache_secs`, and at once (at most every 30 seconds) when a token names a key the copy does not hold.
