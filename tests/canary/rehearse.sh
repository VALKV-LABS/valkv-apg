#!/bin/sh
# Rehearses a canary rollout and its rollback on the Compose stack.
#
#   1. tests/canary/rehearse.mjs: the promotion check says "promote" for a
#      healthy canary and "rollback" once errors are injected on it.
#   2. The rollback itself, with the command the runbook gives for Compose:
#      the canary is recreated from the previous image, and must be ready and
#      up to date again. The time that takes is printed.
#
# `node` is the stable track and `node-redirect` the canary. Needs `make up`.
set -eu

# Another stack can be named with APG_COMPOSE (make prepush does).
COMPOSE=${APG_COMPOSE:-"docker compose -f deploy/compose/database.yml -p valkv-apg"}
export MSYS_NO_PATHCONV=1

$COMPOSE run --rm -w /repo/tests/canary e2e node rehearse.mjs

echo
echo "rolling the canary back (docs/runbooks/rollout.md, Compose)"
# The previous image is the one the stable track runs.
previous=$($COMPOSE images node --format json | sed -n 's/.*"Repository":"\([^"]*\)".*"Tag":"\([^"]*\)".*/\1:\2/p' | head -1)
echo "previous image: ${previous:-valkv-labs/valkv-apg:dev}"

applied_before=$($COMPOSE exec -T node curl -fsS http://127.0.0.1:9100/status | sed 's/.*"applied_seq":\([0-9]*\).*/\1/')
start=$(date +%s)
$COMPOSE up -d --no-deps --force-recreate --wait node-redirect >/dev/null 2>&1

i=0
until ready=$($COMPOSE exec -T node-redirect curl -fsS http://127.0.0.1:9100/readyz 2>/dev/null) \
  && [ "$(echo "$ready" | sed 's/.*"applied_seq":\([0-9]*\).*/\1/')" -ge "$applied_before" ]; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || { echo "FAIL: the rolled-back node did not become ready and up to date"; exit 1; }
  sleep 0.5
done
took=$(( $(date +%s) - start ))

# It serves traffic again, from its cache or a fresh snapshot.
code=$($COMPOSE exec -T node-redirect curl -ks -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/ || true)
[ "$code" != "000" ] || { echo "FAIL: the rolled-back node does not answer on its traffic port"; exit 1; }

echo "ok: rollback took ${took}s; the node is ready, at sequence $applied_before or later, and answering (status $code)"
echo "canary rehearsal ok"
