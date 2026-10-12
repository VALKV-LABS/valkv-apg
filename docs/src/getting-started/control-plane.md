# With a control plane and the console

In this mode configuration lives in Postgres. You change it through the Admin API, the console or `apgctl`, and every gateway picks the change up within a second or two.

## The quickest way: one command

The repository has a ready-made stack: the gateway, the control plane with the console, Postgres, and two small upstreams.

```sh
git clone https://github.com/VALKV-LABS/valkv-apg
cd valkv-apg/deploy/lightsail
APG_HTTP_PORT=8080 APG_HTTPS_PORT=8443 sh up.sh
```

It prints the console's address, an admin token and a few commands to try:

```
valkv-apg is up.

  Console      http://127.0.0.1:9000/ui/        sign in with the admin token below
  Admin token  apg_at_…
  Gateway      http://127.0.0.1:8080
```

The same directory can start this stack on a cloud instance; see `deploy/lightsail/README.md`.

## Sign in

Open the console and paste the admin token. The token is exchanged for a session cookie; the browser does not keep the token.

What you see:

- **Overview**: traffic, errors and latency of the last day; nodes; certificates about to expire; recent changes.
- **Routes, Services, Domains & certificates, Plugins, Consumers**: the configuration of the selected workspace. The switcher at the top left changes workspace.
- **Usage, Config, Audit log**: what was served, the configuration as a document with its revisions, and who changed what.
- **Workspaces, Nodes, Settings**: fleet-wide pages, shown to fleet administrators only.

## Make a change and watch it arrive

1. Under **Services**, open `echo`. It has one backend.
2. Under **Routes**, choose **New route**. Name it `try`, pick the service `echo`, add the path `["/try"]`, and save.
3. Within a second or two:

   ```sh
   curl http://127.0.0.1:8080/try/anything
   ```

4. On the Routes page, use the **route tester**: enter a host and a path, and a node tells you which route the request would hit, and why each other route was not chosen.

## The same change from a terminal

```sh
export APG_ADMIN_URL=http://127.0.0.1:9000
export APG_ADMIN_TOKEN=apg_at_…

curl -X PUT "$APG_ADMIN_URL/v1/workspaces/default/routes/try2" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"service": "echo", "paths": ["/try2"]}'
```

`PUT` by name creates the route or replaces it, so the command can be run again safely. Everything the console does goes through this API; see the [Admin API reference](../reference/admin-api.md).

## What runs where

```
clients ─▶ gateway (node) ─▶ your services
              │  asks for changes
              ▼
        control plane (admin) ─▶ Postgres
              ▲
     console, apgctl, your scripts
```

The gateway holds no database connection. It keeps a copy of its configuration on disk, so it starts and serves even when the control plane is down.

## Next

- [A first route with a key and a rate limit](first-route.md)
- [GitOps with apgctl](../guides/gitops.md): keep the configuration in files
- [Deploying](../ops/deploy.md) for real
