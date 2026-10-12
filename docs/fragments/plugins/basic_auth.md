## When to use it

For people with browsers and for old clients that can only send a user name and a password. Passwords are stored as argon2id hashes. Use it over TLS only: the password travels with every request.

## Examples

A staging site behind a password:

```yaml
version: 1
services:
  - name: staging
    backends:
      - target: "10.0.0.5:8080"
routes:
  - name: staging-site
    service: staging
    hosts: [staging.example.com]
    plugins:
      - type: basic_auth
        config:
          realm: Staging
consumers:
  - name: qa-team
    credentials:
      - name: login
        type: basic
        username: qa
        password: { $env: APG_SECRET_QA_PASSWORD }
```

Accept either a password or an API key on the same route:

```yaml
version: 1
services:
  - name: reports
    backends:
      - target: "10.0.0.6:8080"
routes:
  - name: reports
    service: reports
    paths: [/reports]
    plugins:
      - type: basic_auth
        config: { anonymous: nobody }
      - type: key_auth
        config: { anonymous: nobody }
      - type: acl
        config: { deny: [unauthenticated] }
consumers:
  - name: nobody
    groups: [unauthenticated]
  - name: analyst
    credentials:
      - name: login
        type: basic
        username: analyst
        password: { $env: APG_SECRET_ANALYST_PASSWORD }
```

## What clients and upstreams see

- No credentials: `401 UNAUTHENTICATED` with `WWW-Authenticate: Basic realm="…"`, which makes a browser ask.
- Valid credentials: the upstream gets `X-Apg-Consumer-Id` and `X-Apg-Consumer-Name`; the `Authorization` header is not forwarded unless `hide_credentials` is `false`.

## Goes well with

`acl`, and `ip_restriction` when the password alone is not enough.
