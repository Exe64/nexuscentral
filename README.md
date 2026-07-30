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

**Phase 3 — scoring and rules. Complete.**

Working today: tags and sources CRUD with the resolve preview; RSS/Atom, Reddit and
best-effort X (via Nitter) adapters; the `pg-boss` scheduler with per-source backoff;
deduplication; deterministic weighted scoring with an explainable breakdown; rules with a
live test panel; OPML import and export; a settings page for the integrations; and a plain
reader at `/reader`.

Not yet built: theming (Phase 4), the dashboard grid (Phase 5), alert delivery and
`custom_api` widgets (Phase 6). A rule may be marked as alerting today; nothing is delivered
until Phase 6, and the in-app alert list is where it will show first.

### Scoring

```
score = (base + ruleWeights + engagement) × source.weight × recencyDecay
```

Deterministic and explainable, never machine-learned: every score has to be defensible in
the UI. Clicking the score badge in the reader opens the breakdown — each term, and the
rules that fired, by name.

Two things worth knowing about the numbers:

- **Recency has a floor of 0.15, reached at about 66 hours.** Past that, age stops
  discriminating, which is why the hourly refresh only bothers with the last 7 days.
- **The breakdown reports the stored score _and_ the score recomputed now.** They drift
  between hourly refreshes because the decay term keeps falling. Showing both is more honest
  than picking one.

Three jobs, at different costs:

| Job             | When                                        | Work                                                              |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `score:items`   | after every poll                            | scores only the items just inserted                               |
| `rescore:all`   | on rule create/update/delete, debounced ~5s | re-evaluates every pattern over 30 days                           |
| `score:refresh` | hourly                                      | recomputes arithmetic over 7 days from stored matches, no regexes |

50,000 items rescore in about 2.3 seconds on the development machine.

### Rule safety

User-supplied regexes are a ReDoS surface, so there are three layers:

1. **At the API boundary**: a 200-character cap, `g` and `y` rejected (they carry `lastIndex`
   between calls, so a rule would match or not depending on what ran before it), and a
   heuristic that rejects nested unbounded repetition — `(a+)+`, `(\w+)+` — with a message
   saying how to rewrite it.
2. **Compiled once per batch**, not once per item.
3. **A 50 ms per-item budget in a worker thread.** This is the only layer that stops a
   pattern already backtracking. The worker writes its position to shared memory before every
   `test()`, so when the host kills the thread it can name the rule that hung, disable it with
   the reason on the rule row, and finish the rest of the run.

The heuristic is a heuristic and does not claim to catch every slow pattern. Layer 3 is what
makes that acceptable.

### Reddit

Reddit needs an OAuth app. **Registration is not self-service and approval takes two to four
weeks** — register before you need it. Until credentials are configured, Reddit sources are
created _inactive_ with the reason recorded in `health.lastError`, so the UI can explain
itself rather than showing a healthy source that silently produces nothing.

Credentials come from `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` or from the settings page.
The environment wins when both are present, and the settings page says so — otherwise saving
the form would look like a no-op.

The rate budget reads the `x-ratelimit-*` headers and enforces two limits: never consume more
than half the window, and stop entirely below ten remaining requests. A single-user instance
polling 60 subreddits every 15 minutes uses about 4%.

### X via Nitter

Best-effort and degradable. The official X API has had no free tier since February 2026, so
this goes through a self-hosted Nitter instance. List instances in order, self-hosted first;
the adapter tries each until one returns a parseable feed, and its failures never affect
another source.

Item URLs are rewritten from the instance to `x.com`. That is what keeps `content_hash`
stable, so replacing an instance does not reinsert the whole timeline.

A Nitter instance fails by returning a well-formed, empty feed over HTTP 200. Zero-item runs
are counted, and at three the source is reported as `silentlyEmpty` — separately from
`failing`, because nothing about those runs looked like an error. `GET /api/health` degrades
on it, and `GET /api/sources?health=unhealthy` lists the affected sources.

## Testing

```bash
pnpm test                                   # unit tests, no network, no database
pnpm --filter @feedhub/api test:integration # against a real PostgreSQL
```

Integration tests need the dev database running and truncate every table between tests.
Point `INTEGRATION_DATABASE_URL` elsewhere if the default is not disposable; the suite
creates the database and applies the real migrations, so a migration that does not apply
cleanly fails the run.

There is deliberately no frontend E2E suite. The web tests render each page against a
stubbed API, and a separate test walks every `t()` call site to check the copy contract —
no missing keys, no unused keys, no string hardcoded in a component.

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

| Command                                   | Effect                                      |
| ----------------------------------------- | ------------------------------------------- |
| `pnpm build`                              | Build `shared`, then `api` and `web`        |
| `pnpm typecheck`                          | `tsc` across every package, including tests |
| `pnpm lint` / `pnpm format`               | ESLint / Prettier                           |
| `pnpm test`                               | `vitest` across every package               |
| `pnpm --filter @feedhub/api migrate up`   | Apply migrations                            |
| `pnpm --filter @feedhub/api migrate down` | Roll back the last migration                |

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
- **`api`** — not published to the host either. It binds `0.0.0.0` _inside its container_ so
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
