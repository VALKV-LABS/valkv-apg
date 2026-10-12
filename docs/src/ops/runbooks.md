# Runbooks

Each one is: what you see, what to check, how to fix it.

Throughout, `NODE` is a node's management address (for example `http://10.0.1.11:9100`), and `apgctl` is configured for your control plane.

## A node is not picking up changes

**You see:** `apgctl nodes` shows `LAG` above 0 that does not go down; a change is live on some nodes and not others; alert on `apg_nodes_max_lag`.

**Check:**

```sh
apgctl nodes
curl -s $NODE/readyz        # ready, stale, applied_seq, source_age_seconds
curl -s $NODE/metrics | grep -E 'apg_changelog_errors_total|apg_config_dangling_refs|apg_snapshots_total'
```

- `source_age_seconds` growing: the node cannot reach the control plane. Go to [the next runbook](#a-node-reports-stale-configuration).
- `apg_changelog_errors_total` increasing: the node receives entries it cannot apply. Its log names them.
- `apg_config_dangling_refs` above 0: a route refers to a service the node does not have.

**Fix:** restart the node. If it still lags, restart it with an empty data directory; it takes a fresh snapshot, which is always complete. If one particular change stops every node, undo that change (`apgctl revisions rollback`, or revert it in the console) and report it.

## A node reports stale configuration

**You see:** `stale: true` in `/readyz`; the node shows `serving stale config` in the console; `apg_config_source_age_seconds` rising. Traffic is still served.

**Check**, from the node's host:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $APG_NODE_TOKEN" "$APG_CONFIG_URL/changes?after=0&limit=1"
```

| Answer | Meaning |
|---|---|
| No connection | Network, DNS, a firewall, or the control plane is down |
| `401` | The node token was revoked or is wrong |
| `403` | The token does not have the `node` role |
| `200` or `410` | The control plane is reachable; look at the node's log |

**Fix:** restore the path or the token. The node catches up by itself; nothing needs restarting.

## The control plane or Postgres is down

**You see:** the console and `apgctl` fail; `/readyz` of the control plane answers 503; nodes turn stale after a while.

**What still works:** all traffic through existing configuration, including after a node restart. **What does not:** changes, new certificates, renewals. Usage queues on nodes for up to a day.

**Check:**

```sh
curl -s https://admin.internal.example.com:9000/healthz    # the process is up
curl -s https://admin.internal.example.com:9000/readyz     # it can reach Postgres
```

**Fix:** bring Postgres back, then the control plane. It applies pending migrations at start. Nodes reconnect on their own and deliver queued usage. If the database had to be restored from a backup, see [backup and restore](backup.md).

There is no hurry measured in minutes: nothing is dropped while nodes run. There is a hurry measured in days: certificates renew 30 days before expiry, and usage older than a day is discarded by nodes.

## A certificate is not issued

**You see:** a domain with an automatic certificate still presents the fallback certificate after several minutes; `apg_acme_failures_total` increases.

**Check:**

```sh
curl -s $NODE/metrics | grep apg_acme_failures_total      # the reason label says which step fails
```

and the node's log, which has the authority's own words.

| Reason | Usual cause |
|---|---|
| The authority cannot fetch the challenge | DNS for the name does not point at your gateway yet; port 80 does not reach a node; something in front redirects `/.well-known/acme-challenge/` |
| DNS-01 fails | The webhook did not create the record, or `APG_ACME_DNS_PROPAGATION_SECS` is too short for your DNS |
| Rate limited by the authority | Too many attempts for one name. Wait; the gateway backs off by itself |
| No account contact | `APG_ACME_EMAIL` is not set on the nodes |
| The domain is `pending` | Ownership has not been verified; a certificate is not requested until it is |

**Fix:** correct the cause. The gateway tries again by itself with increasing waits. To serve the name in the meantime, upload a certificate and switch the domain to `manual`.

## A certificate is about to expire

**You see:** the console's Overview lists it; `apg_certs_expiring{within="7d"}` above 0.

- **Automatic certificate:** renewal should have happened 30 days before expiry, so it is failing. Follow the runbook above.
- **Uploaded certificate:** upload its replacement under the **same name**. Every domain that uses it switches within a second or two; nothing else changes.

## Usage has gaps

**You see:** an hour missing or low in the Usage page; a customer's numbers disagree with yours.

**Check:**

```sh
curl -s $NODE/metrics | grep -E 'apg_usage_windows_pending|apg_usage_windows_dropped_total|apg_usage_flush_failures_total'
```

- `pending` above 0 and falling: a backlog is being delivered. Wait; affected hours are recalculated as windows arrive.
- `flush_failures` increasing: the node cannot deliver. Check its path to the control plane.
- `dropped` above 0: the node's queue passed a day's worth and the oldest windows were discarded. Those are gone.
- A node that was replaced while holding undelivered windows lost them with its disk, unless its data directory is on a persistent volume.

**Fix:** restore delivery. For billing that must survive a node's loss, give nodes a persistent data directory.

## A bad configuration was applied

**You see:** errors or misrouting right after a change.

**Find the change:**

```sh
apgctl revisions list            # applies and syncs
```

or the console's **Audit log**, filtered by time: every change with who made it and the resource before and after.

**Fix:**

- Applied with `apgctl`: `apgctl revisions rollback <id of the last good revision>`. It shows what would change and asks.
- A single edit: put the resource back from the audit entry's "before", in the console or with a `PUT`.
- One plugin type misbehaving everywhere: turn it off fleet-wide, `PUT /v1/flags/plugin_<type>` with `{"enabled": false}`.

Every one of these reaches all nodes within a second or two. Then find out why the change passed review: `apgctl diff` in CI shows exactly what an apply will do.

## A request goes to the wrong place

**You see:** a request reaches an unexpected service, gets a 404, or is refused by a plugin you did not expect.

**Check which route it hits, and why not the one you expected:**

```sh
apgctl route match --host api.example.com --path /orders/17 --method GET --header 'X-Beta: 1'
```

```
GET api.example.com/orders/17 -> route orders-api (workspace tier, prefix /orders)

Not chosen:
ROUTE         TIER       PATH              WHY
orders-beta   workspace  prefix /orders    the header 'x-beta' is missing or does not match
```

**Check which plugins run on that route:** the console, **Routes**, the layers icon; or `GET /v1/workspaces/{ws}/routes/{route}/effective-plugins`. It shows, per type, the instance that applies and the ones it overrode.

**Usual causes:** a system route matching before a tenant's; a higher `priority` elsewhere; a host not owned by the workspace (the request reaches system routes only); a plugin attached at workspace or global scope that you forgot.

## Rotating the secret key

**When:** on a schedule, or because the key may have leaked.

1. Generate a new key: `openssl rand -base64 32`.
2. On the control plane and on **every** node, set `APG_SECRET_KEY` to the new key and `APG_SECRET_KEY_PREVIOUS` to the old one. Roll the control plane first, then the nodes.

   From here on, new values are encrypted with the new key, and old values are still readable.
3. Re-write every encrypted value so that it is stored under the new key: upload each certificate again (same name, same files), and re-apply plugin secrets. Automatic certificates are re-encrypted when they renew; to force it sooner, recreate the domain.
4. When nothing is left under the old key, remove `APG_SECRET_KEY_PREVIOUS` everywhere.

A command that re-encrypts everything in one step does not exist yet. Until step 3 is complete, the old key must stay configured, and a leaked old key still opens the values not yet rewritten. If the key leaked, treat the certificates and plugin secrets as leaked too: reissue and replace them, which also completes step 3.

## Rotating tokens

- **A person's or CI's admin token:** create the new one, switch over, revoke the old (`apgctl delete token <name>`). Sessions opened with the old token end at once.
- **The node token:** create a second `node` token, roll nodes onto it, then revoke the first. Nodes keep serving throughout.

## Restoring from backup

See [backup and restore](backup.md).

## Upgrading, and going back

See [rolling out a new version, and rolling it back](rollout.md).
