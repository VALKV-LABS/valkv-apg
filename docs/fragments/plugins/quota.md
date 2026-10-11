## When to use it

To give a caller an allowance per calendar hour, day or month (UTC): the "10,000 calls a month" of a pricing plan. Where `rate_limit` shapes speed, `quota` counts a total. It is counted on each node, like `rate_limit`.

## Examples

A thousand calls a day for each consumer:

```yaml
version: 1
services:
  - name: search
    backends:
      - target: "10.0.0.23:8080"
routes:
  - name: search
    service: search
    paths: [/search]
    plugins:
      - type: key_auth
      - type: quota
        config:
          limit: 1000
          window: day
          scope: consumer
```

A free tier for every consumer, and a larger allowance for one paying consumer:

```yaml
version: 1
services:
  - name: geocode
    backends:
      - target: "10.0.0.24:8080"
routes:
  - name: geocode
    service: geocode
    paths: [/geocode]
    plugins:
      - type: key_auth
      - type: quota
        config:
          limit: 10000
          window: month
          scope: consumer
      - type: quota
        consumer: enterprise-customer
        config:
          limit: 5000000
          window: month
          scope: consumer
consumers:
  - name: enterprise-customer
```

## What clients see

`429 QUOTA_EXCEEDED` until the window ends.

## Goes well with

`rate_limit`, so that an allowance cannot be spent in one burst; the usage API when you bill for what was actually used.
