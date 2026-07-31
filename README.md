# nexuscentral

A self-hosted, single-user information aggregation dashboard. It ingests RSS/Atom feeds,
Reddit subreddits and (best-effort) X/Twitter accounts, normalises everything into one item
store, scores items against user-defined rules, and presents them in a configurable grid of
resizable widgets.

Three jobs, in priority order: **read**, **filter and rank**, **alert**.

- Zero recurring cost. No paid API tiers.
- Single user. No registration, no roles — one password, a session cookie, and every API
  route closed except the health check and the login itself.
- Configuration lives in PostgreSQL and is managed through the UI, not in YAML files.

The full specification is in `docs/` (`00-CONTEXT.md` through `05-BUILD-PLAN.md`). Read them
in that order; `05-BUILD-PLAN.md` defines the phase order and the acceptance criteria.

## Status

**Phase 6 — alerting and custom API widgets. Complete.**

Working today: alert delivery to ntfy, Gotify, Discord or a generic webhook; `custom_api`
widgets that proxy any JSON endpoint through the server; the dashboard grid with drag, resize
and per-breakpoint layouts that survive a reload; `feed`, `alerts`, `source_health`, `stats`
and `custom_api` widgets; the app shell with a sidebar, tag list and keyboard shortcuts; light
and dark themes with a user-chosen accent and five named palettes; tags and sources CRUD with
the resolve preview; RSS/Atom, Reddit and best-effort X (via Nitter) adapters; the `pg-boss`
scheduler with per-source backoff; deduplication; deterministic weighted scoring with an
explainable breakdown; rules with a live test panel; and OPML import and export.

Not yet built: retention and vacuum jobs, and full-text search wired into the reader (Phase 7).

### Theming

Light, dark and system, plus an accent chosen as a **hue** (0–360) and a **chroma**
(Muted / Vivid). The whole ramp is derived from those two numbers in OKLCH, which keeps
perceptual lightness constant across hues — a yellow accent and a blue accent end up equally
readable, which is not true of an HSL ramp. The neutrals carry a trace of the accent hue, so
changing it changes the app rather than just recolouring the buttons.

Components reference **only** semantic tokens (`--bg-surface`, `--text-secondary`,
`--accent`). Nothing reaches past them to a raw colour, which is what makes a named palette
one more token block rather than a rewrite.

#### Named palettes

| Palette        | What it is                                                              |
| -------------- | ----------------------------------------------------------------------- |
| **Default**    | The accent-derived ramp above                                           |
| **Solarized**  | Ethan Schoonover's hues, adapted (see below)                            |
| **Terminal**   | Green phosphor; the light variant is the same green on paper            |
| **VT220**      | DEC amber phosphor, ditto                                               |
| **PowerShell** | The console's `#012456` navy, its off-white text and its warning yellow |

Palette and mode are orthogonal: every palette defines both a light and a dark variant, so
switching mode never lands on something that does not exist. Choosing a dark-native palette
switches the mode to dark for you, and nothing is locked afterwards. A palette sets its own
colours, so the accent controls do nothing while one is active — the UI says so rather than
leaving a dead slider.

**The palettes are adapted, not transcribed.** Canonical Solarized does not clear this
project's own contrast floor: its light body text measures 4.13:1 on its own background and
its secondary text 2.48:1, against a 4.5:1 requirement. The hues are kept exactly; the
lightness is adjusted until it reads. The settings page states this next to the palette
rather than quietly shipping something that is not quite Solarized.

Every palette goes through the same test as the derived theme — 104 further assertions
covering both variants of all four.

`localStorage` is the render-time cache and PostgreSQL is the source of truth: an inline
script in `index.html` applies the theme before the first paint, and the server value is
adopted on boot.

**The contrast floor is a test, not an aspiration.** 442 assertions cover 12 hues × 2 chromas
× both themes: body text at 4.5:1, borders and large text at 3:1, every tag pair, every
status colour. The test parses the shipped `tokens.css` and evaluates the same `oklch()` and
`calc()` expressions, so it measures what users get rather than a copy of it.

