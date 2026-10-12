#!/bin/sh
# Graceful binary upgrade (spec PKG-7): a new process takes over the listening
# sockets of a running node, and no request fails while it does.
#
# Runs inside the node image (`make e2e-upgrade`), because both processes must
# share a network namespace and a data directory.
set -eu

mkdir -p /tmp/apg-data
printf 'version: 1\n' > /tmp/apg.yaml
export APG_CONFIG_FILE=/tmp/apg.yaml APG_DATA_DIR=/tmp/apg-data APG_NODE_ID=upgrade-test
export APG_HTTP_MODE=proxy APG_TRAFFIC_HEALTH_PATH=/_health APG_LISTEN_MGMT=127.0.0.1:9100 APG_LOG_LEVEL=warn

probe() { curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8080/_health; }

valkv-apg &
OLD=$!
i=0
until probe 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "the node never became ready"; exit 1; }
  sleep 0.1
done

# Steady traffic for the whole hand-over.
(
  n=0; failed=0
  while [ "$n" -lt 400 ]; do
    probe 2>/dev/null || failed=$((failed + 1))
    n=$((n + 1)); sleep 0.02
  done
  echo "$failed" > /tmp/failed
) &
LOAD=$!

sleep 1
valkv-apg --upgrade &
NEW=$!
sleep 2
kill -QUIT "$OLD"

wait "$LOAD"
i=0
while kill -0 "$OLD" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 150 ] || { echo "the old process did not exit"; exit 1; }
  sleep 0.2
done
kill -0 "$NEW" 2>/dev/null || { echo "the new process is not running"; exit 1; }
probe || { echo "the new process does not serve"; exit 1; }
# The management port moves to the new process once the old one has let go.
i=0
until curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:9100/readyz 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "the new process never took the management port"; exit 1; }
  sleep 0.2
done

failed=$(cat /tmp/failed)
[ "$failed" = 0 ] || { echo "$failed of 400 requests failed during the hand-over"; exit 1; }
kill "$NEW"
echo "upgrade ok: 400 requests served across the hand-over, none failed"
