## When to use it

For responses that are the same for many callers and do not change every second. They are kept in the node's memory and served again without asking the upstream. Each node has its own cache, bounded by `APG_CACHE_MEMORY_BYTES`.

## Examples

Cache a catalogue for a minute, separately per language:

```yaml
version: 1
services:
  - name: catalogue
    backends:
      - target: "10.0.0.32:8080"
routes:
  - name: catalogue
    service: catalogue
    paths: [/catalogue]
    plugins:
      - type: response_cache
        config:
          ttl_secs: 60
          vary_headers: [Accept-Language]
```

Cache per consumer on an authenticated route, and ignore the upstream's own cache headers:

```yaml
version: 1
services:
  - name: dashboard
    backends:
      - target: "10.0.0.33:8080"
routes:
  - name: dashboard
    service: dashboard
    paths: [/dashboard]
    plugins:
      - type: key_auth
      - type: response_cache
        config:
          ttl_secs: 15
          cache_authenticated: true
          respect_cache_control: false
```

## What clients see

`X-Apg-Cache: MISS` when the upstream was asked and the answer stored, `HIT` when a stored answer was served, `BYPASS` when the request was not eligible.

## What is and is not cached

- Only the listed `methods` (GET and HEAD by default) and `statuses`.
- A request with credentials (an `Authorization` header, or an authenticated consumer) bypasses the cache unless `cache_authenticated` is true; then each consumer has its own entries.
- The key includes the workspace, the route, the host, the path, the query (in any order) and the `vary_headers`. One workspace is never served another's response.
- To empty a route's entries on every node: `apgctl cache purge <route>`.