Where this repository's token values differ from the ones written in the spec, and why, is
documented at the top of [tokens.css](apps/web/src/styles/tokens.css). In short: the spec
states both literal values and a non-negotiable contrast floor, and measured across 12 hues
the literal values do not meet the floor. The floor won.

### Authentication

One password, one user. This **reverses `00-CONTEXT.md` §5**, which had the app carry no
login and sit behind the reverse proxy's basic auth. Basic auth has no logout, nothing to
revoke, and re-sends the credential on every request; the application now authenticates for
itself and the Traefik middleware is gone.

- **scrypt**, from `node:crypto`. Not bcrypt or argon2: both mean a native module, a compiler
  in the Docker build and a rebuild on every Node upgrade. The encoded hash carries its own
  `N`, `r` and `p`, so raising the cost later is one line and old hashes keep verifying.
- **Sessions** are 32 random bytes in an `httpOnly`, `Secure`, `SameSite=Strict` cookie. The
  database stores only the SHA-256, so a dump of `sessions` yields nothing replayable — and
  `SameSite=Strict` is what makes a CSRF token unnecessary for a cookie-authenticated API.
  Thirty days, sliding, renewed past the halfway mark rather than on every request.
- **Rate limiting** is two windows: five failures per IP and twenty globally, per fifteen
  minutes. The global one exists because a distributed attempt never trips a per-IP counter,
  and with one user a global lockout costs that user a wait and an attacker the whole attack.
  It is stored in PostgreSQL, not in memory: a lockout a restart clears is not a lockout.
- **Every route is closed** except `GET /api/health` and `/api/auth/*`. The gate is mounted
  once, in front of the routers, so a router added later is protected by default. A test walks
  the real Express router tree and asserts a 401 for each — a hand-written list would drift.
- `/api/health` answers in two shapes: liveness only to anyone (the container healthcheck and
  `deploy.sh` both run before login is possible), and source counts, Reddit budget and queue
  depth only once authenticated. Those describe what the instance follows.

Changing the password revokes every other session, because the usual reason to change it is
that someone else has it. Changing it requires the current one even from an open session, so
a borrowed session cannot lock the owner out.

#### Setting and resetting the password

```bash
docker compose exec -it api node dist/cli/set-password.js        # prompts, hidden
printf '%s' "$PW" | docker compose exec -T api node dist/cli/set-password.js
```

This is the recommended way to set it in the first place — nothing is written to `.env` — and
the only way back in if you are locked out. It revokes every session. `node` rather than
`pnpm`: the image activates pnpm through corepack, which wants to reach npmjs the first time
a non-root user invokes it, and a password reset must not need outbound network.

**`AUTH_PASSWORD` must not contain `$`.** Compose substitutes `$name` and `${name}` in `.env`
values, so `secret$word` reaches the container as `secret` — and you are locked out by a
password you never typed. Docker prints `The "word" variable is not set` on the host when this
happens, and `deploy.sh` now refuses the case outright. A `$` is fine through `set-password`,
which never goes near Compose.

When a login is refused and you want to know why:

```bash
docker compose exec -T api node dist/cli/auth-status.js
```

It reports whether a password is stored and when it was set, how many characters
`AUTH_PASSWORD` was **as the container received it** — compare that with what you wrote, a
shorter number means Compose ate a `$` — live sessions, and whether the rate limiter has
locked you out. It never prints the password or the hash.

`TRUST_PROXY` matters more than it looks: the per-IP limit counts client addresses, and
without it every request appears to come from the proxy.

### Alerting

A rule with `alert` on raises an alert when a **newly ingested** item matches it, and never
otherwise. Turning alerting on for a rule sets `matched_rules` across the last 30 days without
notifying about any of it — otherwise the first useful rule fires hundreds of pushes.

