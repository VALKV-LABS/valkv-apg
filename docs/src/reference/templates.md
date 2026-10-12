# Template variables

Some settings take text with placeholders that are filled in for each request: the values of `request_transformer` and `response_transformer`, the body of `static_response`, the path of `redirect`, custom fields of the access log, and custom error bodies.

```yaml
version: 1
services:
  - name: api
    backends:
      - target: "10.0.0.1:8080"
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
              X-Plan: "{{ consumer.labels.plan | default(\"free\") }}"
              X-Original-Host: "{{ request.host }}"
```

## Syntax

- `{{ name }}` is replaced by the variable's value. Spaces inside the braces are optional.
- `{{ name | default("text") }}` uses the text when the variable has no value or is empty. Single quotes work too.
- A variable with no value and no default becomes an empty string.
- There is nothing else: no expressions, no conditions, no loops, no other filters. Text outside placeholders is copied as it is.

A template is checked when the configuration is written. An unknown variable, an unclosed placeholder or an unsupported filter is refused then, with the place of the fault, rather than failing on every request.

## Variables

| Variable | Value |
|---|---|
| `request.id` | The request id |
| `request.method` | `GET`, `POST`, … |
| `request.scheme` | `http` or `https` |
| `request.host` | The host, lower case, without a port |
| `request.path` | The normalised path |
| `request.header.<name>` | A request header. Names are not case-sensitive |
| `request.query.<name>` | A query parameter |
| `client.ip` | The client's address |
| `workspace.id`, `workspace.name`, `workspace.slug` | The workspace the request belongs to |
| `consumer.id`, `consumer.name`, `consumer.custom_id` | The authenticated consumer; empty when there is none |
| `consumer.labels.<key>` | A label of the consumer |
| `route.id`, `route.name` | The matched route |
| `service.name` | The service the request is sent to |
| `jwt.claim.<name>` | A claim of the token verified by `jwt_auth` |
| `env.<NAME>` | An environment variable of the node, only if its name is listed in `APG_TEMPLATE_ENV_ALLOW` |

## Things to know

- Values are inserted as text. In a JSON body set by a transformer, the value becomes a JSON string.
- Header values that would break the header (line breaks) are refused by the node.
- `env.*` is off unless you list the variable names on the node. Do not list anything secret: a tenant who can write a template can read whatever is listed.
- Variables about the consumer are available to plugins that run after authentication, which is all of the ones above.
