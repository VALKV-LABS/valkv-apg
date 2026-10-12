# syntax=docker/dockerfile:1
# Build context: the repository root (tests read schemas/).
#
# Targets:
#   test   type-check and component tests; needs no services
#   dist   the built console, as files (the admin image copies them)

FROM node:22-slim AS deps
WORKDIR /repo/ui
COPY ui/package.json ui/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM deps AS src
COPY schemas /repo/schemas
COPY ui/tsconfig.json ui/vite.config.ts ui/index.html ./
COPY ui/public ./public
COPY ui/src ./src

FROM src AS test
CMD ["sh", "-c", "npm run typecheck && npm test"]

FROM src AS build
RUN npx vite build

FROM scratch AS dist
COPY --from=build /repo/ui/dist /
