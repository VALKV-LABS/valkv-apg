# Rolling out a new version, and rolling it back

How to move a running gateway to a new release without an outage, how to decide whether to go on at each step, and how to go back.

## The order, and why it is safe

1. **Upgrade the control plane first** (the admin). It applies its own database migrations at start.
2. **Then the nodes, in stages**: 5 % of them (at least one), then 25 %, then all.

This order is safe because a node one release older than the control plane keeps working: it steps over change events and fields it does not know, and never stops because of one. A node one release newer also works. The two may differ by one minor release, in either direction. Do not skip a minor release.

A node keeps serving from its local cache while the control plane restarts, so step 1 does not interrupt traffic.

## Before you start

- Read the release's entry in `CHANGELOG.md` for anything marked as needing action.
- Check that every node is up to date: `apgctl nodes` shows `LAG 0` and `LIVE true` for each.
- Know your previous version. Rolling back is redeploying it.
- Take a database backup if the release notes mention a migration.

## At each stage: promote, hold, or roll back

Leave each stage running for **15 minutes** under normal traffic, then compare the canary nodes with the stable ones. Promote only when all four hold:

| # | Criterion | Limit |
|---|---|---|
| 1 | Server-error (5xx) ratio | canary no more than 0.1 percentage points worse |
| 2 | p99 latency | canary no more than 10 % worse |
| 3 | Change events the canary could not apply (`apg_changelog_errors_total`) | none during the stage |
| 4 | Every canary node | ready, converged, not serving stale configuration |

`deploy/canary/check.mjs` reads the nodes' management endpoints at the start and the end of the window and applies these rules. It needs Node 20 and no Prometheus:

```sh
node deploy/canary/check.mjs \
  --stable http://10.0.1.11:9100,http://10.0.1.12:9100 \
  --canary http://10.0.1.13:9100 \
  --window 900
```

```
ok    canary nodes ready, converged, not stale: 1 of 1
ok    change events the canary could not apply: 0 in the window
FAIL  server-error ratio no more than 0.1 points worse: stable 0.020 % of 48211, canary 5.000 % of 2540
ok    p99 latency no more than 10 % worse: stable 41.0 ms, canary 43.2 ms

ROLLBACK: server-error ratio no more than 0.1 points worse
```

| Exit code | Meaning | Do |
|---|---|---|
| 0 | promote | Go to the next stage |
| 1 | roll back | Roll back now (below) |
| 2 | hold | Too little traffic reached one side to tell. Keep the stage running and check again |

If you run Prometheus, the same rules are in `deploy/observability/alerts.yaml`, and the Helm chart labels canary pods `apg/track: canary` so the two tracks can be told apart in queries.

After each stage, run the smoke test against the deployment. It sends a request through every class of plugin and confirms that a configuration change reaches every node:

```sh
APG_ADMIN_URL=... APG_ADMIN_TOKEN=... APG_GATEWAY_URL=... sh tests/smoke.sh
```

## Kubernetes (Helm)

Set `NEW` to the new version and `OLD` to the one running.

```sh
# 1. Control plane first. Nodes stay on OLD.
helm upgrade apg deploy/helm/valkv-apg --reuse-values --set image.admin.tag=$NEW
kubectl rollout status deploy/apg-valkv-apg-admin

# 2. Stage 1: a canary track on NEW next to the stable track, behind the same Service.
#    One canary pod among 19 stable ones is about 5 % of traffic.
helm upgrade apg deploy/helm/valkv-apg --reuse-values \
  --set canary.enabled=true --set canary.image.tag=$NEW --set canary.replicas=1
kubectl rollout status deploy/apg-valkv-apg-node-canary
#    ... wait 15 minutes, run the check, run the smoke test ...

# 3. Stage 2: about 25 %.
helm upgrade apg deploy/helm/valkv-apg --reuse-values --set canary.replicas=5
#    ... wait 15 minutes, run the check, run the smoke test ...

# 4. Stage 3: everything on NEW, canary track removed.
helm upgrade apg deploy/helm/valkv-apg --reuse-values \
  --set image.node.tag=$NEW --set canary.enabled=false
kubectl rollout status deploy/apg-valkv-apg-node
```

