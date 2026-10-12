#!/bin/sh
# Starts the trial stack in this directory and loads the demo configuration.
# Runs on the Lightsail instance at first boot (launch.sh arranges that), and
# works just as well on any machine with Docker:
#
#   cd deploy/lightsail && sh up.sh
#
# Secrets are read from .env; missing ones are generated.
set -eu
cd "$(dirname "$0")"

rand() { head -c "$1" /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$2"; }
touch .env
chmod 600 .env
have() { grep -q "^$1=" .env; }
have APG_SECRET_KEY  || echo "APG_SECRET_KEY=$(head -c 32 /dev/urandom | base64)" >> .env
have APG_DB_PASSWORD || echo "APG_DB_PASSWORD=$(rand 48 32)" >> .env
have APG_ADMIN_TOKEN || echo "APG_ADMIN_TOKEN=apg_at_$(rand 64 43)" >> .env
have APG_NODE_TOKEN  || echo "APG_NODE_TOKEN=apg_at_$(rand 64 43)" >> .env
have DEMO_KEY        || echo "DEMO_KEY=demo_$(rand 48 32)" >> .env
# shellcheck disable=SC1091
. ./.env

docker compose up -d --wait

admin="http://127.0.0.1:${APG_ADMIN_PORT:-9000}"
echo "loading the demo configuration"
body=$(sed "s/\${DEMO_KEY}/$DEMO_KEY/" demo.json)
i=0
until curl -fsS -o /dev/null -X POST "$admin/v1/config/apply" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"document\": $body, \"message\": \"demo configuration\"}"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "the control plane did not accept the demo configuration"; exit 1; }
  sleep 2
done

cat <<EOF

valkv-apg is up.

  Console      $admin/ui/        sign in with the admin token below
  Admin token  $APG_ADMIN_TOKEN
  Gateway      http://127.0.0.1:${APG_HTTP_PORT:-80}

Try it:
  curl http://127.0.0.1:${APG_HTTP_PORT:-80}/hello
  curl http://127.0.0.1:${APG_HTTP_PORT:-80}/echo/anything
  curl http://127.0.0.1:${APG_HTTP_PORT:-80}/private                         # 401: it needs a key
  curl -H "X-Api-Key: $DEMO_KEY" http://127.0.0.1:${APG_HTTP_PORT:-80}/private
EOF
