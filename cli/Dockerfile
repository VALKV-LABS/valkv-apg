# syntax=docker/dockerfile:1
# Build context: the repository root (the CLI bundles schemas/).
#
# Targets:
#   test     type-check and unit tests; needs no services
#   runtime  the apgctl command (default)

FROM node:22-slim AS deps
WORKDIR /repo/cli
COPY cli/package.json cli/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM deps AS src
COPY schemas /repo/schemas
COPY tests/fixtures /repo/tests/fixtures
COPY cli/tsconfig.json cli/vitest.config.ts cli/vitest.integ.config.ts ./
COPY cli/src ./src
COPY cli/test ./test
RUN npm run build

FROM src AS test
CMD ["sh", "-c", "npm run typecheck && npm test"]

FROM src AS build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/cli/node_modules ./node_modules
COPY --from=build /repo/cli/dist ./dist
COPY --from=build /repo/cli/package.json ./
COPY schemas ./schemas
USER node
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/apgctl.js"]
