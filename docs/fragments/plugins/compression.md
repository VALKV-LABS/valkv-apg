## When to use it

When upstreams send text (JSON, HTML, CSS) uncompressed. The gateway compresses it for clients that say they accept it. Responses that are already encoded, and small ones, are left alone.

## Examples

Defaults for a whole workspace:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.34:8080"
routes:
  - name: api
    service: api
    paths: [/]
plugins:
  - type: compression
    scope: workspace
```

Only gzip, and only above a kilobyte:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.35:8080"
routes:
  - name: reports
    service: api
    paths: [/reports]
    plugins:
      - type: compression
        config:
          algorithms: [gzip]
          min_bytes: 1024
```

## What clients see

`Content-Encoding` when a response was compressed. A client that sends no `Accept-Encoding` gets the response as the upstream sent it.
