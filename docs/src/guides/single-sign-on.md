# Single sign-on for the console

People can sign in to the console through your identity provider with OpenID Connect, instead of pasting an admin token. Any provider that implements the standard works: Okta, Microsoft Entra ID, Keycloak, Google, Auth0 and others.

What a person may do is decided by a group (or any other claim) in the token the provider issues. There is no default role: someone who is in none of the groups you list cannot get in.

## 1. Register the console with your provider

Create an application of the "web" kind, using the authorisation code flow.

| Setting at the provider | Value |
|---|---|
| Redirect URI | `https://<your admin address>/v1/session/oidc/callback` |
| Scopes | `openid profile email`, plus whatever makes the provider include groups |
| Client authentication | A client secret (or none, for a public client; PKCE is always used) |

Make sure the ID token carries the claim you want to decide by. Most providers need a setting for a `groups` claim.

## 2. Configure the control plane

```sh
APG_PUBLIC_URL=https://admin.example.com
APG_OIDC_ISSUER=https://login.example.com/realms/main
APG_OIDC_CLIENT_ID=valkv-apg-console
APG_OIDC_CLIENT_SECRET=…
APG_OIDC_ROLE_CLAIM=groups
APG_OIDC_ROLE_MAP={"gateway-admins":{"role":"admin","workspaces":["*"]},"acme-developers":{"role":"editor","workspaces":["acme"]},"support":{"role":"viewer","workspaces":["*"]}}
```

- `APG_PUBLIC_URL` is how browsers reach the control plane. The provider sends people back there, so it cannot be guessed from a request.
- `APG_OIDC_ISSUER` must be exactly the issuer the provider puts in its tokens. The control plane reads the provider's endpoints from `<issuer>/.well-known/openid-configuration`.
- `APG_OIDC_ROLE_MAP` maps a value of the claim to a role and a list of workspaces, by name or id; `["*"]` is all of them. Entries are tried in the order written, and the first one the person has wins, so put the most powerful group first.
- `APG_OIDC_ROLE_CLAIM` may reach into nested claims with dots, for example `realm_access.roles`.

The control plane refuses to start with single sign-on half configured: an issuer without a role map, or a map with nobody in it.

## 3. Sign in

The console's sign-in page now shows **Sign in with single sign-on**. Signing in with an admin token stays possible, which is what scripts and `apgctl` use, and what you fall back on if the provider is down.

The audit log records the person (their e-mail address, or user name) as the actor of every change they make.

## How it works

Authorisation code flow with PKCE:

1. The browser is sent to the provider with a `state`, a `nonce` and a code challenge. A short-lived, encrypted, HttpOnly cookie ties the answer to this browser.
2. The provider sends the browser back with a code. The control plane exchanges it for an ID token over a direct connection to the provider.
3. The ID token's signature is checked against the provider's published keys, and its issuer, audience, expiry and nonce are checked.
4. The role claim is looked up in the map. A match opens a session; no match is refused with a page that says so.

## Sessions

A session lasts 12 hours. It holds the role and workspaces granted at sign-in, so removing someone from a group takes effect at their next sign-in, not at once. To end sessions immediately, restart is not needed: delete the rows of `apg_sessions` in the database, or shorten the window by having people sign out.

The session cookie is HttpOnly and SameSite=Strict, and every request that changes something must carry a CSRF token that only the console's own pages can read.

## Troubleshooting

| What the person sees | Cause |
|---|---|
| "…is signed in, but is in no group that has access to this gateway" | None of the values of the role claim is in `APG_OIDC_ROLE_MAP`. Check that the claim is in the **ID token** and what it is called. |
| "…none of the workspaces granted to them exists" | The map names a workspace that has not been created. |
| "this sign-in was not started in this browser, or it took too long" | The sign-in took more than ten minutes, cookies are blocked, or the address the person used differs from `APG_PUBLIC_URL`. |
| "the ID token did not pass verification" | Issuer or client id do not match what the provider issues, or the clocks differ by more than a minute. |
| "the identity provider cannot be reached" | The control plane cannot fetch the provider's discovery document. |
| The provider shows "invalid redirect URI" | The redirect URI registered at the provider is not exactly `<APG_PUBLIC_URL>/v1/session/oidc/callback`. |

## What this is not

This signs *people* in to the *console*. To authenticate callers of your APIs with tokens from an identity provider, use the [`jwt_auth`](../reference/plugins/jwt_auth.md) plugin. To let another product's own tokens act on the Admin API, see [many tenants on one gateway](multi-tenant.md).
