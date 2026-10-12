# 7. One Terraform reference, for AWS

Status: accepted

## Context

People ask how to run the gateway on their cloud. A reference deployment answers that, and each one is code that must be kept working: validated in CI, updated with provider releases, and reviewed for what it exposes.

## Decision

The repository carries one Terraform reference, for AWS, under `deploy/terraform/aws`. Other environments are served by things that are not specific to a cloud: the container images, the Helm chart, the Compose files and the systemd unit.

## Consequences

- One reference that is validated on every change, rather than several that drift.
- On other clouds, the AWS reference is still a readable description of the shape: a network load balancer in front of a group of nodes, the control plane behind an internal one, managed Postgres, secrets in the provider's secret store, nodes never reaching the database.
- The reference is validated, not applied, by CI. It has not been exercised against a live account by the project.
- A second cloud can be added when someone will maintain it.
