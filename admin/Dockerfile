# syntax=docker/dockerfile:1
# Build context: the repository root (the admin needs schemas/ and tests/fixtures/).
#
# Targets:
#   test     runs type-check and unit tests; needs no services
#   runtime  the admin service with the console (default)

FROM node:22-slim AS deps
WORKDIR /repo/admin
COPY admin/package.json admin/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM deps AS src
COPY schemas /repo/schemas
COPY tests/fixtures /repo/tests/fixtures
# The plugin-type table is checked against the one the node uses.
COPY crates/apg-plugin-sdk/src/lib.rs /repo/crates/apg-plugin-sdk/src/lib.rs
COPY admin/tsconfig.json admin/vitest.config.ts admin/vitest.integ.config.ts admin/openapi.json* ./
COPY admin/migrations ./migrations
COPY admin/src ./src
COPY admin/test ./test

FROM src AS test
CMD ["sh", "-c", "npm run typecheck && npm test"]

FROM src AS build
RUN npm run build && npm prune --omit=dev

# The console, built from ui/ and served by the admin under /ui/.
FROM node:22-slim AS ui
WORKDIR /repo/ui
COPY ui/package.json ui/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY ui/tsconfig.json ui/vite.config.ts ui/index.html ./
COPY ui/public ./public
COPY ui/src ./src
RUN npx vite build

FROM node:22-slim AS runtime
ENV NODE_ENV=production APG_SCHEMAS_DIR=/app/schemas
WORKDIR /app
COPY --from=build /repo/admin/node_modules ./node_modules
COPY --from=build /repo/admin/dist ./dist
COPY --from=build /repo/admin/package.json ./
COPY admin/migrations ./migrations
COPY schemas ./schemas
COPY --from=ui /repo/ui/dist ./ui
USER node
EXPOSE 9000
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD node -e "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
