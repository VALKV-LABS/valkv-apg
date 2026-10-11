#!/bin/sh
# Version skew (spec PKG-2, CFG-5): a node must keep working when the control
# plane is one release ahead of it and sends things the node has never heard of.
#
# This writes three such events straight into the changelog, the way a newer
# admin would, and checks that every node steps over them, stays ready, and
# still applies the ordinary change that follows.
#
# Needs the Compose stack (`make up`).
set -eu

COMPOSE="docker compose -f deploy/compose/database.yml -p valkv-apg"
TOKEN=apg_at_dev-only-admin-token-do-not-use
SERVICE_ID=0193f2a0-5555-7000-8000-000000000001

psql() { $COMPOSE exec -T postgres psql -U apg -d apg -v ON_ERROR_STOP=1 -qAt "$@"; }
admin() { $COMPOSE exec -T admin node -e "
  fetch('http://127.0.0.1:9000$2', { method: '$1', headers: { authorization: 'Bearer $TOKEN', ...(process.argv[1] ? { 'content-type': 'application/json' } : {}) }, body: process.argv[1] || undefined })
    .then(async (r) => { console.log(r.status, (await r.text()).slice(0, 300)); process.exit(r.status < 300 ? 0 : 1); })" "${3:-}"; }
node_status() { $COMPOSE exec -T "$1" curl -fsS http://127.0.0.1:9100/"$2"; }

default_ws=$(psql -c "SELECT id FROM apg_workspaces WHERE system")

# What a newer control plane might emit: a kind this node does not know, a
# known kind carrying fields it does not know, and an operation it does not know.
emit() {
  psql -c "BEGIN;
    SELECT 1 FROM apg_meta WHERE key = 'last_seq' FOR UPDATE;
    INSERT INTO apg_changes (data) VALUES ('$1'::jsonb);
    UPDATE apg_meta SET value = (SELECT max(seq)::text FROM apg_changes) WHERE key = 'last_seq';
    SELECT pg_notify('apg_changes', (SELECT max(seq)::text FROM apg_changes));
    COMMIT;" >/dev/null
}

echo "writing events from the future into the changelog"
emit '{"v":2,"kind":"traffic_policy","op":"upsert","id":"tp-1","revision":1,"data":{"mode":"mirror","percent":5}}'
emit "{\"v\":2,\"kind\":\"service\",\"op\":\"upsert\",\"id\":\"$SERVICE_ID\",\"workspace_id\":\"$default_ws\",\"revision\":1,\"data\":{\"name\":\"skew-future-service\",\"backends\":[{\"id\":\"0193f2a0-5555-7000-8000-000000000002\",\"target\":\"echo:8080\",\"weight\":1,\"status\":\"active\",\"zone_affinity\":\"strict\"}],\"outlier_detection\":{\"enabled\":true},\"egress_restricted\":false}}"
emit '{"v":2,"kind":"route","op":"archive","id":"0193f2a0-5555-7000-8000-000000000003"}'

# An ordinary change after them: the nodes must get past the three above to see it.
admin PUT /v1/workspaces/default/services/skew-after '{"backends":[{"target":"echo:8080"}]}' >/dev/null
last=$(psql -c "SELECT value FROM apg_meta WHERE key = 'last_seq'")

for node in node node-redirect; do
  i=0
  until [ "$(node_status "$node" status | sed 's/.*"applied_seq":\([0-9]*\).*/\1/')" -ge "$last" ]; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || { echo "FAIL: $node did not get past the unknown events (wanted $last)"; node_status "$node" status; exit 1; }
    sleep 0.5
  done
  node_status "$node" readyz >/dev/null || { echo "FAIL: $node is not ready after the unknown events"; exit 1; }
  echo "ok: $node applied up to $last and is ready"
done

skipped=$(node_status node metrics | grep '^apg_changelog_errors_total' || true)
echo "node reports: ${skipped:-no skipped-event metric}"

# Tidy up: the hand-written service has no row in the database, so remove it the
# way the admin would, with a delete event; the real one goes through the API.
emit "{\"v\":2,\"kind\":\"service\",\"op\":\"delete\",\"id\":\"$SERVICE_ID\",\"workspace_id\":\"$default_ws\"}"
admin DELETE /v1/workspaces/default/services/skew-after >/dev/null
echo "skew ok: unknown kinds, fields and operations are stepped over, never fatal"
