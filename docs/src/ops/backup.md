# Backup and restore

## What to back up

| What | Where | Why |
|---|---|---|
| The Postgres database | Your database server | All configuration, certificates, credentials (as hashes), the audit log, revisions and usage |
| `APG_SECRET_KEY` | Your secret store | Without it the private keys and plugin secrets in the database cannot be read |

That is all. Nodes hold nothing that cannot be rebuilt: their data directory is a cache.

Back the two up **separately**. A database dump alone reveals no private key; together with the secret key it reveals all of them.

In standalone mode there is no database. Back up the configuration file (it should be in version control anyway) and, if the node obtains certificates itself, its data directory, to avoid asking the authority again after a rebuild.

## Taking a backup

Use whatever you use for Postgres: managed snapshots with point-in-time recovery, or

```sh
pg_dump --format=custom --no-owner "$APG_DATABASE_URL" > apg-$(date +%F).dump
```

A dump taken while the control plane is running is consistent: every change is one transaction.

Also useful, and readable by a person: the configuration of each workspace as a document.

```sh
apgctl dump -w default --file default.yaml
```

A dump of this kind holds no secrets (they are placeholders), so it cannot restore keys and passwords on its own. It is a record, and a way to rebuild routing, not a substitute for the database backup.

## Restoring

1. Stop the control plane.
2. Restore the database.

   ```sh
   pg_restore --clean --if-exists --no-owner --dbname "$APG_DATABASE_URL" apg-2026-06-01.dump
   ```

3. Start the control plane with the **same** `APG_SECRET_KEY`.
4. Nodes notice that the feed they were following has gone backwards, discard what they hold, and take a fresh snapshot. No action on the nodes is needed, and they keep serving their previous configuration until the snapshot is applied.

Check afterwards:

```sh
apgctl nodes          # every node LIVE with LAG 0
sh tests/smoke.sh
```

## Restoring into a new environment

Restoring a dump into a *different* database server, for a second environment or after losing the first, works the same way. Nodes pointed at the new control plane see an identity they do not know and resynchronise.

What does not carry over: certificates issued after the backup was taken. Domains with automatic certificates get new ones; this takes a minute or so per domain and counts against the authority's rate limits.

## What is lost between the backup and the failure

Configuration changes, audit entries and usage reported in that window. Usage that nodes had not yet reported is not lost: nodes queue it for up to a day and deliver it to the restored control plane.

If configuration is also kept in Git and applied with `apgctl`, re-running the last sync brings routing back to the present.

## If the secret key is lost

The database is intact, but no node can open private keys or plugin secrets, and no credential hash is affected. Recovery is manual:

1. Set a new `APG_SECRET_KEY` on the control plane and the nodes.
2. Upload certificates again (or let automatic ones be reissued by deleting and recreating their domains).
3. Write plugin secrets again (`jwt_auth` shared secrets, `http_callout` signing secrets).

API keys, passwords and admin tokens are hashes and keep working.

## Rehearse it

A restore you have not tried is a hope. Restore last night's dump into a scratch database, start a control plane and one node against it, and run the smoke test.
