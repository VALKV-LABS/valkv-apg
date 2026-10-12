## When to use it

When browsers on another origin call your API. The gateway answers preflight (`OPTIONS`) requests itself, without asking the upstream, and adds the CORS headers to every response, including refusals from other plugins, so the browser shows the real error instead of a CORS failure.

## Examples

One web application may call the API, with cookies:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.17:8080"
routes:
  - name: api
    service: api
    paths: [/api]
    plugins:
      - type: cors
        config:
          origins: ["https://app.example.com"]
          credentials: true
          expose_headers: [X-Total-Count]
```

A public, read-only API that any site may call:

```yaml
version: 1
services:
  - name: catalogue
    backends:
      - target: "10.0.0.18:8080"
routes:
  - name: catalogue
    service: catalogue
    paths: [/catalogue]
    plugins:
      - type: cors
        config:
          origins: ["*"]
          methods: [GET, HEAD]
          max_age: 86400
```

## What clients see

- A preflight from an allowed origin is answered by the gateway with `Access-Control-Allow-Origin`, `-Methods`, `-Headers` and `-Max-Age`.
- An origin that is not listed gets no CORS headers, and the browser blocks the call.

## Goes well with

Authentication plugins: preflight requests carry no credentials, and this plugin runs before them so that preflights are not refused.
