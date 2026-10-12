## When to use it

To change logging for part of your traffic: silence a noisy health-check route, sample a very busy one, or add fields of your own to its lines. The destination of the access log is set once for the gateway, by the `access_log` setting; this plugin adjusts it per scope.

## Examples

Do not log health checks:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.38:8080"
routes:
  - name: health
    service: api
    paths:
      - { type: exact, value: /healthz }
    plugins:
      - type: access_log
        config:
          enabled: false
```

Log one request in a hundred on a busy route, with the workspace and the API version on each line:

```yaml
version: 1
services:
  - name: events
    backends:
      - target: "10.0.0.39:8080"
routes:
  - name: ingest
    service: events
    paths: [/ingest]
    plugins:
      - type: access_log
        config:
          sample_rate: 0.01
          custom_fields:
            tenant: "{{ workspace.slug }}"
            api_version: "{{ request.header.x-api-version | default(\"1\") }}"
```

## What is logged

One JSON line per request: time, request id, trace id, method, host, path, status, sizes, durations, route, service, backend, workspace, consumer, client address, retries, cache result, error code. Header values are never logged. See [observability](../../guides/observability.md).
