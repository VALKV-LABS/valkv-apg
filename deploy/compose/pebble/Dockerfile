# A test ACME authority for the development and test stacks. Never for production.
# Built from source so the stacks depend on one registry only.
FROM golang:1.25-alpine AS build
ARG PEBBLE_VERSION=v2.8.0
RUN go install github.com/letsencrypt/pebble/v2/cmd/pebble@${PEBBLE_VERSION} \
    && cp -r "$(go env GOMODCACHE)/github.com/letsencrypt/pebble/v2@${PEBBLE_VERSION}/test/certs" /certs

FROM alpine:3
COPY --from=build /go/bin/pebble /usr/bin/pebble
# The certificate the authority's own API is served with.
COPY --from=build /certs /test/certs
COPY pebble-config.json /config/pebble-config.json
WORKDIR /
ENTRYPOINT ["/usr/bin/pebble"]
CMD ["-config", "/config/pebble-config.json"]
