## When to use it

To keep oversized uploads away from an upstream that would buffer them. A request that declares a larger body is refused before any of it is read; one that does not declare its size is cut off when it passes the limit.

## Examples

Small JSON bodies only:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.19:8080"
routes:
  - name: api
    service: api
    paths: [/api]
    plugins:
      - type: request_size_limit
        config:
          max_bytes: 65536
```

A tight limit for the whole workspace, and a larger one for the upload route:

```yaml
version: 1
services:
  - name: files
    backends:
      - target: "10.0.0.20:8080"
routes:
  - name: everything
    service: files
    paths: [/]
  - name: uploads
    service: files
    paths: [/uploads]
    plugins:
      - type: request_size_limit
        config:
          max_bytes: 104857600
plugins:
  - type: request_size_limit
    scope: workspace
    config:
      max_bytes: 1048576
```

## What clients see

`413 PAYLOAD_TOO_LARGE`.
