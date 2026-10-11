# Plugin scopes and order

A plugin *type* is a capability the gateway has, such as `rate_limit`. A plugin *instance* is that capability with a configuration, attached somewhere.

## Where an instance can be attached

| Scope | Applies to | Who can create it |
|---|---|---|
| `route` | Requests matched by one route | Anyone who can edit the workspace |
| `service` | Requests forwarded to one service, by any route | Anyone who can edit the workspace |
| `workspace` | Every request of the workspace | Anyone who can edit the workspace |
| `global` | Every request through the gateway | Fleet administrators; it lives in the system workspace |

An instance can also be narrowed to one consumer (`consumer: mobile-app`). It then applies only to requests from that consumer.

## When several instances of one type could apply

Exactly one runs: the most specific.

1. An instance for the request's consumer beats one for everybody.
2. Then: route, before service, before workspace, before global.

So a workspace can set a default rate limit, one route can override it, and one consumer can have its own on that route:

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.1:8080"
routes:
  - name: search
    service: api
    paths: [/search]
    plugins:
      - type: key_auth
      - type: rate_limit
        config: { per_second: 5, burst: 10, scope: consumer }
      - type: rate_limit
        consumer: partner
        config: { per_second: 100, burst: 200, scope: consumer }
  - name: everything-else
    service: api
    paths: [/]
consumers:
  - name: partner
plugins:
  - type: rate_limit
    scope: workspace
    config: { per_second: 50, burst: 100, scope: ip }
```

On `/search`, `partner` gets 100 a second and every other consumer 5. On every other path the workspace's 50 a second per address applies.

Instances of *different* types do not compete: they all run.

To see what applies to a route, open it in the console (**Plugins and usage**), or call `GET /v1/workspaces/{ws}/routes/{route}/effective-plugins`. It lists, per type, the instance that runs, the ones that apply only to some consumers, and the ones that were overridden.

## The order they run in

Each type has a default priority; higher runs earlier. The order in which you wrote them does not matter.

| Priority | Type |
|---|---|
| 3000 | `ip_restriction` |
| 2900 | `cors` |
| 2800 | `request_size_limit` |
| 2500 to 2100 | `mtls_auth`, `jwt_auth`, `key_auth`, `basic_auth`, `forward_auth` |
| 2000 | `acl` |
| 1900 to 1700 | `rate_limit`, `quota`, `bandwidth_limit` |
| 1500 | `http_callout` |
| 1300, 1200 | `redirect`, `static_response` |
| 1100 | `request_transformer` |
| 1000 | `response_cache` |
| 900 | `response_transformer` |
| 800 | `compression` |
| 100 | `access_log` |

The reasoning: cheap refusals first; then find out who is calling; then decide whether they may and how much; then change the request; then deal with the response.

An instance can set its own `priority` to move within this order. Do that rarely: most surprising behaviour comes from an authentication plugin running after something that needed the consumer.

## Several ways to authenticate on one route

Put two authentication plugins on a route and a request must pass both. To accept *either*, give each an `anonymous` consumer: a plugin that finds no credential then lets the request continue as that consumer instead of refusing, and the request is authenticated if any of them recognised it. Add an `acl` that denies the anonymous consumer's group if at least one real credential is required. A credential that is present but wrong is always refused.

## Turning a type off everywhere

Each type has a flag, `plugin_<type>`. Set it to `false` and no instance of that type runs on any node, within a second or two. This is the emergency brake for a plugin that is misbehaving.

```sh
curl -X PUT "$APG_ADMIN_URL/v1/flags/plugin_response_cache" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

## What happens when a plugin fails

A plugin that guards a route (authentication, access control, limits) fails closed: if it cannot run, the request is refused with `500 PLUGIN_ERROR` rather than let through unchecked. Plugins that call another service (`forward_auth`, `http_callout`) have a `fail_open` setting for when you would rather serve than refuse.

## Values that are templates

Several plugins take values with placeholders, for example `"{{ request.header.x-tenant }}"`. See [template variables](../reference/templates.md).
