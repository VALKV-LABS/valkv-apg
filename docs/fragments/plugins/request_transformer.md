## When to use it

To change a request on its way to the upstream: add a header the upstream expects, drop one it must not see, rename a query parameter, set a field in a JSON body. Operations run in the order rename, remove, set, add. Values are templates.

## Examples

Tell the upstream which workspace and consumer the request belongs to, and remove an internal header clients might send:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.28:8080"
routes:
  - name: api
    service: api
    paths: [/api]
    plugins:
      - type: request_transformer
        config:
          headers:
            set:
              X-Tenant: "{{ workspace.slug }}"
              X-Caller: "{{ consumer.name | default(\"anonymous\") }}"
            remove: [X-Internal-Debug]
```

Adapt a legacy client: drop a query parameter, add another, and stamp the JSON body:

```yaml
version: 1
services:
  - name: orders
    backends:
      - target: "10.0.0.29:8080"
routes:
  - name: legacy-orders
    service: orders
    paths: [/legacy/orders]
    plugins:
      - type: request_transformer
        config:
          query:
            remove: [debug]
            add: { source: legacy }
          body:
            set:
              /meta/received_by: "{{ route.name }}"
            remove: [/debug]
```

## Bodies

Only JSON bodies are rewritten, and only up to `max_body_bytes`; a larger body passes unchanged and is counted in `apg_transform_skipped_total`. Body paths are JSON pointers (`/a/b`).

## Goes well with

`response_transformer` for the way back. See [template variables](../templates.md).
