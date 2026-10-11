# GitOps with apgctl

Keep the gateway's configuration in a repository, review changes as pull requests, and let CI apply them. `apgctl` is the tool for it.

## Set up

```sh
npm install -g apgctl
export APG_ADMIN_URL=https://admin.internal.example.com:9000
export APG_ADMIN_TOKEN=apg_at_…        # an editor token for the workspace
```

For several environments, named contexts save retyping:

```sh
apgctl config set-context staging --url https://admin.staging.example.com:9000 --token apg_at_…
apgctl config set-context prod    --url https://admin.prod.example.com:9000    --token apg_at_…
apgctl get routes --context staging
```

## Start from what is running

```sh
apgctl dump --file gateway/apg.yaml
```

The file describes the whole workspace. Secrets come out as `{ $secret: "***" }`, which means "keep what is stored" when applied, so the file is safe to commit.

Split it however you like; `-f` takes a directory and merges every `.yaml`, `.yml` and `.json` file in it:

```
gateway/
  10-services.yaml
  20-routes.yaml
  30-consumers.yaml
```

## The loop

```sh
apgctl validate -f gateway/      # shape, plugin settings, duplicate names; needs no server
apgctl diff -f gateway/          # what would change, field by field
apgctl apply -f gateway/ -m "add the invoices route"
```

```
~ route orders-api (default)
    /paths: [{"type":"prefix","value":"/orders"}] -> [{"type":"prefix","value":"/orders"},{"type":"prefix","value":"/v2/orders"}]
+ route invoices (default)
1 to create, 1 to update, 0 to delete, 14 unchanged
recorded revision 12 of default
```

- A document lands whole or not at all. One invalid route means nothing changes.
- Resources that already match are not touched: no new revision number, nothing sent to nodes.
- A changed secret shows as changed, never as its value.

## `apply` or `sync`

| | Creates and updates | Deletes what the files leave out |
|---|---|---|
| `apply` | yes | never |
| `sync` | yes | yes |

Use `sync` when the repository is the single source of truth. It shows the plan and asks; unattended it needs `--yes`.

If several teams keep their own files for one workspace, give each team's resources a label and let each sync only its own:

```sh
apgctl sync -f team-payments/ --select-label team=payments --yes
```

## Secrets

Never commit a secret. Reference an environment variable; `apgctl` fills it in before sending:

```yaml
version: 1
consumers:
  - name: partner
    credentials:
      - name: main
        type: key
        key: "${PARTNER_API_KEY}"
```

An unset variable stops the command before anything is sent. `${VAR:-default}` supplies a default.

## In CI

On every pull request:

```sh
apgctl validate -f gateway/
apgctl diff -f gateway/ --prune || [ $? -eq 2 ]     # 2 only means "there are changes"; print them for the reviewer
```

On merge:

```sh
apgctl sync -f gateway/ --yes -m "$GIT_COMMIT"
```

Give CI a token with the `editor` role scoped to the workspace, not an admin token.

## Revisions and going back

Every apply and sync is a revision of the workspace:

```sh
apgctl revisions list
```

```
NUMBER  ACTION  BY      WHEN                  CHANGES    MESSAGE
12      apply   ci      2026-06-01T12:00:00Z  +1 ~1 -0   add the invoices route
11      sync    ci      2026-05-28T09:14:00Z  +0 ~2 -1   3f9c2e1
```

```sh
apgctl revisions show <id>            # the document that was applied
apgctl revisions rollback <id>        # shows what would change, then asks
```

A rollback applies that revision's document again and is itself a new revision. With Git as the source of truth, reverting the commit and letting CI sync does the same.

## Drift

If someone changes the workspace through the console or the API between two syncs, `revisions list` says so:

```
The workspace has drifted from revision 12: it was changed outside apply and sync.
```

`apgctl diff -f gateway/ --prune` shows exactly what differs. Sync to put the files back in charge, or dump to accept what was changed.

## The same files without a control plane

The files are ordinary `apg.yaml`. A standalone node reads the same directory (`APG_CONFIG_FILE=/etc/apg/conf.d`). Two differences: in a file, secrets are `{ $env: APG_SECRET_… }` or `{ $file: … }`, read by the node; and certificates are named by path (`cert_file`, `key_file`).

All commands: [apgctl reference](../reference/cli.md).
