## When to use it

After an authentication plugin, to let only some groups of consumers through. A consumer's groups are listed on the consumer. `deny` wins over `allow`.

## Examples

Only partners may use the partner API:

```yaml
version: 1
services:
  - name: partners
    backends:
      - target: "10.0.0.13:8080"
routes:
  - name: partner-api
    service: partners
    paths: [/partner]
    plugins:
      - type: key_auth
      - type: acl
        config:
          allow: [partners]
consumers:
  - name: acme
    groups: [partners]
    credentials:
      - name: key
        type: key
        key: { $env: APG_SECRET_ACME_KEY }
```

Everyone with a key, except consumers that have been suspended:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.14:8080"
routes:
  - name: api
    service: api
    paths: [/v1]
    plugins:
      - type: key_auth
      - type: acl
        config:
          deny: [suspended]
consumers:
  - name: late-payer
    groups: [suspended]
```

## What clients see

- A consumer that is not allowed: `403 FORBIDDEN`.
- No consumer at all (no authentication plugin ran, or it found nobody): `401 UNAUTHENTICATED`.

## Goes well with

Any authentication plugin. Suspending a consumer by adding it to a denied group takes effect on every node within a second or two.
