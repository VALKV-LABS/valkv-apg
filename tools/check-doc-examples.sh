#!/bin/sh
# Checks every configuration example in the documentation with the gateway's
# own `validate` command (spec DOC-3). Runs inside the node image; the
# examples are in /examples (see `make docs-check`).
#
# Examples read secrets and other values from the environment, so each
# APG_SECRET_* name and each ${VARIABLE} an example uses is given a value.
set -u

failed=0
total=0
for f in /examples/*.yaml; do
  total=$((total + 1))
  names=$( { grep -o 'APG_SECRET_[A-Z0-9_]*' "$f"; grep -o '\${[A-Z0-9_]*' "$f" | tr -d '${'; } | sort -u)
  vars=""
  for n in $names; do vars="$vars $n=example-value-0123456789"; done
  # shellcheck disable=SC2086
  if ! out=$(env $vars valkv-apg validate --config "$f" 2>&1); then
    failed=$((failed + 1))
    echo "FAIL $(basename "$f")"
    echo "$out" | sed 's/^/     /'
  fi
done
echo "$((total - failed)) of $total documentation examples are valid"
[ "$failed" -eq 0 ]
