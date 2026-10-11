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
MODE         ?= api_poll

.PHONY: up down unit unit-rust unit-admin integ e2e e2e-resilience bench-propagation lint lint-rust lint-debrand build logs ps help

help:
	@grep -E '^#   make' Makefile | sed 's/^#   //'

# The dev stack uses a quick unoptimised node build. Release images are built
# with CARGO_PROFILE=release (the Dockerfile's default) by the release workflow.
build:
	docker build -f $(NODE_DOCKER)  --target runtime --build-arg CARGO_PROFILE=dev -t valkv-labs/valkv-apg:dev .
	docker build -f $(ADMIN_DOCKER) --target runtime -t valkv-labs/valkv-apg-admin:dev .

up: build
	$(COMPOSE) up -d --wait
	@$(COMPOSE) ps

down:
	$(COMPOSE) down -v --remove-orphans

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

unit: unit-rust unit-admin

unit-rust:
	docker build --progress=plain -f $(NODE_DOCKER) --target test-run -t valkv-apg:test-run .

unit-admin:
	docker build -q -f $(ADMIN_DOCKER) --target test -t valkv-apg-admin:test .
	docker run --rm valkv-apg-admin:test

# Admin integration tests against Postgres, then every end-to-end suite in
# api_poll mode against the running stack (spec §21).
integ:
	$(COMPOSE) run --rm admin-integ
	$(COMPOSE) run --rm --use-aliases e2e

STANDALONE := docker compose -f deploy/compose/standalone.yml --profile test

# The routing and upstream suites in one mode. The runner hosts the upstream
# suite's test servers, so it joins the network under its service name.
# `file` uses its own stack (no control plane).
e2e:
ifeq ($(MODE),file)
	$(STANDALONE) up -d --wait node node-redirect
	$(STANDALONE) run --rm --use-aliases e2e; status=$$?; $(STANDALONE) down -v --remove-orphans; exit $$status
else
	$(COMPOSE) run --rm --use-aliases -e MODE=$(MODE) -e SUITE=routing,upstream e2e
endif

# Stops and starts containers to prove serving does not depend on the control
# plane, and that a node resyncs when it must. Needs `make up` first.
e2e-resilience:
	sh tests/e2e/resilience.sh

# Time from a committed change to a node serving it (spec NFR-3).
bench-propagation:
	$(COMPOSE) run --rm -w /repo/tests/bench e2e node propagation.js

lint: lint-rust

lint-rust:
	docker build --progress=plain -f $(NODE_DOCKER) --target lint -t valkv-apg:lint .

# Maintainers only: checks that nothing from the code's origin leaked into the
# tree. The script and its list are not published; the target is a no-op without them.
lint-debrand:
	@if [ -f tools/lint-debrand.pl ]; then perl tools/lint-debrand.pl .; else echo "lint-debrand: tools not present, skipped"; fi
