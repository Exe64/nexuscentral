# 00 — CONTEXT

**Project codename:** `nexuscentral`
**Audience for this document:** Claude Code (implementation agent)
**Status:** specification complete, implementation not started

---

## 1. What this is

A self-hosted, single-user information aggregation dashboard. It ingests RSS/Atom feeds,
Reddit subreddits and (best-effort) X/Twitter accounts, normalises everything into a single
item store, scores items against user-defined rules, and presents them in a configurable
grid of resizable widgets.

Three jobs, in priority order:

1. **Read** — a daily technology-watch surface, usable on desktop and phone.
2. **Filter and rank** — surface the 10 items that matter out of the 400 ingested.
3. **Alert** — notify on keyword matches without the user opening the app.

## 2. Hard constraints

| Constraint        | Detail                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cost              | **Zero recurring cost.** No paid API tiers, no SaaS subscriptions. Any design that requires payment is rejected. |
| Users             | **Single user.** No registration, no roles, no multi-tenancy, no user table beyond a settings singleton.         |
| Distribution      | Self-hosted only. If someone else wants it, they deploy their own instance with their own credentials.           |
| Deployment target | Docker Compose on an OVHcloud VPS, behind an existing Nginx reverse proxy.                                       |
| UI language       | **English.** All UI strings, code, comments and commit messages in English.                                      |
| Configuration     | **Through the UI, persisted in PostgreSQL.** No YAML config files for sources, tags or rules.                    |

## 3. Stack (fixed — do not substitute)

- **Runtime:** Node.js 22 LTS
- **Language:** TypeScript, strict mode, across backend and frontend
- **Backend:** Express 5
- **Database:** PostgreSQL 16
- **Job scheduling:** `pg-boss` (PostgreSQL-backed — deliberately avoids adding Redis)
- **Frontend:** React 19 + Vite
- **Styling:** Tailwind CSS v4 with CSS custom properties for theming
- **Grid:** `react-grid-layout`
- **Feed parsing:** `rss-parser`
- **HTTP:** native `fetch` with a shared wrapper for retry/backoff
- **Migrations:** `node-pg-migrate`
- **Tests:** `vitest` + `supertest`

Monorepo layout:

```
/apps/api        Express server + workers
/apps/web        React SPA
/packages/shared TypeScript types shared across both
/migrations      SQL migrations
docker-compose.yml
```

## 4. Non-goals

Explicitly out of scope. Do not implement these, do not leave scaffolding for them.

- Multi-user support, authentication UI, password reset, invitations
- Public sharing of feeds or read-only guest links
- Mobile native apps (the web UI must be responsive; that is sufficient)
- Machine-learning ranking or embeddings-based relevance
- Full-text article extraction / reader-mode rewriting
- Comment threads (Reddit comment trees are not ingested — see §6)
- Real-time push to the browser (polling on an interval is sufficient)

## 5. Access control

The application ships with **no authentication of its own**. It is expected to sit behind
Nginx basic auth or mTLS. The API must therefore:

- Bind to `127.0.0.1` by default, configurable via `BIND_ADDR`
- Never expose a route that mutates data over an unauthenticated public path
- Log a startup **warning** if `BIND_ADDR` is `0.0.0.0` and `TRUST_PROXY` is unset

Do not build a login screen.

## 6. Source landscape — the facts that shaped the design

### RSS / Atom

Unrestricted. The backbone of the system. Conditional requests (`ETag`, `Last-Modified`)
are mandatory to stay a good citizen.

### Reddit

- Free tier: **100 queries per minute per OAuth client ID**, averaged over a 10-minute
  rolling window. Non-commercial use only.
- **One request = one HTTP call**, regardless of items returned. A listing returns up to
  100 items with `limit=100`. Polling 60 subreddits every 15 minutes costs ~4 req/min —
  roughly 4% of budget.
- Unauthenticated `.json` endpoints are capped at ~10 QPM and tracked **by IP**. On a
  datacenter IP (OVH) this gets throttled or blocked. **OAuth is mandatory.**
- Comment trees cost one request per post. This is the only thing that could blow the
  budget, which is why comments are a non-goal.
- App registration is no longer self-service; approval takes 2–4 weeks. **This is the
  critical path** — it does not block development, since the Reddit adapter can be built
  and tested against fixtures.

### X / Twitter

- Since February 2026 the official API is pay-per-use with **no free tier**
  (~$0.005 per post read). This violates the zero-cost constraint. **The official API is
  not used.**
- Nitter was discontinued in February 2024 and now requires real account tokens.
  Public instances are unreliable and mostly serve no RSS.
- **Decision:** X is supported through a self-hosted Nitter instance, treated as
  explicitly **best-effort and degradable**. The adapter must fail without affecting any
  other source, and must raise a health alert when it silently returns nothing.

## 7. Decision log

Decisions already argued and settled. Do not relitigate them during implementation.

| #   | Decision                                                           | Rationale                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Build ingestion in-house rather than wrapping Miniflux             | Reddit and Nitter require a scheduler and adapter pattern regardless. Once that exists, the RSS adapter is ~150 lines. Miniflux would only add feed-parsing robustness at the permanent cost of a second source of truth and a sync loop. |
| D2  | Sources, tags and rules live in PostgreSQL, managed through the UI | Interesting sources are discovered while reading, often on a phone. A file-based config means they never get added.                                                                                                                       |
| D3  | Normalised `tags` table, not a `text[]` column                     | Renaming a tag must be one `UPDATE`, and tag input needs autocomplete.                                                                                                                                                                    |
| D4  | `pg-boss` rather than BullMQ                                       | Avoids a Redis container for a single-user workload. Same job semantics.                                                                                                                                                                  |
| D5  | Deterministic weighted scoring, no ML                              | Every score must be explainable in the UI. A rule that fires must be visible.                                                                                                                                                             |
| D6  | Glance community widgets are ported, not imported                  | They are Go `text/template` with Glance-specific helpers and CSS classes. The portable part is the fetch spec (url + params + headers + JSON mapping); the template is disposable. See `04-SPEC-frontend.md` §7.                          |
| D7  | One batched data endpoint per dashboard                            | 15 widgets each fetching independently means 15 connections on load and rate limiting reimplemented in the browser.                                                                                                                       |
| D8  | No authentication in-app                                           | Single user behind an existing reverse proxy. Building auth would be pure cost.                                                                                                                                                           |

## 8. Reading order

1. `00-CONTEXT.md` — this file
2. `01-SPEC-data-model.md` — schema, indexes, migrations
3. `02-SPEC-ingestion.md` — adapters, scheduler, dedup, scoring, alerting
4. `03-SPEC-api.md` — REST surface
5. `04-SPEC-frontend.md` — grid, widgets, theming, i18n
6. `05-BUILD-PLAN.md` — phased milestones and acceptance criteria

Build in the order given by `05-BUILD-PLAN.md`. Each phase has acceptance criteria that
must pass before starting the next.
