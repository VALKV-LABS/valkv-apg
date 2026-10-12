# A gateway from one file, in five minutes

You need Docker. Nothing else.

## 1. Write the configuration

Save this as `apg.yaml`. It says: there is a service called `echo` with one backend, and every request goes to it.

```yaml
version: 1
services:
  - name: echo
    backends:
      - target: "echo:8080"
routes:
  - name: everything
    service: echo
    paths: [/]
```

## 2. Start the gateway and something to route to

```sh
docker network create apg-try
docker run -d --name echo --network apg-try -e HTTP_PORT=8080 mendhak/http-https-echo:35
docker run -d --name apg --network apg-try -p 8080:8080 -p 8443:8443 \
  -v "$PWD/apg.yaml:/etc/apg/apg.yaml:ro" \
  -e APG_HTTP_MODE=proxy \
  valkv-labs/valkv-apg:latest
```

`APG_HTTP_MODE=proxy` makes the HTTP port serve requests. Without it, HTTP only redirects to HTTPS.

## 3. Send a request

```sh
curl http://localhost:8080/hello
```

The answer is the echo service's description of the request it received, including headers the gateway added: `X-Request-Id`, `X-Forwarded-For`, `X-Forwarded-Proto`.

HTTPS works too. Until you configure a certificate the gateway presents a self-signed one, so tell curl not to check it:

```sh
curl -k https://localhost:8443/hello
```

## 4. Change the configuration

Edit `apg.yaml` so that only `/api` is routed:

```yaml
version: 1
services:
  - name: echo
    backends:
      - target: "echo:8080"
routes:
  - name: api
    service: echo
    paths: [/api]
```

The gateway notices the change and applies it without a restart. `curl http://localhost:8080/api/x` still answers; `curl -i http://localhost:8080/hello` is now `404` with `X-Apg-Error: NO_ROUTE`.

If you save a file with a mistake in it, the gateway keeps serving the last good configuration and logs what is wrong. Nothing is half applied.

## 5. Check a file before using it

```sh
docker run --rm -v "$PWD/apg.yaml:/apg.yaml:ro" valkv-labs/valkv-apg:latest validate --config /apg.yaml
```

This runs every check the gateway runs at load and prints each fault with its place in the file. Use it in CI.

## Clean up

```sh
docker rm -f apg echo && docker network rm apg-try
```

## Next

- [A first route with a key and a rate limit](first-route.md)
- [The configuration file](../reference/configuration-file.md), every key
- [Deploying](../ops/deploy.md) on a Linux host, Kubernetes or AWS