Delivery goes to ntfy, Gotify, Discord or a generic webhook, configured under **Settings →
Alerts** with a button that sends a real notification so a wrong URL is found now rather than
when it matters. Batching is one notification per delivery, at most one a minute: forty
matches in a poll produce one push. Retry is 1s/5s/25s inside the send, and a failure records
`delivery_error` while leaving the alert pending — the dashboard stays the source of truth and
a webhook that was down for an hour catches up.

The configured URL is used **verbatim** for every target. The spec writes Gotify as
`{url}/message?token=…`; appending a path to a URL someone typed produces a 404 that is
impossible to debug behind a subpath proxy, so the settings panel says what to paste instead.

### Custom API widgets

A `custom_api` widget names a URL, some parameters and headers, a JSONPath `root` and a field
mapping. The server fetches it — the browser never calls the third party, which keeps API keys
server-side and sidesteps CORS — and renders the result through one of four generic layouts:
list, list with detail, single value, key and value. There is no per-widget HTML.

`${VAR}` in a URL, parameter or header is replaced from the server environment. A missing
variable is an error at preview time, not an empty `Authorization: Bearer ` that looks like a
credential problem three days later.

**The SSRF guard is the load-bearing part.** A widget URL is an instruction to make this server
issue a request, which unchecked reaches the Docker network, the host loopback, and on a cloud
host the metadata service that hands out credentials. So: the hostname is resolved first and
every resolved address is checked, not the name; the connection is pinned to the address that
was checked, so a second lookup cannot return something else; redirects are followed by hand so
each hop goes through the guard again; `Host` cannot be set by the widget; and the body is
capped at 5 MB while reading rather than trusting `content-length`. `ALLOW_PRIVATE_TARGETS=true`
turns it off for a homelab, and is off by default.

`POST /api/custom-api/preview` runs exactly the code the widget runs, and reports what the root
actually selected. That matters more than it sounds: jsonpath-plus does not validate paths at
all — `$[` is quietly treated as `$` and `nonsense((` returns nothing, neither throws — so
showing what a path selected is the only feedback that exists.

#### Porting Glance widgets

```bash
pnpm --filter @nexuscentral/api port-widget path/to/README.md
```

Reads a Glance `custom-api` block as a **fetch specification**: URL, parameters, headers, and
the `.String "field"` accessors the template reads. It prints a draft config and says which
guesses it made. It does not interpret the Go template — that is unbounded work for no benefit
— and it never emits markup. Glance is AGPL-3.0, and a URL with a set of field names is a fact
rather than expression; keeping template HTML out of this is deliberate.

### Keyboard

`j` / `k` move, `o` opens, `m` toggles read, `s` stars, `r` refreshes, `/` focuses search,
`t` cycles the theme, `?` lists them all. Shortcuts never fire while you are typing, and
never swallow a browser chord.

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
pnpm --filter @nexuscentral/api test:integration # against a real PostgreSQL
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

