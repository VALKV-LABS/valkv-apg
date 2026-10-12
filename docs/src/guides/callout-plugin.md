# Writing a callout service

When no built-in plugin does what you need, write a small HTTP service and let the gateway consult it with [`http_callout`](../reference/plugins/http_callout.md). You can write it in any language; it never needs to be loaded into the gateway.

## What the gateway sends

A `POST` with a JSON body describing the request. For the `request` phase:

```json
{
  "phase": "request",
  "request": {
    "id": "01a1290b-27a2-75e2-aa95-15d0ca70c83f",
    "method": "POST",
    "scheme": "https",
    "host": "api.example.com",
    "path": "/payments",
    "query": "currency=eur",
    "client_ip": "203.0.113.9",
    "headers": { "user-agent": "…", "x-tenant": "acme" }
  },
  "workspace_id": "0193f2a0-…",
  "route": { "id": "0193f2a1-…", "name": "payments" },
  "consumer": { "id": "0193f2a2-…", "name": "mobile-app" }
}
```

`consumer` is `null` when nobody was authenticated. Header names are lower-case; `Authorization` and `Cookie` are left out unless the plugin's `include_headers` lists them. For the `response` phase the same, plus `"response": { "status": 200, "headers": { … } }`.

Bodies are not included. The exact shapes are the JSON Schemas `schemas/callout-request.json` and `schemas/callout-response.json` in the repository.

## What you answer

Status 200 and a JSON body:

| To | Answer |
|---|---|
| let it continue | `{}` |
| change headers and continue | `{ "set_headers": { "X-Risk": "low" }, "remove_headers": ["X-Debug"] }` |
| answer the client yourself | `{ "action": "respond", "status": 403, "headers": { "content-type": "application/json" }, "body": "{\"error\":\"blocked\"}" }` |

In the request phase, headers you set are sent to the upstream. In the response phase, they are sent to the client.

Anything else (another status, a body that is not valid JSON, no answer within `timeout_ms`) counts as a failure: the client gets `500 PLUGIN_ERROR`, or the request continues untouched if the plugin has `fail_open: true`.

## A complete service

```js
// callout.js: refuse payments above a limit unless the caller is trusted.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.CALLOUT_SECRET;

function signed(header, body) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const want = createHmac("sha256", SECRET).update(`${m[1]}.${body}`).digest("hex");
  return want.length === m[2].length && timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!signed(req.headers["x-apg-signature"], body)) return res.writeHead(401).end();
    const call = JSON.parse(body);
    const trusted = call.consumer?.name === "treasury";
    const amount = Number(new URLSearchParams(call.request.query).get("amount") ?? 0);
    const answer = amount > 10000 && !trusted
      ? { action: "respond", status: 403, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "amount needs approval" }) }
      : { set_headers: { "X-Checked-By": "payments-rules" } };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
}).listen(8080);
```

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
      - type: key_auth
      - type: http_callout
        config:
          url: https://rules.example.com/check
          phases: [request]
          timeout_ms: 300
          secret: { $env: APG_SECRET_CALLOUT_SIGNING }
```

## Verify the signature

With `secret` set, each call carries `X-Apg-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Check it, as above, and refuse calls with an old timestamp. Without that, anyone who can reach your service can ask it questions.

## Keep it fast

Your service is on the path of every request to the route. Set `timeout_ms` to what you can honour, and decide deliberately between `fail_open: true` (your service being down must not take the API down) and the default (nothing passes unchecked).

`http_callout` runs after authentication and limits, so your service sees only requests that already passed them, and knows the consumer.

## When a callout is the wrong tool

- To decide only "may this request pass?" from a cookie or header, [`forward_auth`](../reference/plugins/forward_auth.md) is simpler and can cache answers.
- To add or remove fixed headers, use the transformers.
- To inspect or rewrite bodies: not possible with a callout today.

Plugins loaded into the gateway itself (WebAssembly) are planned and not built.
