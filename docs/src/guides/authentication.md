# Authentication

Five plugins answer "who is calling?". Pick by what your callers already have.

| Callers have | Plugin | The gateway stores |
|---|---|---|
| Nothing yet; they are programs | [`key_auth`](../reference/plugins/key_auth.md) | A hash of each key |
| A browser, or only user name and password | [`basic_auth`](../reference/plugins/basic_auth.md) | An argon2id hash of each password |
| A token from an identity provider | [`jwt_auth`](../reference/plugins/jwt_auth.md) | Nothing; it verifies signatures |
| A client certificate | [`mtls_auth`](../reference/plugins/mtls_auth.md) | The identity each certificate must carry |
| A session your own service understands | [`forward_auth`](../reference/plugins/forward_auth.md) | Nothing; it asks your service |

## Consumers

A *consumer* is a caller with a name. Credentials belong to consumers, and so do groups:

```yaml
version: 1
consumers:
  - name: mobile-app
    custom_id: app-7421
    groups: [first-party]
    credentials:
      - name: production
        type: key
        key: { $env: APG_SECRET_MOBILE_KEY }
  - name: reporting-job
    groups: [internal]
    credentials:
      - name: login
        type: basic
        username: reporting
        password: { $env: APG_SECRET_REPORTING_PASSWORD }
```

Once a request is authenticated, your upstream is told who it is with `X-Apg-Consumer-Id`, `X-Apg-Consumer-Name` and (if set) `X-Apg-Consumer-Custom-Id`. The credential itself is not forwarded. Clients cannot set these headers themselves.

Everything else that speaks of consumers then works: `acl` by group, limits per consumer, usage per consumer, a plugin instance for one consumer only.

## Issuing and rotating keys

With a control plane, create a credential without a key and one is generated and shown once:

```sh
curl -X POST "$APG_ADMIN_URL/v1/workspaces/default/consumers/mobile-app/credentials" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "2026-06", "type": "key"}'
# { "name": "2026-06", "key_prefix": "apg_k_Ab", "key": "apg_k_Ab…", … }
```

Only a hash is kept. Afterwards the API shows the first characters (`key_prefix`), enough to tell keys apart.

To rotate: add a second credential, move the caller to it, delete the first. A consumer can hold any number of credentials, each with an optional `expires_at`.

## Tokens from an identity provider

`jwt_auth` checks the signature against the provider's published keys, then issuer, expiry and audience. It does not need consumers at all: use `claims_to_headers` to hand the upstream what it needs from the token.

If you want limits and access rules per caller, map tokens to consumers with `consumer_claim`: the claim's value is looked up as a consumer's `custom_id` or name.

## Accepting more than one kind of credential

Two authentication plugins on one route both have to pass. To accept either, give each an `anonymous` consumer and deny that consumer's group afterwards; the [basic_auth page](../reference/plugins/basic_auth.md) has the complete example.

## Who may do what

Authentication says who. For what they may do:

- [`acl`](../reference/plugins/acl.md): allow or deny by group.
- [`ip_restriction`](../reference/plugins/ip_restriction.md): by network, before authentication.
- Anything finer belongs in your service, or in a [callout service](callout-plugin.md).

## Across workspaces

A credential works on routes of its own workspace and on routes of the system workspace. It is never valid on another tenant's routes, even when two tenants have a consumer of the same name.

## What a failure looks like

`401 UNAUTHENTICATED` for a missing or wrong credential, `403 FORBIDDEN` when the consumer is known but not allowed. The message never says which check failed. Both carry `X-Apg-Error`, so you can tell them from a 401 of your own upstream.
