# What the AWS reference costs

Rough monthly figures in US dollars, from on-demand list prices in `eu-west-1`. They are estimates to plan with, not a quote: check the AWS pricing calculator for your region and your discounts. Data transfer out to the internet is not included; it depends entirely on your traffic and is usually the largest line on a busy gateway.

## `environments/dev`

| Item | Size | About |
|---|---|---|
| Nodes | 2 × t4g.small | 27 |
| Admin | 1 × t4g.small | 13 |
| Database | db.t4g.micro, single zone, 20 GB gp3 | 16 |
| Network load balancer | 1, light traffic | 20 |
| Internal application load balancer | 1, light traffic | 20 |
| Secret, logs | 1 secret, a few GB of logs | 3 |
| **Total** | | **about 100** |

A NAT gateway is not created by the module. If you add one for this environment, it costs about 35 a month plus 0.048 per GB that passes through it.

## The module's defaults (a small production setup)

| Item | Size | About |
|---|---|---|
| Nodes | 2 × c7g.large (scales to 6) | 113, up to 340 |
| Admin | 2 × t4g.small | 27 |
| Database | db.t4g.small, two zones, 20 GB gp3 | 60 |
| Network load balancer | 1 | 20 plus usage |
| Internal application load balancer | 1 | 20 plus usage |
| Secret, logs | | 5 and up |
| **Total** | | **about 245 with two nodes** |

## Where the money goes as you grow

- **Nodes** scale with traffic. Size them on CPU: TLS handshakes and compression dominate.
- **The load balancer** charges per connection, per new connection and per GB processed.
- **Logs.** One access-log line per request adds up. At 1,000 requests a second that is about 60 GB a day, or roughly 1,000 a month to ingest. Turn access logs off (`access_log` setting), send them to a file and ship them with your own agent, or shorten `log_retention_days`.
- **The database** stays small. Configuration is a few megabytes; usage records are rolled up and pruned.

## Spending less

- Savings Plans or reserved instances for the two nodes that always run.
- One admin instance instead of two, if a few minutes without the Admin API during a replacement is acceptable. Nodes keep serving without it.
- A single-zone database outside production.
