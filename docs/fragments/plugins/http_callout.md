## When to use it

For logic that is yours alone: a fraud check, a header computed from your database, a response judged by rules you keep elsewhere. The gateway describes the request (and, if asked, the response) to an HTTP service you write in any language, and does what the answer says.

## Examples

Ask a service before forwarding each request, with signed calls:

```yaml
version: 1
services:
  - name: payments
    backends:
      - target: "10.0.0.36:8080"
routes:
  - name: payments
    service: payments
    paths: [/payments]
    plugins:
      - type: http_callout
        config:
          url: https://rules.example.com/check
          phases: [request]
          timeout_ms: 300
          secret: { $env: APG_SECRET_CALLOUT_SIGNING }
```

Look at requests and responses, and let traffic through if the service is down:

```yaml
version: 1
services:
  - name: content
    backends:
      - target: "10.0.0.37:8080"
routes:
  - name: content
    service: content
    paths: [/content]
    plugins:
      - type: http_callout
        config:
          url: https://rules.example.com/inspect
          phases: [request, response]
          fail_open: true
```

## The contract

The service receives a JSON description of the request (schema `callout-request.json`) and answers with JSON (schema `callout-response.json`):

| Answer | Effect |
|---|---|
| `{}` | Continue unchanged |
| `{ "set_headers": {…}, "remove_headers": […] }` | Change headers, then continue |
| `{ "action": "respond", "status": 403, "headers": {…}, "body": "…" }` | Answer the client with this, and stop |

With `secret` set, each call carries `X-Apg-Signature: t=<unix time>,v1=<HMAC-SHA256 of "<t>.<body>">`; verify it to know the call came from your gateway. See [writing a callout service](../../guides/callout-plugin.md).

## What clients see

Whatever the service decides. If it cannot be reached or answers invalidly: `500 PLUGIN_ERROR`, unless `fail_open` is true.
