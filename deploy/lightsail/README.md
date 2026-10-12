# Try valkv-apg on Amazon Lightsail

One small instance running the whole thing: the gateway, the control plane with its console, Postgres, and two sample upstreams to route to. It takes one command and a few minutes, and costs about 12 US dollars a month for as long as you keep it.

This is for trying the product. It is not how to run it in production: everything shares one machine and the Admin API speaks plain HTTP. For production see [the AWS reference](../terraform/aws/README.md) or [the Helm chart](../helm/valkv-apg).

## Start it

You need the [AWS CLI](https://docs.aws.amazon.com/cli/) signed in to an account that may use Lightsail, and `curl`.

```sh
sh deploy/lightsail/launch.sh
```

The script:

1. creates an Ubuntu instance (2 GB of memory) and installs Docker on it;
2. starts the stack from [`docker-compose.yml`](docker-compose.yml) and loads [`demo.json`](demo.json): three routes, one of them behind an API key and a rate limit;
3. opens ports 80 and 443 to everyone, and the console's port 9000 to **your address only**;
4. prints the console's address, the admin token and commands to try;
5. runs the [smoke test](../../tests/smoke.mjs) against the new deployment and prints, for each feature, what was expected and what happened.

```
RESULT  FEATURE                       EXPECTED                                    ACTUAL
PASS    Routing by host               200, and the upstream sees the path         200, upstream path /hello/world
PASS    API key authentication        no key 401, right key 200 as smoke-staff…   no key 401, right key 200 as smoke-staff
PASS    Rate limit                    2 requests pass, the 3rd is 429 with Ret…   200, 200, 429, Retry-After 1000
…
24 of 24 checks passed.
```

To run the smoke test again later, the script tells you where it kept the addresses and the token (`deploy/lightsail/.trial-<name>`; that file is ignored by git):

```sh
. deploy/lightsail/.trial-valkv-apg-trial
APG_ADMIN_URL=http://$APG_TRIAL_IP:9000 APG_GATEWAY_URL=http://$APG_TRIAL_IP \
  APG_ADMIN_TOKEN=$APG_ADMIN_TOKEN sh tests/smoke.sh
```

## Use your own domain

Point a DNS record at the instance's address, then in the console add the host name under **Domains & certificates** with an automatic certificate. The gateway asks an ACME authority for a certificate (set `APG_ACME_EMAIL` in `/opt/valkv-apg/.env` on the instance and run `docker compose up -d` there first) and serves it within a minute or so.

## Settings

| Variable | Default | What |
|---|---|---|
| `APG_TRIAL_NAME` | `valkv-apg-trial` | Name of the instance |
| `AWS_REGION` | the CLI's default | Region |
| `APG_TRIAL_BUNDLE` | `small_3_0` | Instance size |
| `APG_VERSION` | `latest` | Image tag of `valkv-labs/valkv-apg` and `valkv-labs/valkv-apg-admin` |
| `APG_ADMIN_CIDR` | this machine's address | Who may reach the console and the Admin API |
| `SKIP_SMOKE` | unset | Set to `1` to skip the smoke test |

## Stop paying for it

```sh
sh deploy/lightsail/destroy.sh
```

That deletes the instance, which is the only thing that was created.

## The same stack on your own machine

No AWS account is needed for this:

```sh
cd deploy/lightsail
APG_HTTP_PORT=8080 APG_HTTPS_PORT=8443 sh up.sh
```

## What to know before relying on it

- The admin token and the demo key are generated on your machine and passed to the instance in its first-boot script. Anyone who can read the instance's metadata in your AWS account can read them. Treat the trial as disposable.
- The images are pulled from Docker Hub. A version that has not been published cannot be launched this way.
- Logs of the first boot are in `/var/log/valkv-apg-trial.log` on the instance.
