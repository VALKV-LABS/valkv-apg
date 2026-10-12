# Deploying

Four ways to run valkv-apg, from a single machine to a fleet. All of them use the same two images and the same settings; see [environment variables](../reference/environment.md).

| Image | What it is |
|---|---|
| `valkvlabs/valkv-apg` | The gateway (node). On its own it is a complete gateway driven by one file |
| `valkvlabs/valkv-apg-admin` | The control plane: Admin API, console, and the feed nodes read |

Both are published for `linux/amd64` and `linux/arm64`, signed, with a bill of materials.

## What every deployment needs

**With a control plane:**

| | Where | Notes |
|---|---|---|
| `APG_SECRET_KEY` | Control plane and every node | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts private keys and plugin secrets. Losing it loses them |
| `APG_DATABASE_URL` | Control plane | Postgres 14 or newer. One database; the control plane creates and migrates its tables |
| `APG_BOOTSTRAP_ADMIN_TOKEN`, `APG_BOOTSTRAP_NODE_TOKEN` | Control plane, at first start | The first admin token and the token nodes use. Left unset, they are generated and logged once |
| `APG_CONFIG_SOURCE=api_poll`, `APG_CONFIG_URL`, `APG_NODE_TOKEN`, `APG_NODE_ID` | Each node | `APG_CONFIG_URL` is `<control plane>/dp`. `APG_NODE_ID` must be stable and unique per node |

**Standalone:** only `APG_CONFIG_FILE` (default `/etc/apg/apg.yaml`).

A node needs a writable data directory (`APG_DATA_DIR`, `/var/lib/apg` in the image) for its configuration cache, queued usage and, in standalone mode, issued certificates. Losing it is safe: the node takes a fresh snapshot.

## Network

| From | To | Port |
|---|---|---|
| Clients | Nodes | 443 → 8443, 80 → 8080 |
| Nodes | Control plane | 9000 |
| Nodes | Your upstreams | theirs |
| Nodes | The ACME authority, if you use automatic certificates | 443 |
| Control plane | Postgres | 5432 |
| Operators, CI | Control plane | 9000 |
| Monitoring | Nodes | 9100 |

Never expose port 9100, and do not expose the control plane to the internet in clear. Nodes do not connect to Postgres.

## Docker Compose

`deploy/compose/standalone.yml` is one node with a file. `deploy/lightsail/docker-compose.yml` is a complete single-machine stack: node, control plane, console, Postgres and sample upstreams.

```sh
cd deploy/lightsail
APG_HTTP_PORT=80 APG_HTTPS_PORT=443 sh up.sh
```

`up.sh` generates the secrets into `.env` on first run. Keep that file.

## Kubernetes

```sh
kubectl create secret generic apg-secrets \
  --from-literal=secret-key="$(openssl rand -base64 32)" \
  --from-literal=database-url="postgres://apg:…@postgres.internal:5432/apg?sslmode=require" \
  --from-literal=admin-token="apg_at_$(openssl rand -hex 24)" \
  --from-literal=node-token="apg_at_$(openssl rand -hex 24)"

helm install apg deploy/helm/valkv-apg \
  --set secrets.existingSecret=apg-secrets \
  --set node.replicas=3
```

The chart creates the node Deployment (or DaemonSet) with a Service of type LoadBalancer, the control plane Deployment with an in-cluster Service, a HorizontalPodAutoscaler and PodDisruptionBudgets, NetworkPolicies that keep the management port and the control plane private, and optionally a ServiceMonitor. It expects a Postgres you provide. See `deploy/helm/valkv-apg/values.yaml`.

Readiness of a node pod means "holds a complete configuration", not "can reach the control plane", so nodes stay in service through a control-plane outage.

## A Linux host

The release tarball holds the binary, a systemd unit and an environment file.

```sh
install -m 0755 valkv-apg /usr/local/bin/valkv-apg
install -m 0644 valkv-apg.service /etc/systemd/system/
useradd --system --no-create-home --shell /usr/sbin/nologin valkv-apg
install -d -m 0750 -g valkv-apg /etc/valkv-apg
install -m 0640 -g valkv-apg valkv-apg.env /etc/valkv-apg/env      # then edit it
systemctl daemon-reload && systemctl enable --now valkv-apg
```

The unit binds ports 80 and 443 without running as root. The binary needs glibc and OpenSSL 3 (Debian 12, Ubuntu 22.04 or newer, or equivalent).

## AWS

`deploy/terraform/aws` is a reference: a network load balancer in front of an auto-scaling group of nodes, the control plane behind an internal load balancer, managed Postgres, secrets in Secrets Manager. Its README covers applying it, what is protected and how, and what it costs.

To try the product on AWS in one command instead, see `deploy/lightsail/README.md`.

## After deploying

Run the smoke test. It configures routes of its own, sends requests through every class of plugin, checks that a change reaches every node, and prints expected against actual:

```sh
APG_ADMIN_URL=https://admin.internal.example.com:9000 \
APG_ADMIN_TOKEN=apg_at_… \
APG_GATEWAY_URL=http://gateway.internal.example.com \
SMOKE_UPSTREAM=echo.internal.example.com:8080 \
sh tests/smoke.sh
```

`SMOKE_UPSTREAM` must be a service that answers with a JSON description of the request it received (the `mendhak/http-https-echo` image does).

Then: [security hardening](hardening.md), [backup](backup.md), and [how to upgrade](rollout.md).
