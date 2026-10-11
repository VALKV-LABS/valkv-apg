## When to use it

For machine-to-machine traffic where each caller holds a client certificate from an authority you trust. The gateway asks for a certificate during the TLS handshake on the hosts of routes that use this plugin, and checks its chain. Revocation lists are not consulted: revoke by removing the consumer's credential or the CA.

## Examples

Only certificates from the internal authority, each mapped to a consumer by DNS name:

<!-- no-validate: names certificate files that exist only on your node -->
```yaml
version: 1
ca_certificates:
  - name: internal-ca
    cert_file: /etc/apg/certs/internal-ca.crt
services:
  - name: ledger
    backends:
      - target: "10.0.0.9:8443"
routes:
  - name: ledger-api
    service: ledger
    hosts: [ledger.internal.example.com]
    plugins:
      - type: mtls_auth
        config:
          ca_certificates: [internal-ca]
consumers:
  - name: billing-service
    credentials:
      - name: cert
        type: mtls
        identity: billing.internal.example.com
```

Any certificate from the authority is enough; no consumer is looked up:

<!-- no-validate: names certificate files that exist only on your node -->
```yaml
version: 1
ca_certificates:
  - name: partner-ca
    cert_file: /etc/apg/certs/partner-ca.crt
services:
  - name: feed
    backends:
      - target: "10.0.0.10:8080"
routes:
  - name: partner-feed
    service: feed
    hosts: [feed.example.com]
    plugins:
      - type: mtls_auth
        config:
          ca_certificates: [partner-ca]
          skip_consumer_lookup: true
```

## What clients and upstreams see

- No certificate, or one that does not lead to a listed CA: `401 UNAUTHENTICATED`.
- A valid certificate that matches no credential (and no `anonymous` consumer is set): `401 UNAUTHENTICATED`.
- Requests over plain HTTP cannot carry a certificate and are refused.

## Goes well with

`acl` for groups of services; upstream TLS with a client certificate (`service.tls.client_certificate`) when the hop behind the gateway is mutually authenticated too.
