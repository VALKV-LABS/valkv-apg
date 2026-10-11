# Embedding the console

If you run a platform and want your customers to manage their own routes without leaving your product, you can show the console's workspace pages inside your own page, signed in as the customer.

## What gets embedded

With `?embed=1` the console drops its sidebar and top bar and shows one page. Only pages that belong to a workspace are available this way:

`/ui/routes`, `/ui/services`, `/ui/domains`, `/ui/plugins`, `/ui/consumers`, `/ui/usage`

Any other address is redirected to the routes page. Fleet-wide pages cannot be embedded.

## 1. Allow your origin to frame the console

By default nobody may. On the control plane:

```sh
APG_UI_EMBED_ORIGINS=https://portal.example.com
```

This sets the `frame-ancestors` policy of the console's pages, and is also the list of origins the console accepts a token from.

## 2. Let your platform's tokens act on the Admin API

The embedded console signs in with a token *your* system issues for the customer: a JWT that names the customer's workspace. Configure the control plane to accept them (see [many tenants on one gateway](multi-tenant.md)):

```sh
APG_ADMIN_JWT_JWKS_URL=https://portal.example.com/.well-known/jwks.json
APG_ADMIN_JWT_ISSUER=https://portal.example.com
APG_ADMIN_JWT_AUDIENCE=gateway
APG_ADMIN_JWT_WORKSPACE_CLAIM=tenant_id
```

Such a token can act only on the workspace named in its claim. Keep its lifetime short.

## 3. Put the frame in your page and hand over the token

```html
<iframe id="gateway" src="https://admin.example.com/ui/routes?embed=1" title="API gateway routes"
        style="width: 100%; height: 720px; border: 0"></iframe>

<script>
  const frame = document.getElementById("gateway");
  const consoleOrigin = "https://admin.example.com";

  window.addEventListener("message", async (event) => {
    if (event.origin !== consoleOrigin || event.data?.type !== "apg:ready") return;
    const token = await fetchGatewayTokenForCurrentCustomer();   // from your own backend
    frame.contentWindow.postMessage({ type: "apg:token", token }, consoleOrigin);
  });
</script>
```

The console tells the parent page when it is ready (`apg:ready`), and waits. The token arrives by `postMessage`, is kept in memory only, and is sent as a bearer token on each call. It is never put in the address bar, a cookie or browser storage.

When the token expires the console goes back to waiting and announces `apg:ready` again; answer with a fresh token.

## Making it look like yours

```sh
APG_UI_BRAND_NAME="Acme Cloud"
APG_UI_LOGO_URL=https://portal.example.com/logo.svg
APG_UI_PRIMARY_COLOR=#0f766e
```

The console has a light and a dark theme and follows the visitor's system setting. Text on the accent colour is chosen automatically to stay readable.

## What the customer can and cannot do there

Exactly what the token allows: with the `editor` role, manage the routes, services, domains, plugins and consumers of their own workspace; with `viewer`, look. Every rule in [workspaces and who owns a host](../concepts/workspaces.md) applies, because the embedded console uses the same public API as everything else.

## Checklist

- The console is served over HTTPS, and so is your page.
- `APG_UI_EMBED_ORIGINS` lists your page's origin exactly, with no path.
- Your `message` handler checks `event.origin` before answering, as above.
- Tokens are issued by your backend per customer, never shared between customers.
