#!/bin/sh
# Starts valkv-apg on one Amazon Lightsail instance, to try it in the cloud:
# gateway, control plane with the console, Postgres and two sample upstreams.
# Then runs the smoke test against it and prints what passed.
#
#   sh deploy/lightsail/launch.sh            # create, wait, smoke-test
#   sh deploy/lightsail/destroy.sh           # delete it again
#
# Needs the AWS CLI, signed in to an account that may use Lightsail, and curl.
# The smoke test needs Node 20+ or Docker on this machine.
#
# Settings (environment):
#   APG_TRIAL_NAME     instance name                (default valkv-apg-trial)
#   AWS_REGION         region                       (default: the CLI's)
#   APG_TRIAL_ZONE     availability zone            (default: <region>a)
#   APG_TRIAL_BUNDLE   instance size                (default small_3_0: 2 GB, about 12 USD a month)
#   APG_VERSION        image tag to run             (default latest)
#   APG_ADMIN_CIDR     who may reach the Admin API and console (default: this machine's address)
#   SKIP_SMOKE=1       do not run the smoke test
#   APG_TRIAL_DRY_RUN=1  print the first-boot script and stop; nothing is created
#
# What it costs: the instance, by the hour, until you run destroy.sh.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dry=${APG_TRIAL_DRY_RUN:-}
name=${APG_TRIAL_NAME:-valkv-apg-trial}
region=${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}
[ -n "$region" ] || [ -n "$dry" ] || { echo "Set AWS_REGION, or configure a default region for the AWS CLI."; exit 2; }
zone=${APG_TRIAL_ZONE:-${region}a}
bundle=${APG_TRIAL_BUNDLE:-small_3_0}
version=${APG_VERSION:-latest}

[ -n "$dry" ] || command -v aws >/dev/null 2>&1 || { echo "The AWS CLI is not installed."; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is not installed."; exit 2; }
ls_() { aws lightsail --region "$region" "$@"; }

if [ -z "$dry" ] && ls_ get-instance --instance-name "$name" >/dev/null 2>&1; then
  echo "An instance named $name already exists in $region. Delete it with destroy.sh, or set APG_TRIAL_NAME."
  exit 1
fi

# The Admin API of a trial speaks plain HTTP, so it is opened to one address
# only: yours, unless you say otherwise.
admin_cidr=${APG_ADMIN_CIDR:-}
if [ -z "$admin_cidr" ] && [ -z "$dry" ]; then
  my_ip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
  admin_cidr="$my_ip/32"
fi

# Secrets are made here, so this script can use the deployment the moment it is up.
rand() { head -c "$1" /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$2"; }
admin_token="apg_at_$(rand 64 43)"
demo_key="demo_$(rand 48 32)"

state="$here/.trial-$name"
umask 077
[ -z "$dry" ] || state=/dev/null
cat > "$state" <<EOF
APG_TRIAL_NAME=$name
AWS_REGION=$region
APG_ADMIN_TOKEN=$admin_token
DEMO_KEY=$demo_key
EOF

# First-boot script: Docker, then the files of this directory, then up.sh.
user_data=$(mktemp)
trap 'rm -f "$user_data"' EXIT
{
  cat <<EOF
#!/bin/sh
set -eu
exec > /var/log/valkv-apg-trial.log 2>&1
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/valkv-apg && cd /opt/valkv-apg
cat > .env <<'ENV'
APG_ADMIN_IMAGE=valkv-labs/valkv-apg-admin:$version
APG_NODE_IMAGE=valkv-labs/valkv-apg:$version
APG_ADMIN_TOKEN=$admin_token
DEMO_KEY=$demo_key
ENV
EOF
  for f in docker-compose.yml demo.json up.sh; do
    printf "cat > %s <<'APG_FILE_END'\n" "$f"
    cat "$here/$f"
    printf "\nAPG_FILE_END\n"
  done
  echo "sh up.sh"
} > "$user_data"

if [ -n "$dry" ]; then
  cat "$user_data"
  exit 0
fi

echo "creating $name ($bundle) in $zone"
ls_ create-instances --instance-names "$name" --availability-zone "$zone" \
  --blueprint-id ubuntu_24_04 --bundle-id "$bundle" --user-data "file://$user_data" \
  --tags key=app,value=valkv-apg-trial >/dev/null

printf "waiting for the instance to run"
until [ "$(ls_ get-instance-state --instance-name "$name" --query state.name --output text 2>/dev/null)" = "running" ]; do
  printf "."; sleep 5
done
echo

ls_ put-instance-public-ports --instance-name "$name" --port-infos \
  "fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0" \
  "fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0" \
  "fromPort=9000,toPort=9000,protocol=tcp,cidrs=$admin_cidr" \
  "fromPort=22,toPort=22,protocol=tcp,cidrs=$admin_cidr" >/dev/null

ip=$(ls_ get-instance --instance-name "$name" --query instance.publicIpAddress --output text)
echo "APG_TRIAL_IP=$ip" >> "$state"

printf "waiting for valkv-apg at %s (first boot installs Docker and pulls images; a few minutes)" "$ip"
i=0
until curl -fsS -o /dev/null --max-time 3 "http://$ip:9000/readyz" && curl -fsS -o /dev/null --max-time 3 "http://$ip/hello"; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo
    echo "It did not come up in 10 minutes. Look at /var/log/valkv-apg-trial.log on the instance (Lightsail console, Connect using SSH)."
    exit 1
  fi
  printf "."; sleep 5
done
echo

cat <<EOF

valkv-apg is running on Lightsail.

  Console      http://$ip:9000/ui/      (reachable from $admin_cidr only)
  Admin token  $admin_token
  Gateway      http://$ip

Try it:
  curl http://$ip/hello
  curl http://$ip/echo/anything
  curl http://$ip/private                                   # 401: it needs a key
  curl -H "X-Api-Key: $demo_key" http://$ip/private

These details are also in $state. Delete everything with: sh deploy/lightsail/destroy.sh
EOF

if [ -z "${SKIP_SMOKE:-}" ]; then
  echo
  echo "running the smoke test against it"
  APG_ADMIN_URL="http://$ip:9000" APG_ADMIN_TOKEN="$admin_token" APG_GATEWAY_URL="http://$ip" \
    SMOKE_UPSTREAM="echo:8080" SMOKE_TLS_URL="https://$ip" sh "$here/../../tests/smoke.sh"
fi
