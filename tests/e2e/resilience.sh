#!/bin/sh
# Resilience checks for database mode (spec ARC-4, CFG-8, CFG-9, CFG-10, CFG-12, NFR-7).
# Stops and starts containers around small test suites, so it runs on the host
# (through `make e2e-resilience`), not inside the test container.
#
# Needs the stack from `make up` and the routing suite's configuration, which
# this script applies first.
set -eu

C="docker compose -f deploy/compose/database.yml -p valkv-apg"
suite() { # name, extra env...
  name="$1"; shift
  $C run --rm -e SUITE="$name" "$@" e2e
}
psql() { $C exec -T postgres psql -U apg -d apg -qAt -c "$1"; }
snapshots() { # reason -> count from the node's metrics
  $C exec -T node curl -fsS http://127.0.0.1:9100/metrics | awk -v r="reason=\"$1\"" 'index($0, "apg_snapshots_total") && index($0, r) { print $2 }' | head -1
}
wait_for() { # description, command...
  what="$1"; shift
  i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || { echo "timed out waiting for: $what"; exit 1; }
    sleep 1
  done
}

echo "== 0. apply the routing configuration"
suite routing >/dev/null
suite resilience-serving

echo "== 1. control plane down: traffic must keep flowing"
$C stop admin postgres >/dev/null 2>&1
sleep 2
suite resilience-serving

echo "== 2. node restarted while the control plane is down: it must serve from its cache"
$C restart node >/dev/null 2>&1
wait_for "node ready from cache" $C exec -T node curl -fsS http://127.0.0.1:9100/readyz
suite resilience-serving

echo "== 3. after a long silence the source is reported stale, and the node is still ready"
# The stale threshold in this stack is 30 s of silence, counted from the restart above.
sleep 35
suite resilience-serving -e EXPECT_STALE=true

echo "== 4. control plane back: the node resumes without a restart"
$C start postgres admin >/dev/null 2>&1
wait_for "admin healthy" $C exec -T admin node -e "fetch('http://127.0.0.1:9000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
suite resilience-recovered

echo "== 5. changelog retention passes the node by: it must resync from a snapshot"
$C stop node >/dev/null 2>&1
# Make changes the stopped node misses, then delete every changelog row, as
# retention would after the window. The node's position is now gone.
# (The second node redirects plain HTTP, so it is driven over HTTPS.)
suite resilience-recovered -e NODE_HTTP=https://node-redirect:8443 -e NODE_MGMT=http://node-redirect:9100
psql "DELETE FROM apg_changes" >/dev/null
before=$(snapshots position_gone 2>/dev/null || true)
$C start node >/dev/null 2>&1
wait_for "node ready" $C exec -T node curl -fsS http://127.0.0.1:9100/readyz
sleep 3
after=$(snapshots position_gone)
[ "${after:-0}" -ge 1 ] || { echo "expected a position_gone snapshot, metric says '${after:-none}' (was '${before:-none}')"; exit 1; }
echo "  node resynced (apg_snapshots_total{reason=position_gone} = $after)"
suite resilience-serving
suite resilience-recovered

echo "== 6. the control plane is rebuilt (new cluster id): the node must discard its position and resync"
psql "UPDATE apg_meta SET value = gen_random_uuid()::text WHERE key = 'cluster_id'" >/dev/null
$C restart admin >/dev/null 2>&1
wait_for "admin healthy" $C exec -T admin node -e "fetch('http://127.0.0.1:9000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
i=0
until [ "$(snapshots cluster_changed 2>/dev/null || echo 0)" -ge 1 ] 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "the node never resynced after the cluster id changed"; exit 1; }
  sleep 1
done
echo "  node resynced (apg_snapshots_total{reason=cluster_changed} = $(snapshots cluster_changed))"
suite resilience-serving
suite resilience-recovered

echo "all resilience checks passed"
