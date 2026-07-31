# 05 — BUILD PLAN

Seven phases. Each has acceptance criteria that must pass before the next begins.
Commit at every phase boundary. Do not start Phase N+1 with Phase N criteria failing.

---

## Phase 0 — Scaffolding

- pnpm workspace monorepo: `apps/api`, `apps/web`, `packages/shared`
- TypeScript strict, ESLint, Prettier, `vitest`
- `docker-compose.yml`: `postgres:16`, `api`, `web` (nginx serving the built SPA)
- `node-pg-migrate` wired, migration `001_initial` implementing the full schema from
  `01-SPEC-data-model.md`
- `.env.example` with every variable documented
- `pino` logging, `GET /api/health` returning `{ status: 'ok' }`

**Acceptance:** `docker compose up` produces a reachable API and web app; migrations apply
to an empty database and roll back cleanly.

## Phase 1 — Sources, tags, RSS ingestion

- Tags CRUD (API + UI)
- Sources CRUD with the `resolve` preview endpoint
- `RssAdapter` with conditional requests
- `pg-boss` scheduler, `poll:tick` and `poll:source`
- Deduplication
- A plain, unstyled item list at `/reader`
- OPML import/export

**Acceptance:**

- Add a feed by pasting a blog homepage URL; the preview shows 3 real items before saving
- Items appear within one poll cycle
- A second poll of an unchanged feed returns 304 and inserts nothing
- Deleting a source removes its items
- `vitest` covers the RSS adapter against at least 5 fixtures, including one malformed feed

## Phase 2 — Reddit and Nitter

- OAuth2 client-credentials flow with in-memory token cache
- `RedditBudget` reading the `x-ratelimit-*` headers
- `RedditAdapter` with `before` cursors, `resolve` via `/r/{name}/about`
- `NitterAdapter` with instance rotation and silent-death detection
- Health tracking: `consecutive_failures`, `consecutive_empty`, backoff, auto-deactivation
- Settings UI for Reddit credentials and Nitter instances, with a "Test connection" action

**Acceptance:**

- Reddit sources poll without ever exceeding 50% of the rate budget
- With credentials absent, Reddit sources are created inactive and the UI explains why
- A Nitter instance returning an empty feed 3 times raises a health alert
- Nitter item URLs are rewritten to `x.com`, verified by switching instance and confirming
  no duplicates appear

> Reddit app approval takes 2–4 weeks. Build and test this phase entirely against fixtures;
> submit the app registration on day one so approval lands before it is needed.

## Phase 3 — Scoring and rules

- Scoring engine as a pure, unit-tested function
- Rules CRUD with ReDoS guards
- `POST /api/rules/test` with highlighted matches
- Debounced `rescore:all`, hourly `score:refresh`
- Score breakdown on the item detail endpoint
- Rules UI with the live test panel

**Acceptance:**

- Creating a rule rescores the last 30 days within 10 s for 50k items
- A catastrophic-backtracking pattern is rejected at creation with a clear message
- The test panel shows match counts against real items before saving
- The score breakdown popover explains any item's score

## Phase 4 — Theming and shell

- Theme tokens, light/dark, accent hue and chroma, no-flash inline script
- Settings persistence to both `localStorage` and PostgreSQL, with server reconciliation
- App shell: sidebar, top bar, navigation, tag list with unread counts
- Keyboard shortcuts and the `?` overlay
- Contrast unit test across 12 hues in both themes

**Acceptance:**

- Reloading in dark mode produces no white flash
- Changing the accent hue updates the entire UI live and survives a reload
- The contrast test passes at every sampled hue
- Full keyboard navigation of the reader with visible focus throughout

## Phase 5 — Dashboard grid

- `ResponsiveGridLayout` with edit mode, debounced layout persistence
- Widget registry
- `feed`, `alerts`, `source_health`, `stats` widgets
- `GET /api/dashboards/:id/data` batched endpoint with per-widget caching
- Error boundary per widget
- Multiple dashboards with a switcher

**Acceptance:**

- 15 widgets drag smoothly with no visible stutter (profile it; if it stutters, the `memo`
  work in `04-SPEC-frontend.md` §3 was skipped)
- Layout survives reload, per breakpoint
- One widget throwing renders an inline error and leaves the rest working
- Loading a dashboard issues exactly one data request
- On a 390px viewport the grid is single-column and drag is disabled

## Phase 6 — Alerting and custom API widgets

- `alerts` table population, batched delivery, retry with backoff
- ntfy / Gotify / Discord / generic webhook targets, plus "Send test notification"
- `custom_api` widget with the four renderers
- `POST /api/custom-api/preview` with the SSRF guard
- `pnpm port-widget` CLI helper

**Acceptance:**

- A rule with `alert: true` matching a new item delivers within 60 s
- 40 simultaneous matches produce one grouped notification, not 40
- Creating an alerting rule generates zero alerts for pre-existing items
- A `custom_api` widget pointed at `169.254.169.254` is rejected
- At least two real Glance community widgets are ported end to end

## Phase 7 — Hardening

- Retention and vacuum jobs
- Full-text search wired into the reader
- Backup script: `pg_dump` + settings export
- `README.md`: deploy, Nginx config with basic auth, backup/restore, Reddit app registration
- Load check: 100 sources, 200k items — the reader must paginate in under 200 ms

---

## Cross-cutting requirements

**Testing.** Unit tests for every adapter and the scoring engine. Integration tests for the
API against a real PostgreSQL (testcontainers or a compose service). No frontend E2E suite —
not worth it at this scale.

**Migrations.** Every schema change is a numbered migration with a working `down`. Never
edit an applied migration.

**Secrets.** Never logged, never returned by the API, never committed. `.env` is
gitignored; `.env.example` is not.

**Errors.** No `catch {}` that swallows silently. Every catch either handles or rethrows
with context.

**Commits.** Conventional Commits. One phase may span several commits; each must build.

## Environment variables

```
DATABASE_URL=postgres://nexuscentral:…@postgres:5432/nexuscentral
BIND_ADDR=127.0.0.1
PORT=3000
NODE_ENV=production
WORKER_ENABLED=true
LOG_LEVEL=info

REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=nexuscentral/1.0 (self-hosted personal aggregator)

NITTER_BASE_URLS=https://nitter.mydomain.tld

ALLOW_PRIVATE_TARGETS=false
TRUST_PROXY=1
```

## Deployment notes

- Nginx terminates TLS, handles basic auth, proxies `/api` to the API container and
  everything else to the static build.
- The API binds to `127.0.0.1` and is published only on the Docker network.
- PostgreSQL is not published to the host at all.
- `docker compose exec api pnpm migrate up` runs on deploy, before the API restarts.
