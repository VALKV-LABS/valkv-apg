# syntax=docker/dockerfile:1
# Build context: the repository root (the cargo workspace).
#
# Targets:
#   toolchain  Rust plus the system libraries the workspace needs
#   test-run   runs the workspace unit tests as a build step; needs no services
#   lint       clippy with warnings denied
#   runtime    the node image (default)
#
# Build args:
#   CARGO_PROFILE  release (default; optimised, slow to build) or dev (quick, for local test stacks)
#
# The cargo registry and the target directory live in BuildKit cache mounts,
# not in layers, so a rebuild compiles only what changed.

FROM rust:1.92-slim-bookworm AS toolchain
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake libssl-dev pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && rustup component add rustfmt clippy
WORKDIR /app

FROM toolchain AS src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The JSON Schemas are compiled into the binary; the fixtures are read by tests.
COPY schemas ./schemas
COPY tests/fixtures ./tests/fixtures

# Running the tests is a build step so they can use the cache mounts.
FROM src AS test-run
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo test --workspace --locked

FROM src AS lint
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo clippy --workspace --all-targets --locked -- -D warnings

FROM src AS builder
ARG CARGO_PROFILE=release
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --locked --profile "${CARGO_PROFILE}" -p apg-proxy \
    && mkdir -p /out \
    && cp "target/$( [ "${CARGO_PROFILE}" = dev ] && echo debug || echo "${CARGO_PROFILE}" )/valkv-apg" /out/

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin apg \
    && mkdir -p /var/lib/apg /etc/apg && chown apg:apg /var/lib/apg
COPY --from=builder /out/valkv-apg /usr/local/bin/valkv-apg
USER apg
# The management port is reachable inside the container network (spec PKG-0);
# deployments keep it off public Services.
ENV APG_DATA_DIR=/var/lib/apg \
    APG_LISTEN_HTTPS=0.0.0.0:8443 \
    APG_LISTEN_HTTP=0.0.0.0:8080 \
    APG_LISTEN_MGMT=0.0.0.0:9100
EXPOSE 8443 8080 9100
HEALTHCHECK --interval=3s --timeout=2s --retries=20 CMD curl -fsS http://127.0.0.1:9100/readyz >/dev/null || exit 1
ENTRYPOINT ["valkv-apg"]
