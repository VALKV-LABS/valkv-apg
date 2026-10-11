## When to use it

To answer from the gateway itself: a maintenance page, a canned answer while an upstream is being built. The body is a template.

## Examples

A maintenance page for one route:

```yaml
version: 1
services:
  - name: shop
    backends:
      - target: "10.0.0.27:8080"
routes:
  - name: checkout
    service: shop
    paths: [/checkout]
    plugins:
      - type: static_response
        config:
          status: 503
          content_type: text/html
          headers:
            Retry-After: "600"
          body: "<h1>Back soon</h1><p>Reference {{ request.id }}</p>"
```

A mock of an endpoint that does not exist yet:

```yaml
version: 1
services:
  - name: placeholder
    backends:
      - target: "127.0.0.1:9"
routes:
  - name: mock-profile
    service: placeholder
    paths:
      - { type: exact, value: /profile }
    plugins:
      - type: static_response
        config:
          status: 200
          content_type: application/json
          body: '{"id": "demo", "host": "{{ request.host }}"}'
```

## What clients see

Exactly what you configured. The route's service is never contacted. Plugins that run earlier (authentication, limits) still apply, so a mock can be protected like the real thing.
