# A first route with a key and a rate limit

This page protects a route with an API key and limits each key holder to a few requests a second. It works the same in a file and with a control plane; both are shown.

## The configuration

```yaml
version: 1
services:
  - name: echo
    backends:
      - target: "echo:8080"
routes:
  - name: orders
    service: echo
    paths: [/orders]
    plugins:
      - type: key_auth
      - type: rate_limit
        config:
          per_second: 2
          burst: 5
          scope: consumer
consumers:
  - name: mobile-app
    credentials:
      - name: main
        type: key
        key: { $env: APG_SECRET_MOBILE_KEY }
```

Three things are new:

- **A consumer** is a caller you can name: an application, a partner, a team. `mobile-app` has one credential, an API key.
- **`key_auth`** on the route refuses requests that carry no valid key, and tells the upstream which consumer is calling.
- **`rate_limit`** with `scope: consumer` gives each consumer its own bucket: two requests a second, with room for a burst of five.

The key itself is not in the file. `{ $env: APG_SECRET_MOBILE_KEY }` tells the gateway to read it from its environment; the name must start with `APG_SECRET_`.

## In a file

Start the gateway with the variable set:

```sh
docker run -d --name apg --network apg-try -p 8080:8080 \
  -v "$PWD/apg.yaml:/etc/apg/apg.yaml:ro" \
  -e APG_HTTP_MODE=proxy \
  -e APG_SECRET_MOBILE_KEY=a-long-random-key-0123456789 \
  valkvlabs/valkv-apg:latest
```

## With a control plane

The control plane stores only a hash of the key, so it must be given the key itself, not a reference to a node's environment. With `apgctl`, write `key: "${MOBILE_KEY}"` in the file instead; `apgctl` fills it in from your shell before sending:

```sh
export MOBILE_KEY=a-long-random-key-0123456789
apgctl diff -f apg.yaml      # what would change
apgctl apply -f apg.yaml
```

Or let the control plane generate a key: in the console, open the consumer, choose **Credentials**, **Add credential**, and leave the key empty. The key is shown once.

## Try it

```sh
curl -i http://localhost:8080/orders
# HTTP/1.1 401 Unauthorized
# X-Apg-Error: UNAUTHENTICATED

curl -i -H "X-Api-Key: a-long-random-key-0123456789" http://localhost:8080/orders
# HTTP/1.1 200 OK
```

In the echoed request you can see what the upstream was told: `x-apg-consumer-name: mobile-app`. The key is not passed on.

Now send ten requests quickly:

```sh
for i in $(seq 10); do
  curl -s -o /dev/null -w "%{http_code} " -H "X-Api-Key: a-long-random-key-0123456789" http://localhost:8080/orders
done
# 200 200 200 200 200 429 429 429 429 429
```

The first five use the burst; after that the bucket refills at two a second, and requests beyond it get `429` with `X-Apg-Error: RATE_LIMITED` and a `Retry-After` header.

## Why the order does not matter

`rate_limit` is written after `key_auth`, but the order in the file is not what decides. Each plugin type has a priority; authentication runs before limits, so the limit already knows the consumer. See [plugin scopes and order](../concepts/plugins.md).

## Next

- [Authentication](../guides/authentication.md): passwords, tokens, client certificates, your own service
- [Rate limits, quotas and bandwidth](../guides/limits.md)
- Every plugin: [reference](../reference/plugins/index.md)
