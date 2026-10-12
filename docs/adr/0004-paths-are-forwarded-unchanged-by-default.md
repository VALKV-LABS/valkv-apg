# 4. A route forwards the path unchanged unless told otherwise

Status: accepted

## Context

When a route matches `/orders` and the request is for `/orders/17`, the upstream can be sent `/orders/17` or `/17`. The code this project grew out of removed the matched prefix by default. People are regularly surprised by that: the upstream receives a path nobody wrote anywhere.

## Decision

`strip_path` is `false` by default. The upstream receives the path the client sent, normalised. Removing the prefix, or rewriting the path, is something a route asks for.

## Consequences

- A route with nothing but a service and a path behaves as a reader of the configuration expects.
- Putting a service behind a prefix it does not know about needs `strip_path: true` or a `rewrite` on the route.
- Configuration moved over from a gateway with the other default must set `strip_path` explicitly where it relied on it.
