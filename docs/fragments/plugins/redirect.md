## When to use it

To send clients somewhere else without an upstream: a moved path, a retired host. Whatever part of the address you leave out is kept from the request.

## Examples

A host that has moved, keeping path and query:

```yaml
version: 1
services:
  - name: placeholder
    backends:
      - target: "127.0.0.1:9"
routes:
  - name: old-host
    service: placeholder
    hosts: [old.example.com]
    plugins:
      - type: redirect
        config:
          status: 301
          scheme: https
          host: www.example.com
```

A path that has moved, written with a template:

```yaml
version: 1
services:
  - name: placeholder
    backends:
      - target: "127.0.0.1:9"
routes:
  - name: v1-moved
    service: placeholder
    paths: [/v1]
    plugins:
      - type: redirect
        config:
          status: 308
          path: "/v2{{ request.path }}"
          preserve_query: true
```

## What clients see

The chosen status with a `Location` header. The route's service is never contacted; a route still needs one, so point it at any service.
