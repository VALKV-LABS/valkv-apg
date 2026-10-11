#!/bin/sh
# Runs the smoke test (tests/smoke.mjs) with whatever is at hand: Node 20 or
# newer if installed, otherwise a Node container.
#
#   APG_ADMIN_URL=http://localhost:9000 APG_ADMIN_TOKEN=apg_at_... \
#   APG_GATEWAY_URL=http://localhost:8080 sh tests/smoke.sh
#
# See the top of tests/smoke.mjs for every setting.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  exec node "$here/smoke.mjs"
fi

if command -v docker >/dev/null 2>&1; then
  # --network host, so "localhost" in the addresses means this machine.
  exec docker run --rm --network "${SMOKE_DOCKER_NETWORK:-host}" \
    -e APG_ADMIN_URL -e APG_ADMIN_TOKEN -e APG_GATEWAY_URL \
    -e SMOKE_UPSTREAM -e SMOKE_TLS_URL -e SMOKE_KEEP -e SMOKE_SKIP_USAGE \
    -v "$here/smoke.mjs:/smoke.mjs:ro" node:22-slim node /smoke.mjs
fi

echo "The smoke test needs Node 20 or newer, or Docker." >&2
exit 2
