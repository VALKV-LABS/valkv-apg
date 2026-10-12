# valkv-apg — everything runs in Docker; no host toolchain is needed.
#
#   make up      build images and start the database-mode stack; waits until healthy
#   make unit    Rust and TypeScript unit tests plus the shared fixtures (no services)
#   make integ   integration and end-to-end tests against the running stack
#   make down    stop the stack and remove containers, networks and volumes
#   make prepush everything CI runs on a pull request, on its own containers
#   make hooks   run `make prepush` before every git push from this clone

SHELL := /bin/sh
export DOCKER_BUILDKIT := 1

COMPOSE      := docker compose -f deploy/compose/database.yml -p valkv-apg
NODE_DOCKER  := crates/apg-proxy/Dockerfile
ADMIN_DOCKER := admin/Dockerfile
CLI_DOCKER   := cli/Dockerfile
UI_DOCKER    := ui/Dockerfile
MODE         ?= api_poll

.PHONY: prepush hooks up down unit unit-rust unit-admin unit-cli unit-ui integ e2e e2e-resilience e2e-upgrade e2e-skew e2e-security smoke canary-rehearsal docs docs-check docs-quickstart check-keys bench-propagation bench-scale bench-throughput lint lint-rust lint-helm lint-terraform lint-debrand build logs ps help

# What CI runs on a pull request (.github/workflows/ci.yml), in the same order
# of cost: cheap checks first. The stacks it starts publish nothing on the host
# and have their own project names, so a development stack started with
# `make up` keeps running, with its data, while this runs.
PREPUSH_DB   := docker compose -f deploy/compose/database.yml -f deploy/compose/isolated.database.yml -p apg-prepush
PREPUSH_FILE := docker compose -f deploy/compose/standalone.yml -f deploy/compose/standalone.test.yml -f deploy/compose/isolated.standalone.yml -p apg-prepush-file --profile test

prepush:
	$(MAKE) lint-debrand lint-rust lint-helm lint-terraform
	$(MAKE) unit check-keys
	$(MAKE) build
	$(MAKE) docs-check docs-quickstart e2e-upgrade
	$(MAKE) e2e MODE=file STANDALONE='$(PREPUSH_FILE)'
	$(PREPUSH_DB) up -d --wait
	$(MAKE) integ e2e-resilience e2e-security e2e-skew smoke canary-rehearsal COMPOSE='$(PREPUSH_DB)'; status=$$?; $(PREPUSH_DB) down -v --remove-orphans; exit $$status
	@echo "prepush ok: everything CI runs on a pull request passed here"

# Once per clone. Git does not take hooks from a repository unless told to.
hooks:
	git config core.hooksPath .githooks
	@echo "git push from this clone now runs 'make prepush' first. Skip once with APG_SKIP_PREPUSH=1."

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

unit: unit-rust unit-admin unit-cli unit-ui

unit-rust:
	docker build --progress=plain -f $(NODE_DOCKER) --target test-run -t valkv-apg:test-run .

unit-admin:
	docker build -q -f $(ADMIN_DOCKER) --target test -t valkv-apg-admin:test .
	docker run --rm valkv-apg-admin:test

unit-ui:
	docker build -q -f $(UI_DOCKER) --target test -t valkv-apg-ui:test .
	docker run --rm valkv-apg-ui:test

unit-cli:
	docker build -q -f $(CLI_DOCKER) --target test -t valkv-apg-cli:test .
	docker run --rm valkv-apg-cli:test

# Admin integration tests against Postgres, the CLI and the console against the running stack, then every end-to-end suite in
# api_poll mode against the running stack (spec §21).
integ:
	docker build -q -f $(ADMIN_DOCKER) --target test -t valkv-apg-admin:test .
	$(COMPOSE) run --rm admin-integ
	docker build -q -f $(CLI_DOCKER) --target test -t valkv-apg-cli:test .
	$(COMPOSE) run --rm cli-integ
	docker build -q -t valkv-apg-ui-e2e:test ui/e2e
	$(COMPOSE) run --rm ui-e2e
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
	APG_COMPOSE='$(COMPOSE)' sh tests/e2e/resilience.sh

