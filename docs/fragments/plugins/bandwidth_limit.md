## When to use it

To cap bytes instead of requests: downloads, media, large exports. A request is admitted while the budget is not exhausted, and what it actually transferred is taken from the budget afterwards, so one large response can overdraw it and the next request waits.

## Examples

Five megabytes a second for each consumer of a download service:

```yaml
version: 1
services:
  - name: downloads
    backends:
      - target: "10.0.0.25:8080"
routes:
  - name: downloads
    service: downloads
    paths: [/files]
    plugins:
      - type: key_auth
      - type: bandwidth_limit
        config:
          bytes_per_second: 5000000
          burst_bytes: 50000000
          scope: consumer
```

One budget for a whole workspace:

```yaml
version: 1
services:
  - name: media
    backends:
      - target: "10.0.0.26:8080"
routes:
  - name: media
    service: media
    paths: [/media]
plugins:
  - type: bandwidth_limit
    scope: workspace
    config:
      bytes_per_second: 20000000
      burst_bytes: 200000000
      scope: workspace
```

## What clients see

`429 BANDWIDTH_LIMIT_EXCEEDED` while the budget is overdrawn. A response already in progress is never cut short.
