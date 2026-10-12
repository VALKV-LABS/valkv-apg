# 5. Health endpoints are not answered on traffic ports

Status: accepted

## Context

Load balancers and orchestrators need to ask a node whether it is alive and ready. If the node answered `/healthz` on its traffic ports, every upstream's own `/healthz` would be hidden behind the gateway's, for every host.

## Decision

Liveness, readiness, metrics and status are served on a separate management listener, bound to loopback by default and never to a traffic listener. Nothing the gateway answers for itself occupies a path on a traffic port, except ACME challenges on port 80.

A load balancer that can only probe the traffic port can be given one path of the operator's choosing, `APG_TRAFFIC_HEALTH_PATH`, which is unset by default.

## Consequences

- Every path on every host is available to upstreams.
- The management listener needs no credentials, so it must stay off the internet; it shows configuration counts and the route tester.
- Deployments expose the management port to probes and monitoring deliberately: the container image binds it to all interfaces inside the container network, the Helm chart keeps it off the public Service and restricts it with a network policy, and the systemd unit leaves it on loopback.
- "Ready" can mean what it should, that the node holds a complete configuration, without being confused with "the upstream is healthy".
