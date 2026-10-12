#!/bin/sh
# Deletes the Lightsail instance launch.sh created, and with it everything on it.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
name=${APG_TRIAL_NAME:-valkv-apg-trial}
state="$here/.trial-$name"
region=${AWS_REGION:-}
if [ -z "$region" ] && [ -f "$state" ]; then
  region=$(sed -n 's/^AWS_REGION=//p' "$state")
fi
[ -n "$region" ] || region=$(aws configure get region)

echo "deleting instance $name in $region"
aws lightsail --region "$region" delete-instance --instance-name "$name" >/dev/null
rm -f "$state"
echo "deleted. Nothing else was created."