The canary's share of traffic is its share of pods. Choose `canary.replicas` from your node count: `replicas ≈ share × total / (1 − share)`.

**Roll back** at stage 1 or 2 (removes the canary; stable pods were never touched):

```sh
helm upgrade apg deploy/helm/valkv-apg --reuse-values --set canary.enabled=false
```

**Roll back** after stage 3:

```sh
helm upgrade apg deploy/helm/valkv-apg --reuse-values --set image.node.tag=$OLD
kubectl rollout status deploy/apg-valkv-apg-node
```

Expect about one minute per ten nodes: pods are replaced a few at a time, and each new pod is ready within seconds because readiness needs only a complete configuration, which it loads from the control plane in one request.

Roll the control plane back only if the release notes say the migration can be reverted, and only after every node is back on `OLD`:

```sh
kubectl exec deploy/apg-valkv-apg-admin -- node dist/index.js migrate down 1   # once per migration the release added
helm upgrade apg deploy/helm/valkv-apg --reuse-values --set image.admin.tag=$OLD
```

## Docker Compose

With two or more node services behind a load balancer, treat one as the canary.

```sh
# 1. Control plane first.
APG_VERSION=$NEW docker compose up -d --no-deps admin

# 2. One node on NEW. The others keep serving.
docker compose stop -t 35 node-2            # drains for up to 30 s
APG_VERSION=$NEW docker compose up -d --no-deps node-2
#    ... wait, check, smoke test ...

# 3. The rest, one at a time.
APG_VERSION=$NEW docker compose up -d --no-deps node-1
```

**Roll back** a node (about 10 seconds; it starts from its cache or takes a fresh snapshot):

```sh
APG_VERSION=$OLD docker compose up -d --no-deps --force-recreate node-2
```

The node's cache is safe across versions: a cache written by another release, or by another control plane, is discarded and rebuilt instead of trusted.

## Linux hosts (systemd)

One host at a time, behind a load balancer that health-checks `GET /readyz` on the management port.

```sh
# on the host
install -m 0755 valkv-apg-$NEW /usr/local/bin/valkv-apg
systemctl restart valkv-apg          # with a control plane: drains, restarts in a few seconds
# or, in standalone (file) mode, with no dropped connection at all:
systemctl reload valkv-apg           # the new binary takes over the listening sockets
```

Check the first host as the canary for 15 minutes before doing the next.

**Roll back** (a few seconds):

```sh
install -m 0755 valkv-apg-$OLD /usr/local/bin/valkv-apg
systemctl restart valkv-apg          # or: systemctl reload valkv-apg, in standalone mode
```

## AWS (the Terraform reference)

Changing `version_tag` and applying replaces the admin instances first, then the nodes in a rolling refresh that keeps at least 90 % in service. To stage it, run a second, small node group on the new version behind the same load balancer for the canary period, then change `version_tag`. To roll back, set `version_tag` to the previous version and apply.

## If something goes wrong during a rollout

| What you see | What it means | Do |
|---|---|---|
| A node is `not reporting` in `apgctl nodes` | It cannot reach the control plane, or is down | It still serves from its cache if it is up. Check its `/readyz` and its log. |
| `LAG` stays above 0 on one node | It is not applying changes | Look for `apg_changelog_errors_total` on that node; restart it. It will take a snapshot. |
| `stale: true` in `/readyz` | The node has not heard from the control plane for a while | It keeps serving. Fix the control plane or the network between them. |
| The admin does not start after the upgrade | A migration failed | The log names it. The database is unchanged by a failed migration; start the previous admin version. |
| 5xx on the canary only | The new version misbehaves with your configuration | Roll back, then reproduce with `tests/smoke.sh` against a test deployment. |

## Rehearsing this

`make canary-rehearsal` runs the whole procedure on the local Compose stack: a healthy stage that the check promotes, a stage with errors injected on the canary that the check rolls back, and the Compose rollback command, timed. `make e2e-skew` proves the version-skew guarantee by feeding the nodes change events from a newer control plane.