pnpm --filter @nexuscentral/api migrate up
pnpm dev                    # API on :3000, Vite on :5173 proxying /api
```

`docker-compose.dev.yml` exists purely to publish PostgreSQL on `127.0.0.1:5432`. It is not
named `docker-compose.override.yml` on purpose: that filename loads automatically, including
on the VPS, and publishing the database there would undo a deployment constraint.

Useful commands:

| Command                                        | Effect                                      |
| ---------------------------------------------- | ------------------------------------------- |
| `pnpm build`                                   | Build `shared`, then `api` and `web`        |
| `pnpm typecheck`                               | `tsc` across every package, including tests |
| `pnpm lint` / `pnpm format`                    | ESLint / Prettier                           |
| `pnpm test`                                    | `vitest` across every package               |
| `pnpm --filter @nexuscentral/api migrate up`   | Apply migrations                            |
| `pnpm --filter @nexuscentral/api migrate down` | Roll back the last migration                |

`migrate` reads `DATABASE_URL`. It resolves the migrations directory from `MIGRATIONS_DIR`,
defaulting to `../../migrations` — the Docker image sets it to `/app/migrations`.

## Deployment

Docker Compose on the OVH VPS, behind the Traefik v3 that already owns 80/443 there.

Topology:

- **`postgres`** — not published, on the Docker network only.
- **`api`** — not published to the host either. It binds `0.0.0.0` _inside its container_ so
  `web` can reach it; there is no `ports:` mapping. Locally, outside Docker, `BIND_ADDR`
  defaults to `127.0.0.1`.
- **`web`** — Nginx serving the built SPA and proxying `/api` to `api:3000`. Published on
  `127.0.0.1:8080`, and joined to the external `web_network` so Traefik can route to it.

The API logs a startup warning when it is bound to all interfaces with `TRUST_PROXY` unset:
that combination means either it is directly exposed or client IPs are wrong.

### First deploy

On the VPS, as the user that owns `/opt/apps`:

```bash
mkdir -p /opt/apps/nexuscentral && cd /opt/apps/nexuscentral
# .env is untracked, so it survives every `git reset --hard` the deploy does.
vi .env        # DOMAIN, TRAEFIK_CERTRESOLVER, POSTGRES_PASSWORD, AUTH_PASSWORD
```

`AUTH_PASSWORD` is needed **once**. The API stores it on the first boot that finds no
password and refuses to serve without one, so `deploy.sh` checks the database for a
credential and stops before building if there is neither. After the first sign-in, delete the
line: the password lives in the database from then on, is changed from **Settings → Security**,
and one left in `.env` ends up in every backup of `.env`.

Then run the deploy from anywhere (it clones into `/opt/apps/nexuscentral` itself):

```bash
./deploy.sh
```

Same model as the other apps on that host: GitHub App token → fetch → build → dump → migrate
→ health gate → prune. It refuses to start if `.env` is missing a required key, and it stops
before migrating if the pre-deploy dump fails.

| Flag            | Effect                                                            |
| --------------- | ----------------------------------------------------------------- |
| `--skip-backup` | Skip the pre-migration dump (a first deploy, or a throwaway host) |
| `--no-build`    | Reuse the images already on the host                              |

Ordering matters and is deliberate: PostgreSQL comes up **before the build** so the password
check fails in seconds rather than after three minutes of compiling, the migration runs in a
one-shot `run --rm` container, and only then does the application start. The API seeds the Home
dashboard on first boot, and an API that starts before the migration finds no tables, logs the
failure and never retries — so a first deploy in the other order comes up empty.

Nothing is rolled back automatically. If the health gate fails, the script prints the recent
API logs, the dump path and the exact rollback commands. Restoring after a migration discards
anything written since the dump, which is a decision to take with the logs in front of you.

### Backups

`deploy.sh` dumps before every migration. For a daily dump, from cron:

```
0 4 * * * /opt/apps/nexuscentral/deploy/backup-db.sh >> /var/log/nexuscentral-backup.log 2>&1
```

Optional, all off by default and all configured in `.env`: AES256 encryption at rest
(`NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE`), an off-machine copy (`NEXUSCENTRAL_RCLONE_REMOTE` — a dump that
only exists on the VPS does not survive losing the VPS), and a dead-man's-switch
(`NEXUSCENTRAL_HEALTHCHECK_URL`) that alerts when backups stop running. Rotation keeps
`NEXUSCENTRAL_BACKUP_KEEP` dumps, 14 by default.

A dump that restores nothing is not a backup, so `backup-db.sh` rejects an empty or malformed
dump rather than rotating a good one out for it, and the restore half ships too:

```bash
./deploy/restore-db.sh --check backups/nexuscentral_20260730-231351.sql.gz   # verify only
./deploy/restore-db.sh backups/nexuscentral_20260730-231351.sql.gz           # drops and reloads
```

### Local check of the production images

The compose stack builds and runs the same way locally, without Traefik:

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm --no-deps api pnpm migrate up
docker compose up -d
curl -s http://127.0.0.1:8080/api/health
```

## Environment

Every variable is documented in [.env.example](.env.example). `.env` is gitignored; secrets
are never logged, never returned by the API, and never committed.
