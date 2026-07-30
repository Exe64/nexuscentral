# syntax=docker/dockerfile:1
#
# Build context is the repository root -- the API depends on @feedhub/shared and
# on the workspace lockfile.
#
#   docker build -f apps/api/Dockerfile -t feedhub-api .

# --- build -------------------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile --filter '@feedhub/api...'

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @feedhub/shared build \
 && pnpm --filter @feedhub/api build

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

ENV NODE_ENV=production
# The API is reached by the `web` container over the Docker network, so it must
# bind the container's interfaces. It is never published to the host: see the
# absence of a `ports:` mapping in docker-compose.yml.
ENV BIND_ADDR=0.0.0.0
ENV PORT=3000
# Migrations live at the repository root; in this image they sit beside the app.
ENV MIGRATIONS_DIR=/app/migrations

# Reinstall production dependencies only, from the same lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter '@feedhub/api...' \
 && pnpm store prune

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY migrations migrations

RUN chown -R node:node /app
USER node
WORKDIR /app/apps/api

EXPOSE 3000

# Health is checked by compose against the API's own endpoint rather than a TCP
# probe, so an API that is listening but cannot reach PostgreSQL reports as
# unhealthy instead of ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
