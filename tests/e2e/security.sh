#!/bin/sh
# Runs the security suite, then searches the logs of every container for the
# secrets the suites used (spec SEC-8): API keys, passwords, tokens and
# private keys must never be written to a log.
#
# Needs the Compose stack (`make up`).
set -eu

# Another stack can be named with APG_COMPOSE (make prepush does).
COMPOSE=${APG_COMPOSE:-"docker compose -f deploy/compose/database.yml -p valkv-apg"}
export MSYS_NO_PATHCONV=1

$COMPOSE run --rm --use-aliases -e MODE=api_poll -e SUITE=security e2e

echo
echo "searching the logs of every container for secrets"
logs=$(mktemp)
trap 'rm -f "$logs"' EXIT
$COMPOSE logs --no-color --no-log-prefix > "$logs" 2>&1
lines=$(wc -l < "$logs")
[ "$lines" -gt 100 ] || { echo "FAIL: only $lines log lines were read; the search would prove nothing"; exit 1; }

found=0
# Values the end-to-end suites send as credentials, the stack's own tokens and
# key, and the markers of private key material.
for needle in \
  "leak-canary" \
  "apg_at_dev-only-admin-token-do-not-use" \
  "apg_at_dev-only-node-token-do-not-use" \
  "ZGV2LW9ubHktZGV2LW9ubHktZGV2LW9ubHktZGV2LW8=" \
  "apg-dev-only" \
  "apg_k_alice_0123456789abcdef" \
  "wonderland-pass" \
  "PRIVATE KEY-----"
do
  if grep -F -q -- "$needle" "$logs"; then
    echo "FAIL: the logs contain '$needle':"
    grep -F -m 3 -- "$needle" "$logs" | cut -c1-220
    found=1
  fi
done
[ "$found" -eq 0 ] || exit 1
echo "ok: $lines log lines, no secret in any of them"
