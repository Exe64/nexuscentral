# syntax=docker/dockerfile:1
#
# Build context is the repository root -- the SPA depends on @feedhub/shared.
#
#   docker build -f apps/web/Dockerfile -t feedhub-web .

# --- build -------------------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter '@feedhub/web...'

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN pnpm --filter @feedhub/shared build \
 && pnpm --filter @feedhub/web build

# --- runtime -----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
