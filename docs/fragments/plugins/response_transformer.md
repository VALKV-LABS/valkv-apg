## When to use it

To change what the upstream answered before the client sees it: add security headers, hide a header that reveals the stack, set or remove a field in a JSON body.

## Examples

Security headers on every response of a workspace, and no `Server` header:

```yaml
version: 1
services:
  - name: site
    backends:
      - target: "10.0.0.30:8080"
routes:
  - name: site
    service: site
    paths: [/]
plugins:
  - type: response_transformer
    scope: workspace
    config:
      headers:
        set:
          Strict-Transport-Security: "max-age=31536000"
          X-Content-Type-Options: nosniff
        remove: [Server, X-Powered-By]
```

Remove an internal field from JSON answers and say which route served them:

```yaml
version: 1
services:
  - name: users
    backends:
      - target: "10.0.0.31:8080"
routes:
  - name: users
    service: users
    paths: [/users]
    plugins:
      - type: response_transformer
        config:
          body:
            remove: [/internal_notes]
            set:
              /served_by: "{{ route.name }}"
```

## Bodies

Only JSON bodies are rewritten, up to `max_body_bytes`. A larger or non-JSON body passes unchanged.
