# TLS and your own domains

A domain tells the gateway two things: that a workspace owns a host name, and where its certificate comes from.

| `tls.mode` | The certificate |
|---|---|
| `acme` | Obtained and renewed by the gateway from an ACME authority (Let's Encrypt by default) |
| `manual` | One you upload |
| `none` | None for this host; the gateway's fallback certificate is presented |

## Automatic certificates

Give nodes a contact address, which the authority requires:

```sh
APG_ACME_EMAIL=ops@example.com
```

Point the name's DNS at your gateway, then create the domain:

```yaml
version: 1
domains:
  - hostname: api.example.com
    tls: { mode: acme }
```

Within about a minute the gateway has proved to the authority that it answers for the name, received a certificate, and started serving it. No restart, and nothing for you to renew: certificates are replaced 30 days before they expire.

**How the proof works (HTTP-01).** The authority fetches a token from `http://api.example.com/.well-known/acme-challenge/…`. So port 80 must reach a node. With several nodes behind a load balancer, any node can answer: the token is shared through the control plane, one node does the issuing, and the certificate is distributed to all.

**Wildcards, and names not reachable on port 80 (DNS-01).** The proof is a TXT record instead:

```yaml
version: 1
domains:
  - hostname: "*.apps.example.com"
    tls: { mode: acme, challenge: dns01 }
```

The gateway has to put a TXT record in your DNS. If the zone is at Cloudflare it does that itself, with an API token allowed to edit DNS in the zone:

```sh
APG_ACME_DNS_PROVIDER=cloudflare
APG_CLOUDFLARE_API_TOKEN=<token with Zone: DNS: Edit on the zone>
```

It finds the zone from the name, adds the record beside any that are there, and removes its own afterwards.

For any other DNS host it calls a small service of yours that makes the change:

```sh
APG_ACME_DNS_PROVIDER=webhook
APG_ACME_DNS_WEBHOOK_URL=https://dns-hook.internal.example.com/
APG_ACME_DNS_WEBHOOK_SECRET=<shared secret>
```

Your service receives a signed `POST` with `{ "action": "present", "fqdn": "_acme-challenge.apps.example.com", "value": "…" }`, creates that TXT record and answers 2xx; later it receives `"action": "cleanup"` and removes it. `APG_ACME_DNS_PROPAGATION_SECS` is how long the gateway waits for the record to be visible.

**Another authority.** Set `APG_ACME_DIRECTORY_URL` to its directory, for example a private ACME server.

## Certificates you bring

Upload the certificate (leaf first, then its chain) and its key, then point the domain at it.

In a file, the node reads them from disk:

<!-- no-validate: names certificate files that exist only on your node -->
```yaml
version: 1
certificates:
  - name: example-2026
    cert_file: /etc/apg/certs/example.crt
    key_file: /etc/apg/certs/example.key
domains:
  - hostname: www.example.com
    tls: { mode: manual, certificate: example-2026 }
```

With a control plane, upload under **Domains & certificates** in the console, or:

```sh
curl -X PUT "$APG_ADMIN_URL/v1/workspaces/default/certificates/example-2026" \
  -H "Authorization: Bearer $APG_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile cert example.crt --rawfile key example.key '{cert_pem: $cert, key_pem: $key}')"
```

The key is checked against the certificate, encrypted before it is stored, and never returned by any API. To replace a certificate, upload the new one under the same name; nodes switch to it within a second or two.

## Which certificate a client gets

By the host name in the TLS handshake: an exact match first, then a wildcard that covers it. For a name with no certificate, the fallback: `APG_TLS_FALLBACK_CERT` and `APG_TLS_FALLBACK_KEY` if you set them, otherwise a self-signed certificate the node generates.

## Protocol versions and HTTP/2

`APG_TLS_MIN_VERSION` is `1.2` by default; set `1.3` to refuse older clients. HTTP/2 is negotiated automatically.

## Plain HTTP

By default the HTTP port answers ACME challenges and redirects everything else to HTTPS. `APG_HTTP_MODE=proxy` serves requests in clear instead; use that behind a load balancer that terminates TLS itself, or for a first try without certificates.

## TLS to your upstreams

Set `scheme: https` on the service. The upstream's certificate is verified by default; for a private authority, add its CA certificate and name it under the service's `tls.ca_certificates`. A service can also present a client certificate (`tls.client_certificate`).

## Watching expiry

- Console: **Overview** lists certificates expiring within 30 days; **Domains & certificates** shows every expiry.
- Metrics: `apg_certs_expiring{within="…"}`, `apg_acme_issuances_total`, `apg_acme_failures_total{reason}`.
- If issuance keeps failing, see the [runbook](../ops/runbooks.md#a-certificate-is-not-issued).
