# valkv-apg — everything runs in Docker; no host toolchain is needed.
#
#   make up      build images and start the database-mode stack; waits until healthy
#   make unit    Rust and TypeScript unit tests plus the shared fixtures (no services)
#   make integ   integration and end-to-end tests against the running stack
#   make down    stop the stack and remove containers, networks and volumes

SHELL := /bin/sh
export DOCKER_BUILDKIT := 1

COMPOSE      := docker compose -f deploy/compose/database.yml -p valkv-apg
NODE_DOCKER  := crates/apg-proxy/Dockerfile
ADMIN_DOCKER := admin/Dockerfile
CLI_DOCKER   := cli/Dockerfile
MODE         ?= api_poll

.PHONY: up down unit unit-rust unit-admin unit-cli integ e2e e2e-resilience e2e-upgrade bench-propagation lint lint-rust lint-helm lint-terraform lint-debrand build logs ps help

help:
	@grep -E '^#   make' Makefile | sed 's/^#   //'

# The dev stack uses a quick unoptimised node build. Release images are built
# with CARGO_PROFILE=release (the Dockerfile's default) by the release workflow.
build:
	docker build -f $(NODE_DOCKER)  --target runtime --build-arg CARGO_PROFILE=dev -t valkv-labs/valkv-apg:dev .
	docker build -f $(ADMIN_DOCKER) --target runtime -t valkv-labs/valkv-apg-admin:dev .
	docker build -q -t valkv-apg-pebble:dev deploy/compose/pebble

up: build
	$(COMPOSE) up -d --wait
	@$(COMPOSE) ps

down:
	$(COMPOSE) down -v --remove-orphans

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

unit: unit-rust unit-admin unit-cli

unit-rust:
	docker build --progress=plain -f $(NODE_DOCKER) --target test-run -t valkv-apg:test-run .

unit-admin:
	docker build -q -f $(ADMIN_DOCKER) --target test -t valkv-apg-admin:test .
	docker run --rm valkv-apg-admin:test

unit-cli:
	docker build -q -f $(CLI_DOCKER) --target test -t valkv-apg-cli:test .
	docker run --rm valkv-apg-cli:test

# Admin integration tests against Postgres, the CLI against the running stack, then every end-to-end suite in
# api_poll mode against the running stack (spec §21).
integ:
	docker build -q -f $(ADMIN_DOCKER) --target test -t valkv-apg-admin:test .
	$(COMPOSE) run --rm admin-integ
	docker build -q -f $(CLI_DOCKER) --target test -t valkv-apg-cli:test .
	$(COMPOSE) run --rm cli-integ
	$(COMPOSE) run --rm --use-aliases e2e

STANDALONE := docker compose -f deploy/compose/standalone.yml -f deploy/compose/standalone.test.yml --profile test

# The routing, upstream and TLS suites in one mode. The runner hosts the upstream
# suite's test servers, so it joins the network under its service name.
# `file` uses its own stack (no control plane).
e2e:
ifeq ($(MODE),file)
	$(STANDALONE) up -d --wait node node-redirect
	$(STANDALONE) run --rm --use-aliases e2e; status=$$?; $(STANDALONE) down -v --remove-orphans; exit $$status
else
	$(COMPOSE) run --rm --use-aliases -e MODE=$(MODE) -e SUITE=routing,upstream,tls,plugins,usage e2e
endif

# Stops and starts containers to prove serving does not depend on the control
# plane, and that a node resyncs when it must. Needs `make up` first.
e2e-resilience:
	sh tests/e2e/resilience.sh

# A new process takes over a running node's listeners; no request may fail
# (spec PKG-7). Runs inside the node image, so it needs `make build` first.
e2e-upgrade:
	docker run --rm -v "$(CURDIR)/tests/e2e/upgrade.sh:/upgrade.sh:ro" --entrypoint sh valkv-labs/valkv-apg:dev /upgrade.sh

# Time from a committed change to a node serving it (spec NFR-3).
bench-propagation:
	$(COMPOSE) run --rm -w /repo/tests/bench e2e node propagation.js

lint: lint-rust

lint-rust:
	docker build --progress=plain -f $(NODE_DOCKER) --target lint -t valkv-apg:lint .

HELM      := docker run --rm -v "$(CURDIR)/deploy/helm:/charts:ro" alpine/helm:3.16.2
TERRAFORM := docker run --rm -v "$(CURDIR)/deploy/terraform:/tf" -w /tf/aws/environments/dev --entrypoint sh hashicorp/terraform:1.9 -c

# The chart with its defaults, and with every optional part switched on.
lint-helm:
	$(HELM) lint --strict /charts/valkv-apg
	$(HELM) template apg /charts/valkv-apg --set secrets.existingSecret=apg > /dev/null
	$(HELM) template apg /charts/valkv-apg --set secrets.existingSecret=apg --set canary.enabled=true --set canary.image.tag=next --set serviceMonitor.enabled=true --set networkPolicy.enabled=true > /dev/null

# Formatting and validity of the AWS reference. No account and no credentials are used.
lint-terraform:
	$(TERRAFORM) 'terraform fmt -check -recursive /tf && terraform init -backend=false -input=false > /dev/null && terraform validate; status=$$?; rm -rf .terraform .terraform.lock.hcl; exit $$status'

# Maintainers only: checks that nothing from the code's origin leaked into the
# tree. The script and its list are not published; the target is a no-op without them.
lint-debrand:
	@if [ -f tools/lint-debrand.pl ]; then perl tools/lint-debrand.pl .; else echo "lint-debrand: tools not present, skipped"; fi
