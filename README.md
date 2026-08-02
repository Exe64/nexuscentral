# Nexus Central

A self-hosted, single-user information dashboard. It pulls in RSS/Atom feeds, YouTube
channels, Reddit subreddits and X/Twitter accounts, normalises everything into one item
store, scores it against rules you define, and presents it in a configurable grid of
resizable widgets.

Three jobs, in priority order: **read**, **filter and rank**, **alert**.

- **Zero recurring cost.** No paid API tiers.
- **Single user.** One password, a session cookie, every API route closed by default.
- **Configured through the UI.** Settings live in PostgreSQL, not in YAML files.

`nexuscentral` is the technical identifier — package, image, repository. **Nexus Central** is
the display name.

---

## Features

### Reading

- **Three reader layouts** — a dense list, cards with preview thumbnails, or titles only.
  Your choice is stored server-side and survives a reload.
- **Preview images** pulled from the feed, with an `og:image` background job filling the gaps.
- **Source icons** beside every item, and source tags on every row.
- **Filters** by tag, unread, starred, and full-text search, sorted by date, score or
  engagement. (Filtering by source and by minimum score is a `feed` widget's job.)
- **Keyboard-driven**: `j`/`k` move, `o` opens, `m` toggles read, `s` stars, `r` refreshes,
  `/` focuses search, `t` cycles the theme, `?` lists them all.

### Dashboards

A drag-and-resize grid with per-breakpoint layouts that survive a reload. Five widget types:

| Widget          | Shows                                                          |
| --------------- | -------------------------------------------------------------- |
| `feed`          | Items, filtered by tags and/or sources, sorted and collapsible |
| `alerts`        | Rule matches waiting to be acknowledged                        |
| `source_health` | Sources that are failing or have gone quiet                    |
| `stats`         | Item counts, top sources, Reddit budget                        |
| `custom_api`    | Any JSON endpoint, proxied server-side and mapped to a layout  |

A `feed` widget narrows by **tags**, by **sources**, or both. The config form counts the
intersection live — `Draws from 4 of 27 sources.` — so a filter combination that selects
nothing says so before you save it.

### Scoring

```
score = (base + ruleWeights + engagement) × source.weight × recencyDecay
```

Deterministic and explainable, never machine-learned. Click the score badge on any item to
see the breakdown: every term, and the rules that fired, by name.

- **`source.weight`** is per source and editable — 1 is neutral, below 1 demotes.
- **Recency** decays to a floor of 0.15 at about 66 hours.
- The breakdown shows the **stored** score and the score **recomputed now**; they drift
  between hourly refreshes as the decay term falls.

### Rules

Boost or bury items by regular expression, over the title, summary, author, or all of them.
A negative weight demotes — that is how noise gets buried. A **live test panel** checks your
pattern against the 300 most recent items as you type, before you save it.

Rules are the alert trigger too: turn `alert` on and a newly ingested match raises an alert.

### Alerting

Delivery to **ntfy**, **Gotify**, **Discord** or a generic **webhook**, configured under
Settings → Alerts with a button that sends a real notification so a wrong URL is found now.

Batched to at most one notification a minute — forty matches in one poll produce one push.
A failed delivery leaves the alert pending and records the error; the dashboard stays the
source of truth.

### Theming

Light, dark and system, plus an accent chosen as a **hue** (0–360) and a **chroma**
(Muted / Vivid). The whole colour ramp is derived from those two numbers in OKLCH.

Five named palettes: **Default**, **Solarized**, **Terminal** (green phosphor), **VT220**
(amber phosphor) and **PowerShell**. Each defines both a light and a dark variant.

All colour pairs are held to WCAG contrast by an automated test — 4.5:1 for body text, 3:1
for borders and large text, across every hue, chroma and theme.

---

## Sources

| Kind        | Paste                                                 |
| ----------- | ----------------------------------------------------- |
| **RSS**     | A feed URL, or just a site — the feed is discovered   |
| **YouTube** | A channel URL (`youtube.com/@Fireship`) or a playlist |
| **Reddit**  | `r/selfhosted`, a subreddit URL, or a multireddit     |
| **X**       | `@handle` or an `x.com` URL (needs a Nitter instance) |

Paste anything into one box and the server works out the rest, showing a preview with sample
items before you commit. OPML import and export are supported, with folders as tags.

### YouTube

Paste a channel URL and the feed is discovered automatically. Playlists work the same way.

> The legacy `/c/Name` URL form answers **404** at YouTube's end. Use `/@handle`.

Videos carry no view or like count, so a channel scores on recency, source weight and rules
alone.

### Reddit

Reddit needs an OAuth app. **Registration is not self-service and approval takes two to four
weeks** — register before you need it. Credentials go in `REDDIT_CLIENT_ID` /
`REDDIT_CLIENT_SECRET` or on the settings page; the environment wins when both are set.

**Subreddits work without credentials.** Paste one and it resolves through Reddit's public
Atom feed instead:

| You paste                            | You get                            |
| ------------------------------------ | ---------------------------------- |
| `r/SteamDeck`                        | `.../r/steamdeck/new.rss`          |
| `reddit.com/r/selfhosted`            | `.../r/selfhosted/new.rss`         |
| `reddit.com/r/selfhosted+homelab`    | `.../r/selfhosted+homelab/new.rss` |
| `reddit.com/r/selfhosted/top?t=week` | `.../r/selfhosted/top.rss?t=week`  |

Two limits to know: the public feed carries **no engagement data**, so sorting by engagement
means nothing for those items; and Reddit's unauthenticated budget is tight, so fold several
subreddits into one multireddit (`r/a+b+c`) rather than adding them separately. A throttled
poll is recorded as such and does not count against the source's health.

### X via Nitter

The official X API has had no free tier since February 2026, so this goes through a
self-hosted **Nitter** instance. List instances in order in `NITTER_BASE_URLS`, self-hosted
first; each is tried until one returns a usable feed. Item URLs are rewritten back to
`x.com`, so replacing an instance does not duplicate a timeline.

Best-effort by design. An instance that returns empty feeds is reported as `silentlyEmpty`
after three runs rather than passing as healthy.

---

## Quick start

Requires **Node 22**, **pnpm 9**, and a **PostgreSQL 16** you can reach.

```bash
pnpm install
cp .env.example .env        # set POSTGRES_PASSWORD and DATABASE_URL

# Run only the database in Docker; the app runs on the host.
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres

pnpm --filter @nexuscentral/api migrate up
pnpm dev                    # API on :3000, Vite on :5173 proxying /api
```

> `docker-compose.dev.yml` publishes PostgreSQL on `127.0.0.1:5432`. It is **not** named
> `docker-compose.override.yml` on purpose — that filename loads automatically, including on
> a server, where publishing the database would be wrong.

---

## Deployment

Docker Compose behind a reverse proxy. The stack is three containers:

- **`postgres`** — never published; on the Docker network only.
- **`api`** — not published to the host either; reachable only by `web`.
- **`web`** — Nginx serving the built SPA and proxying `/api`. Published on `127.0.0.1:8080`
  and joined to the external `web_network` so Traefik can route to it.

### First deploy

```bash
mkdir -p /opt/apps/nexuscentral && cd /opt/apps/nexuscentral
vi .env        # DOMAIN, TRAEFIK_CERTRESOLVER, POSTGRES_PASSWORD, AUTH_PASSWORD
./deploy.sh
```

`deploy.sh` does the whole cycle: fetch → build → dump → migrate → health gate → prune. It
refuses to start if `.env` is missing a required key, and stops before migrating if the
pre-deploy dump fails.

| Flag            | Effect                                                            |
| --------------- | ----------------------------------------------------------------- |
| `--skip-backup` | Skip the pre-migration dump (a first deploy, or a throwaway host) |
| `--no-build`    | Reuse the images already on the host                              |

Nothing is rolled back automatically. If the health gate fails, the script prints the recent
API logs, the dump path and the exact rollback commands.

### The password

`AUTH_PASSWORD` in `.env` is needed **once**, for the first boot. **Delete the line after
your first sign-in** — from then on the password lives in the database and is changed from
Settings → Security. One left in `.env` ends up in every backup of `.env`.

> ⚠️ **`AUTH_PASSWORD` must not contain `$`.** Compose substitutes `$name` in `.env` values,
> so `secret$word` reaches the container as `secret` and locks you out with a password you
> never typed. `deploy.sh` refuses this case outright. A `$` is fine through `set-password`,
> which never goes near Compose.

Set or reset it directly at any time — this also works when you are locked out, and revokes
every session:

```bash
docker compose exec -it api node dist/cli/set-password.js
```

If a login is refused and you want to know why:

```bash
docker compose exec -T api node dist/cli/auth-status.js
```

It reports whether a password is stored, how many characters `AUTH_PASSWORD` was _as the
container received it_, live sessions, and whether the rate limiter has locked you out. It
never prints the password or the hash.

> `TRUST_PROXY` matters more than it looks: the per-IP login limit counts client addresses,
> and without it every request appears to come from the proxy.

### Backups

`deploy.sh` dumps before every migration. For a daily dump, from cron:

```
0 4 * * * /opt/apps/nexuscentral/deploy/backup-db.sh >> /var/log/nexuscentral-backup.log 2>&1
```

Optional, all off by default and all configured in `.env`: AES256 encryption at rest, an
off-machine copy via rclone, and a dead-man's-switch that alerts when backups stop running.
Rotation keeps 14 dumps by default.

Restoring:

```bash
./deploy/restore-db.sh --check backups/nexuscentral_20260730-231351.sql.gz   # verify only
./deploy/restore-db.sh backups/nexuscentral_20260730-231351.sql.gz           # drops and reloads
```

### Retention

| Job               | When           | What                                                |
| ----------------- | -------------- | --------------------------------------------------- |
| `retention:items` | daily, 03:00   | Delete unstarred items past `items_retention_days`  |
| `retention:raw`   | daily, 03:10   | Null `raw` on anything fetched more than 7 days ago |
| `vacuum:analyze`  | weekly, Sunday | `VACUUM ANALYZE items`                              |

**A starred item is never deleted, however old.**

---

## Updates

Settings → Updates compares the running build with the head of the public repository — one
request to GitHub, cached for thirty minutes, no token. When an update exists, an indicator
appears in the application bar and links straight to the panel.

### Updating from the application

Optional, and off until you enable it. The application never runs the deploy itself: it
writes a request into a shared directory, and a systemd timer on the host acts on it.

```bash
sudo cp deploy/nexuscentral-update.service deploy/nexuscentral-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexuscentral-update.timer
```

Then set `UPDATE_CONTROL_DIR=/app/control` in `.env` and redeploy once. The **Update now**
button appears in Settings from then on, with a confirmation that spells out what happens:
the database is migrated, the application restarts, and the page stops loading for a few
minutes.

While a deploy runs, the panel shows how long it has been going and the tail of the deploy
log, so you can see which step it reached. Expect the page to fail to load for a minute
partway through — the deploy restarts the API, and carries on without it.

If it stays on **"The request has not been picked up"**, the agent is not running. Check it
from a shell:

```bash
systemctl list-timers nexuscentral-update      # is the timer scheduled?
journalctl -u nexuscentral-update -n 50        # what happened on the last tick?
tail -f /opt/apps/nexuscentral/control/update.log
```

Set `UPDATE_CHECK_ENABLED=false` to disable the check entirely.

---

## Development

**Node.js 22** · **TypeScript** strict · **Express 5** · **PostgreSQL 16** · `pg-boss` ·
**React 19** + **Vite** · **Tailwind CSS v4** · `node-pg-migrate` · `vitest`

```
apps/api          Express server + workers
apps/web          React SPA
packages/shared   TypeScript types shared across both
migrations        SQL migrations
docs              Specification and design notes
```

| Command                                        | Effect                                      |
| ---------------------------------------------- | ------------------------------------------- |
| `pnpm dev`                                     | API and web, in watch mode                  |
| `pnpm build`                                   | Build `shared`, then `api` and `web`        |
| `pnpm typecheck`                               | `tsc` across every package, including tests |
| `pnpm lint` / `pnpm format`                    | ESLint / Prettier                           |
| `pnpm test`                                    | `vitest` across every package               |
| `pnpm --filter @nexuscentral/api migrate up`   | Apply migrations                            |
| `pnpm --filter @nexuscentral/api migrate down` | Roll back the last migration                |

### Testing

```bash
pnpm test                                        # unit tests, no network, no database
pnpm --filter @nexuscentral/api test:integration # against a real PostgreSQL
```

Integration tests need the dev database running and truncate every table between tests. Point
`INTEGRATION_DATABASE_URL` elsewhere if the default is not disposable; the suite creates the
database and applies the real migrations.

### Checking the production images locally

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm --no-deps api pnpm migrate up
docker compose up -d
curl -s http://127.0.0.1:8080/api/health
```

---

## Configuration

Every variable is documented in [.env.example](.env.example). `.env` is gitignored; secrets
are never logged, never returned by the API, and never committed.

A few worth knowing:

| Variable                | Default | Effect                                                  |
| ----------------------- | ------- | ------------------------------------------------------- |
| `TRUST_PROXY`           | unset   | Number of proxies in front; needed for per-IP limits    |
| `ALLOW_PRIVATE_TARGETS` | `false` | Let `custom_api` reach private addresses (homelab only) |
| `WORKER_ENABLED`        | `true`  | Run the ingestion workers in this process               |
| `NITTER_BASE_URLS`      | empty   | Comma-separated Nitter instances, in order              |
| `UPDATE_CHECK_ENABLED`  | `true`  | Check GitHub for a newer commit                         |
| `UPDATE_CONTROL_DIR`    | unset   | Enable in-app updating (see above)                      |

---

## Documentation

- [`docs/`](docs/) — the full specification, `00-CONTEXT.md` through `05-BUILD-PLAN.md`
- [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) — why things are built the way they are:
  the SSRF guard, ReDoS defences, measured performance, and the trade-offs behind the less
  obvious decisions
