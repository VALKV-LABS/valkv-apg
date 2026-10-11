#!/bin/sh
# Runs the steps of docs/src/getting-started/standalone.md and of the key and
# rate-limit page that follows it, so that the quickstart cannot rot (spec DOC-3).
#
#   APG_IMAGE=valkv-labs/valkv-apg:dev sh tests/docs/quickstart-standalone.sh
set -eu

image=${APG_IMAGE:-valkv-labs/valkv-apg:dev}
net=apg-quickstart-$$
work=$(mktemp -d)
# mktemp makes the directory private to this user; the gateway in the
# container runs as another one and must be able to read the file in it.
chmod 755 "$work"
export MSYS_NO_PATHCONV=1
# Docker on Windows wants a Windows path for a bind mount.
mount=$( (cd "$work" && pwd -W) 2>/dev/null || echo "$work")

cleanup() {
  docker rm -f "$net-apg" "$net-echo" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; docker logs --tail 20 "$net-apg" 2>&1 | sed 's/^/     /'; exit 1; }
# Requests are made from inside the network, so no host port is needed.
get() { docker run --rm --network "$net" curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }
until_code() { # $1 wanted status, $2.. curl arguments
  want=$1; shift
  i=0
  while [ "$(get "$@" || true)" != "$want" ]; do
    i=$((i + 1)); [ "$i" -lt 40 ] || return 1
    sleep 0.5
  done
}

cat > "$work/apg.yaml" <<'YAML'
version: 1
services:
  - name: echo
    backends:
      - target: "echo:8080"
routes:
  - name: everything
    service: echo
    paths: [/]
YAML

echo "1. check the file before using it"
docker run --rm -v "$mount/apg.yaml:/apg.yaml:ro" "$image" validate --config /apg.yaml >/dev/null || fail "validate refused the quickstart file"

echo "2. start the gateway and something to route to"
docker network create "$net" >/dev/null
docker run -d --name "$net-echo" --network "$net" --network-alias echo -e HTTP_PORT=8080 mendhak/http-https-echo:35 >/dev/null
docker run -d --name "$net-apg" --network "$net" --network-alias apg \
  -v "$mount:/etc/apg:ro" -e APG_HTTP_MODE=proxy \
  -e APG_SECRET_MOBILE_KEY=a-long-random-key-0123456789 "$image" >/dev/null

echo "3. send a request"
until_code 200 http://apg:8080/hello || fail "GET /hello did not answer 200"
[ "$(get -k https://apg:8443/hello)" = 200 ] || fail "HTTPS with the self-signed certificate did not answer 200"

echo "4. change the configuration; the gateway reloads it"
cat > "$work/apg.yaml" <<'YAML'
version: 1
services:
  - name: echo
    backends:
      - target: "echo:8080"
routes:
  - name: api
    service: echo
    paths: [/api]
YAML
until_code 404 http://apg:8080/hello || fail "/hello still answers after the route was narrowed to /api"
[ "$(get http://apg:8080/api/x)" = 200 ] || fail "/api/x does not answer 200 after the change"

echo "5. a mistake in the file leaves the last good configuration in force"
printf 'version: 1\nroutes:\n  - name: broken\n    service: no-such-service\n' > "$work/apg.yaml"
sleep 2
[ "$(get http://apg:8080/api/x)" = 200 ] || fail "a bad file replaced a good configuration"

echo "6. a route with a key and a rate limit"
cat > "$work/apg.yaml" <<'YAML'
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
YAML
until_code 401 http://apg:8080/orders || fail "/orders without a key is not 401"
# Eight requests in quick succession, from one container: the burst is five, and the bucket refills at two a second.
codes=$(docker run --rm --network "$net" --entrypoint sh curlimages/curl:8.11.1 -c 'for i in 1 2 3 4 5 6 7 8; do curl -s -o /dev/null -w "%{http_code} " -H "X-Api-Key: a-long-random-key-0123456789" http://apg:8080/orders; done')
case "$codes" in
  "200 200 200 200 200 429 "*) ;;
  *) fail "expected five 200s and then 429s, got: $codes" ;;
esac

echo "quickstart ok"
