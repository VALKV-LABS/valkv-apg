#!/bin/sh
# Throughput and latency of one node (spec NFR-1, NFR-2), measured with wrk
# against a release build:
#
#   1. the upstream directly                     the ceiling of this machine
#   2. through the gateway, a bare route         what proxying costs
#   3. through the gateway, key_auth+rate_limit  the figure NFR-1 is about
#
# The numbers depend entirely on the machine, and here the load generator, the
# gateway and the upstream share its cores. Read them against run 1, not as
# absolutes. Results are printed and appended to tests/bench/results.txt.
#
#   sh tests/bench/throughput.sh [seconds] [connections] [threads]
set -eu

cd "$(dirname "$0")"
secs=${1:-20}
conns=${2:-128}
threads=${3:-4}
COMPOSE="docker compose -f compose.yml"
export MSYS_NO_PATHCONV=1

$COMPOSE build -q
$COMPOSE up -d --wait node
trap '$COMPOSE --profile load down -v --remove-orphans >/dev/null 2>&1' EXIT

run() {
  # $1 label, $2 url, $3.. extra wrk arguments
  label=$1; url=$2; shift 2
  out=$($COMPOSE --profile load run --rm -T load -t"$threads" -c"$conns" -d"${secs}s" --latency "$@" "$url")
  rps=$(echo "$out" | sed -n 's/^Requests\/sec: *//p')
  p50=$(echo "$out" | sed -n 's/^ *50% *//p')
  p99=$(echo "$out" | sed -n 's/^ *99% *//p')
  errors=$(echo "$out" | sed -n 's/^ *Non-2xx or 3xx responses: *//p')
  printf '%-44s %12s req/s   p50 %-9s p99 %-9s%s\n' "$label" "$rps" "$p50" "$p99" "${errors:+  non-2xx: $errors}"
}

# Warm up connections and caches.
$COMPOSE --profile load run --rm -T load -t2 -c32 -d3s http://node:8080/bare >/dev/null

{
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ)  ${secs}s, ${conns} connections, ${threads} threads, $(nproc 2>/dev/null || echo '?') host CPUs =="
  run "upstream directly" http://upstream:8080/bare
  run "gateway, bare route" http://node:8080/bare
  run "gateway, key_auth + rate_limit (NFR-1)" http://node:8080/guarded -H "X-Api-Key: bench-key-0123456789abcdef0123456789"
} | tee -a results.txt