# Change events from a newer control plane must be stepped over, never fatal (spec PKG-2).
e2e-skew:
	APG_COMPOSE='$(COMPOSE)' sh tests/e2e/skew.sh

# Tenant isolation and the egress guard, then a search of every container's logs for secrets (spec SEC-4, SEC-7, SEC-8).
e2e-security:
	APG_COMPOSE='$(COMPOSE)' sh tests/e2e/security.sh

# One request through every class of plugin, and a change seen on every node (spec PKG-6).
# Against the Compose stack here; against any deployment with tests/smoke.sh.
smoke:
	MSYS_NO_PATHCONV=1 $(COMPOSE) run --rm -e APG_ADMIN_URL=http://admin:9000 -e APG_ADMIN_TOKEN=apg_at_dev-only-admin-token-do-not-use -e APG_GATEWAY_URL=http://node:8080 -e SMOKE_TLS_URL=https://node:8443 -e SMOKE_SKIP_USAGE e2e node /repo/tests/smoke.mjs

# A canary stage that is promoted, one with injected errors that is rolled back, and the rollback itself.
canary-rehearsal:
	APG_COMPOSE='$(COMPOSE)' sh tests/canary/rehearse.sh

# A new process takes over a running node's listeners; no request may fail
# (spec PKG-7). Runs inside the node image, so it needs `make build` first.
e2e-upgrade:
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR)/tests/e2e/upgrade.sh:/upgrade.sh:ro" --entrypoint sh valkv-labs/valkv-apg:dev /upgrade.sh

# One snapshot of 100,000 routes, 20,000 workspaces, 100,000 domains and 200,000 consumers:
# build time, match time, memory (spec NFR-4). Optimised build of the core crate only.
bench-scale:
	docker build -q -f $(NODE_DOCKER) --target toolchain -t valkv-apg:toolchain .
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR):/app" -v apg-cargo-registry:/usr/local/cargo/registry -v apg-target:/target \
		-e CARGO_TARGET_DIR=/target -w /app valkv-apg:toolchain cargo test --release --locked -p apg-core nfr4 -- --ignored --nocapture

# Requests per second and latency through one node, against the upstream alone (spec NFR-1, NFR-2).
bench-throughput:
	sh tests/bench/throughput.sh

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

TOOLS := docker run --rm -v "$(CURDIR):/repo" -w /repo node:22-slim

# Regenerates the reference pages from the schemas, the OpenAPI document and the code, then builds the book into docs/book.
docs:
	MSYS_NO_PATHCONV=1 $(TOOLS) node tools/gen-docs.mjs
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR)/docs:/book" -w /book peaceiris/mdbook:v0.4.40 build

# Fails when a generated page is stale, when a configuration example in the docs is not valid,
# or when a page is missing from the table of contents. Needs `make build` for the node image.
docs-check:
	MSYS_NO_PATHCONV=1 $(TOOLS) sh -c "node tools/gen-docs.mjs --check && node tools/check-doc-links.mjs && rm -rf .doc-examples && node tools/extract-doc-examples.mjs .doc-examples"
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR)/.doc-examples:/examples:ro" -v "$(CURDIR)/tools/check-doc-examples.sh:/check.sh:ro" --entrypoint sh valkv-labs/valkv-apg:dev /check.sh
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR)/docs:/book" -w /book peaceiris/mdbook:v0.4.40 build -d /tmp/book

# The quickstart of the documentation, executed step by step against the node image.
docs-quickstart:
	sh tests/docs/quickstart-standalone.sh

# Every configuration key of every plugin, and every field of Service and Route, is set by some test.
check-keys:
	MSYS_NO_PATHCONV=1 $(TOOLS) node tools/check-tested-keys.mjs

# Maintainers only: checks that nothing from the code's origin leaked into the
# tree. The script and its list are not published; the target is a no-op without them.
lint-debrand:
	@if [ -f tools/lint-debrand.pl ]; then perl tools/lint-debrand.pl .; else echo "lint-debrand: tools not present, skipped"; fi
