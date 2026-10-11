# apgctl

The command-line client for [valkv-apg](../README.md). It keeps a gateway's configuration in files: check them, see what would change, apply them, and go back to an earlier revision.

```sh
npm install -g apgctl
export APG_ADMIN_URL=https://admin.internal.example:9000
export APG_ADMIN_TOKEN=apg_at_...

apgctl validate -f gateway/          # needs no server
apgctl diff -f gateway/              # exits 2 when something would change
apgctl apply -f gateway/ -m "add the orders route"
```

## Files

A document is `apg.yaml` as the node reads it in standalone mode. `-f` may be given several times, may name a directory (every `.yaml`, `.yml` and `.json` file in it, in name order), or may be `-` for standard input. Lists from several files are joined; the same name twice is an error.

`${VAR}` and `${VAR:-default}` are replaced from the environment before the file is parsed. A variable that is not set and has no default stops the command; nothing is sent.

```yaml
version: 1
services:
  - name: orders
    backends:
      - target: "${ORDERS_HOST}:8080"
routes:
  - name: orders-api
    service: orders
    hosts: [api.example.com]
    paths: [/orders]
    plugins:
      - type: key_auth
consumers:
  - name: mobile-app
    credentials:
      - name: main
        type: key
        key: "${MOBILE_APP_KEY}"
```

## Commands

| Command | What it does |
|---|---|
| `validate -f` | Checks shape, plugin settings, duplicate names and references. Needs no server. `--online` also checks against the workspace. |
| `diff -f [--prune]` | Shows what `apply` would change, field by field. With `--prune`, what `sync` would also delete. Exit code 2 when there is any difference. |
| `apply -f [-m]` | Creates and updates. Never deletes. All of it lands, or none of it. |
| `sync -f [--select-label k=v] [--yes] [-m]` | As `apply`, and deletes what the files leave out. Shows the plan and asks first; unattended, it needs `--yes`. A label limits what may be deleted. |
| `dump [--file out.yaml]` | Exports the workspace as a document. Secrets come out as `{ $secret: "***" }`, which `sync` reads as "keep what is stored". |
| `revisions list` | Every apply, sync and rollback, and whether the workspace has since been changed some other way. |
| `revisions show <id>`, `revisions rollback <id> [--yes]` | Shows a revision; applies it again as a new revision. |
| `route match --host --path [--method] [--header]` | Which route a request would hit, and why not the others, answered by a node. |
| `get <kind> [name]`, `create <kind> -f`, `delete <kind> <name>` | Single resources. |
| `tokens create --name --role`, `nodes`, `usage`, `cache purge <route>` | The rest of the Admin API. |

`-w <workspace>` picks the workspace (default: `default`, or the one the document names). `-o table|json|yaml` picks the output.

## Contexts

Instead of environment variables, keep named connections in `~/.config/apg/config.yaml` (readable by you only):

```sh
apgctl config set-context prod --url https://admin.prod.example:9000 --token apg_at_...
apgctl config use-context prod
apgctl get routes --context staging
```

A flag wins over the environment, and the environment wins over a context.

## In CI

```sh
apgctl validate -f gateway/                       # on every pull request
apgctl diff -f gateway/ --prune || [ $? -eq 2 ]   # print the plan; 2 only means "there are changes"
apgctl sync -f gateway/ --yes -m "$GIT_SHA"       # on merge
```
