# feedhub

A self-hosted, single-user information aggregation dashboard. It ingests RSS/Atom feeds,
Reddit subreddits and (best-effort) X/Twitter accounts, normalises everything into one item
store, scores items against user-defined rules, and presents them in a configurable grid of
resizable widgets.

Three jobs, in priority order: **read**, **filter and rank**, **alert**.

- Zero recurring cost. No paid API tiers.
- Single user. No registration, no roles — it sits behind Nginx basic auth or mTLS and ships
  with no authentication of its own.
- Configuration lives in PostgreSQL and is managed through the UI, not in YAML files.

The full specification is in `docs/` (`00-CONTEXT.md` through `05-BUILD-PLAN.md`). Read them
in that order; `05-BUILD-PLAN.md` defines the phase order and the acceptance criteria.

## Status

**Phase 0 — scaffolding. Complete.** The API serves `GET /api/health`, migration `001_initial`
applies the full schema and rolls back cleanly, and both apps build. No ingestion yet: that
is Phase 1.

## Stack

Node.js 22 · TypeScript strict · Express 5 · PostgreSQL 16 · `pg-boss` · React 19 + Vite ·
Tailwind CSS v4 · `node-pg-migrate` · `vitest`

```
apps/api          Express server + workers
apps/web          React SPA
packages/shared   TypeScript types shared across both
migrations        SQL migrations
```

## Local development

Requires Node 22 and pnpm 9, plus a PostgreSQL 16 you can reach.

```bash
pnpm install
cp .env.example .env        # set POSTGRES_PASSWORD and DATABASE_URL

# Run only the database in Docker; the app runs on the host.
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres

pnpm --filter @feedhub/api migrate up
pnpm dev                    # API on :3000, Vite on :5173 proxying /api
```

`docker-compose.dev.yml` exists purely to publish PostgreSQL on `127.0.0.1:5432`. It is not
named `docker-compose.override.yml` on purpose: that filename loads automatically, including
on the VPS, and publishing the database there would undo a deployment constraint.

Useful commands:

| Command | Effect |
|---|---|
| `pnpm build` | Build `shared`, then `api` and `web` |
| `pnpm typecheck` | `tsc` across every package, including tests |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm test` | `vitest` across every package |
| `pnpm --filter @feedhub/api migrate up` | Apply migrations |
| `pnpm --filter @feedhub/api migrate down` | Roll back the last migration |

`migrate` reads `DATABASE_URL`. It resolves the migrations directory from `MIGRATIONS_DIR`,
defaulting to `../../migrations` — the Docker image sets it to `/app/migrations`.

## Deployment

Docker Compose on a VPS, behind an existing Nginx that terminates TLS and authenticates.

```bash
cp .env.example .env         # POSTGRES_PASSWORD is required
docker compose up -d --build
docker compose exec api pnpm migrate up
```

Topology:

- **`postgres`** — not published, on the Docker network only.
- **`api`** — not published to the host either. It binds `0.0.0.0` *inside its container* so
  `web` can reach it; there is no `ports:` mapping. Locally, outside Docker, `BIND_ADDR`
  defaults to `127.0.0.1`.
- **`web`** — Nginx serving the built SPA and proxying `/api` to `api:3000`. Published on
  `127.0.0.1:8080` by default, for the host Nginx to proxy to.

The API logs a startup warning when it is bound to all interfaces with `TRUST_PROXY` unset:
that combination means either it is directly exposed or client IPs are wrong.

Full deploy notes — host Nginx config with basic auth, backup and restore, Reddit app
registration — land in Phase 7.

## Environment

Every variable is documented in [.env.example](.env.example). `.env` is gitignored; secrets
are never logged, never returned by the API, and never committed.
