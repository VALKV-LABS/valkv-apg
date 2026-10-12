# Example configurations

| File | What it shows |
|---|---|
| [`simple.yaml`](simple.yaml) | The smallest useful gateway: one upstream with two backends and a health check, one route, an API key and a rate limit per caller. Start here. |
| [`full.yaml`](full.yaml) | Every plugin type, with the routing and upstream features around them: weighted and draining backends, hashing, health checks, the circuit breaker, timeouts and retries, a canary split, path rewriting, HTTP/2 and TLS to an upstream. A reference to copy from. |

Both are checked by the gateway itself whenever the documentation is checked (`make docs-check`), so they stay valid.

## Using one

Standalone, with the gateway reading the file:

```sh
export APG_SECRET_MOBILE_KEY=choose-a-long-random-key
docker run --rm -p 8080:8080 -p 8443:8443 \
  -v "$PWD/examples/simple.yaml:/etc/apg/apg.yaml:ro" \
  -e APG_HTTP_MODE=proxy -e APG_SECRET_MOBILE_KEY \
  valkv-labs/valkv-apg
```

With a control plane, the same file is applied through `apgctl`:

```sh
apgctl diff  -f examples/simple.yaml     # what would change
apgctl apply -f examples/simple.yaml
```

To check a file without running anything:

```sh
docker run --rm -v "$PWD/examples:/examples:ro" valkv-labs/valkv-apg validate --config /examples/simple.yaml
```

## What to change

- **Backend targets.** `host:port` as the gateway reaches it. For a gateway in a container, `localhost` is the container; see the note in the [observability guide](../docs/src/guides/observability.md#is-a-backend-up).
- **Host names** in `full.yaml` (`api.example.com` and the rest) to your own.
- **Secrets.** Values written as `{ $env: APG_SECRET_… }` are read from the gateway's environment, so they are never in the file. Set each one where the gateway runs.

Every key and its default is in the [configuration file reference](../docs/src/reference/configuration-file.md); each plugin has a page under [plugins](../docs/src/reference/plugins/index.md).
