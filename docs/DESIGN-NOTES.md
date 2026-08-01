# Design notes

Why things are built the way they are. The README says what the application does; this says
what the alternatives were and why they lost.

Moved out of the README when that became a presentation of the application rather than an
account of building it. Nothing here is needed to run or use Nexus Central.

---

## Authentication

One password, one user. This **reverses `00-CONTEXT.md` §5**, which had the app carry no
login and sit behind the reverse proxy's basic auth. Basic auth has no logout, nothing to
revoke, and re-sends the credential on every request; the application authenticates for
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
  Stored in PostgreSQL, not in memory: a lockout a restart clears is not a lockout.
- **Every route is closed** except `GET /api/health` and `/api/auth/*`. The gate is mounted
  once, in front of the routers, so a router added later is protected by default. A test walks
  the real Express router tree and asserts a 401 for each — a hand-written list would drift.
- `/api/health` answers in two shapes: liveness only to anyone (the container healthcheck and
  `deploy.sh` both run before login is possible), and source counts, Reddit budget and queue
  depth only once authenticated. Those describe what the instance follows.

Changing the password revokes every other session, because the usual reason to change it is
that someone else has it. Changing it requires the current one even from an open session, so
a borrowed session cannot lock the owner out.

`set-password` runs `node` rather than `pnpm`: the image activates pnpm through corepack,
which wants to reach npmjs the first time a non-root user invokes it, and a password reset
must not need outbound network.

---

## The SSRF guard

A `custom_api` widget URL is an instruction to make **this server** issue a request. Left
unchecked that reaches the Docker network, the host loopback, and on a cloud host the
metadata service that hands out credentials.

So, in order:

1. The hostname is **resolved first** and every resolved address is checked — not the name.
2. The connection is **pinned to the address that was checked**, so a second lookup cannot
   return something else.
3. Redirects are **followed by hand**, so each hop goes through the guard again.
4. `Host` cannot be set by the widget.
5. The body is capped at 5 MB **while reading**, rather than trusting `content-length`.

`ALLOW_PRIVATE_TARGETS=true` turns it off for a homelab, and is off by default.

The same guard covers the `og:image` enrichment job, which fetches URLs third parties chose.

### Testing it honestly

The integration config sets `ALLOW_PRIVATE_TARGETS: 'true'`, so an SSRF assertion written
there passes on a **connection timeout** and would keep passing with the guard deleted. The
guard's test is therefore a unit test where the guard is on and the _timing_ is part of the
assertion — blocked addresses must be refused in milliseconds, not seconds.

---

## Rule safety (ReDoS)

User-supplied regexes are a ReDoS surface, so there are three layers:

1. **At the API boundary**: a 200-character cap, `g` and `y` rejected (they carry `lastIndex`
   between calls, so a rule would match or not depending on what ran before it), and a
   heuristic that rejects nested unbounded repetition — `(a+)+`, `(\w+)+` — with a message
   saying how to rewrite it.
2. **Compiled once per batch**, not once per item.
3. **A 50 ms per-item budget in a worker thread.** This is the only layer that stops a pattern
   already backtracking. The worker writes its position to shared memory before every
   `test()`, so when the host kills the thread it can name the rule that hung, disable it with
   the reason on the rule row, and finish the rest of the run.

The heuristic is a heuristic and does not claim to catch every slow pattern. Layer 3 is what
makes that acceptable.

---

## Scoring jobs

| Job             | When                                        | Work                                                              |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `score:items`   | after every poll                            | scores only the items just inserted                               |
| `rescore:all`   | on rule create/update/delete, debounced ~5s | re-evaluates every pattern over 30 days                           |
| `score:refresh` | hourly                                      | recomputes arithmetic over 7 days from stored matches, no regexes |

50,000 items rescore in about 2.3 seconds on the development machine.

The hourly refresh only bothers with the last 7 days because recency decay reaches its 0.15
floor at about 66 hours — past that, age stops discriminating.

---

## Retention

The purge deletes in batches of 5,000 rather than one statement: 100k rows in a single
transaction holds a long lock on the table the reader is querying, and `alerts` cascades from
it. Several smaller transactions leave gaps for everything else.

`raw` goes after a week because it exists to debug an adapter, which is something you do days
after a poll rather than months.

The weekly vacuum is not optional at this rate of deletion — without refreshed statistics the
planner starts preferring sequential scans over the indexes the reader depends on.

**A starred item is never deleted**, however old. Starring is the user saying "keep this", and
a retention policy that overrules it is a bug people discover exactly once.

---

## Measured at scale

100 sources and 200,000 items, timed through the HTTP layer rather than against the query, so
the number includes the filter, the keyset, the source join, the tag denormalisation and the
serialisation:

| Query                    | Time  |
| ------------------------ | ----- |
| First page, newest first | 8 ms  |
| Page 11, via the cursor  | 7 ms  |
| Sorted by score          | 6 ms  |
| Unread only              | 7 ms  |
| Filtered by tag          | 9 ms  |
| Full-text search         | 9 ms  |
| Search + filter + sort   | 6 ms  |
| Dashboard, three widgets | 32 ms |

The budget was 200 ms. Purging 100k rows took 2.4 s across 20 batches.

These are asserted, not printed: a performance test that only logs is one that fails silently
the day it regresses. The bar is the spec's 200 ms rather than whatever this machine does
today, so it does not become a benchmark of the CI host.

One assertion is worth more than the timings — the search test reads the query plan and
requires `items_search_idx`. The expression in the data layer has to match the index
definition exactly or PostgreSQL silently ignores it, and at 200k rows that is the difference
between 9 ms and a sequential scan. Nothing about the API's behaviour would change, which is
what makes it worth a test.

---

## Theming

The ramp is derived in OKLCH rather than HSL because OKLCH keeps perceptual lightness constant
across hues — a yellow accent and a blue accent end up equally readable, which is not true of
an HSL ramp. The neutrals carry a trace of the accent hue, so changing it changes the app
rather than just recolouring the buttons.

Components reference **only** semantic tokens (`--bg-surface`, `--text-secondary`, `--accent`).
Nothing reaches past them to a raw colour, which is what makes a named palette one more token
block rather than a rewrite.

**The palettes are adapted, not transcribed.** Canonical Solarized does not clear this
project's own contrast floor: its light body text measures 4.13:1 on its own background and
its secondary text 2.48:1, against a 4.5:1 requirement. The hues are kept exactly; the
lightness is adjusted until it reads. The settings page states this next to the palette rather
than quietly shipping something that is not quite Solarized.

**The contrast floor is a test, not an aspiration.** 442 assertions cover 12 hues × 2 chromas ×
both themes, plus 104 more for the named palettes. The test parses the shipped `tokens.css` and
evaluates the same `oklch()` and `calc()` expressions, so it measures what users get rather
than a copy of it.

Where this repository's token values differ from the spec's, and why, is documented at the top
of [tokens.css](../apps/web/src/styles/tokens.css). In short: the spec states both literal
values and a non-negotiable contrast floor, and measured across 12 hues the literal values do
not meet the floor. The floor won.

`localStorage` is the render-time cache and PostgreSQL is the source of truth: an inline script
in `index.html` applies the theme before the first paint, and the server value is adopted on
boot.

---

## Preview images

Coverage was measured across real feeds before the extractor was written, because the right
shape depends entirely on what publishers actually emit:

| Feed              | Items with an image | From                                   |
| ----------------- | ------------------- | -------------------------------------- |
| Ars Technica      | 20/20               | `media:content`, `media:thumbnail`     |
| The Verge         | 10/10               | first `<img>` in the body              |
| Reddit `/new.rss` | 8/25                | `media:thumbnail`, link posts only     |
| GitHub blog       | 3/10                | first `<img>` in the body              |
| Hacker News       | 0/30                | nothing — the feed has no body         |
| YouTube           | 15/15               | `media:thumbnail` inside `media:group` |

No single channel is enough, which is why the HTML fallback is not optional: it is the only
thing that covers The Verge. Tiny images and known analytics hosts are skipped, or a feed that
opens its body with a tracking pixel would give a wall of 1×1 previews.

The table is re-measured whenever shared parsing changes.

The gaps are filled by **`enrich:images`**, a queued job that reads the article's `og:image`.
It runs outside the poll — a poll has a 30s ceiling and no business spending it on twenty
article fetches — in batches of 25, three at a time, re-enqueueing itself while rows remain so
an existing database backfills gradually instead of firing thousands of requests at once. It
stops reading at `</head>`: the tag is there, and articles run to megabytes.

`image_checked_at` records that an item was _tried_, which is not the same as an image having
been found. Most articles without one will never have one, and without that column the job
would re-fetch every one of them forever.

Thumbnails are hotlinked with `referrerpolicy="no-referrer"` — several CDNs, `preview.redd.it`
among them, refuse a request naming another site, and sending one leaks the reading history.

### Source icons are not thumbnails

A thumbnail previews _this_ article; an icon is identical on every item from its source, so
putting it in the image column at the image's size fills a whole column with something that
never varies — worse than an empty box, because it draws the eye and then says nothing.

Cards mode does use it to fill the box when an article has no preview, drawn small and centred
on the muted background so it reads as "no preview, here is the source" rather than pretending
to be one. Rendered `contain`, not `cover`: cropping a wordmark to a square loses its first and
last letter.

**A subreddit added without Reddit credentials gets Reddit's generic logo.** The feed's
`<icon>` is `redditstatic.com/icon.png` for every subreddit, and `reddit.com/r/X/about.json`
answers 403 unauthenticated. The `reddit` adapter reads the real `community_icon` through the
OAuth API, so this fixes itself when credentials arrive.

---

## YouTube and `media:group`

YouTube emits **nothing** on the entry beyond a title, a link and a date: the thumbnail and the
description both sit inside `media:group`, and rss-parser only keeps namespaced elements it has
been told about. Measured against the live channel feed, a channel arrived as **0 of 15
thumbnails and 0 of 15 summaries** — fifteen bare titles, and a rule scoped to the summary could
never have matched a video.

There is a trap inside that group. The first media element is a `media:content` of type
`application/x-shockwave-flash`, 640×390, listed _before_ the thumbnail — big enough that no
size floor rejects it. Anything taking the first media element stores a dead Flash URL as the
article image. The `type` guard that already existed for podcast enclosures is what stops it.

Shape, measured rather than assumed: inside a group rss-parser returns children as **arrays**
even when there is one; at item level the same element arrives **unwrapped**.

Item-level media wins over the group's — a publisher emitting both hoisted one deliberately.
`media:description` is the _last_ summary source, behind any real body, because it describes
the media rather than the item.

---

## Reddit without credentials

The resolver falls back to Reddit's public Atom feed rather than refusing, and returns an
**rss** candidate — `rss` and not `reddit`, because without credentials there is no engagement
data and the source should not claim to be something it cannot be.

Names are lowercased, matching the bare identifier the data model stores. Reddit treats them
case-insensitively, and since `content_hash` is built from the identifier, keeping both
spellings of one subreddit would store every post in it twice.

**`/r/x.rss` is the _hot_ listing**, which leads with stickied posts months old and reorders as
things trend. A bare subreddit URL is rewritten to `/new.rss`; a listing typed on purpose is
kept, query string included.

**Multireddits are one request.** Reddit's unauthenticated budget is per IP and tight —
measured at roughly one request per 30–60s, with `x-ratelimit-remaining` at `0.0` after a
single call and no `Retry-After` sent. A 429 is therefore recorded as `throttled`, not as a
failure: it is written to `health.lastError` so the UI can say why a source is quiet, but it
moves neither `consecutive_failures` nor `last_ok_at`. Counting it as a failure would switch
off a healthy subreddit after ten throttled polls.

Moving a source to the `reddit` kind once credentials arrive will store the items still in the
feed window once more, since `content_hash` includes the kind and the identifier by design.

The comments firehose (`/r/x/comments/.rss`) resolves too, but it is one entry per _comment_,
titled `/u/author on <post title>`, and it does not carry `num_comments` either.

The authenticated rate budget reads the `x-ratelimit-*` headers and enforces two limits: never
consume more than half the window, and stop entirely below ten remaining requests. A
single-user instance polling 60 subreddits every 15 minutes uses about 4%.

---

## Alerting

Turning alerting on for a rule sets `matched_rules` across the last 30 days **without**
notifying about any of it — otherwise the first useful rule fires hundreds of pushes.

The configured URL is used **verbatim** for every target. The spec writes Gotify as
`{url}/message?token=…`; appending a path to a URL someone typed produces a 404 that is
impossible to debug behind a subpath proxy, so the settings panel says what to paste instead.

Retry is 1s/5s/25s inside the send. A failure records `delivery_error` while leaving the alert
pending — the dashboard stays the source of truth, and a webhook that was down for an hour
catches up.

---

## Custom API widgets

`${VAR}` in a URL, parameter or header is replaced from the server environment. A missing
variable is an error at preview time, not an empty `Authorization: Bearer ` that looks like a
credential problem three days later.

`POST /api/custom-api/preview` runs exactly the code the widget runs, and reports what the root
actually selected. That matters more than it sounds: jsonpath-plus does not validate paths at
all — `$[` is quietly treated as `$` and `nonsense((` returns nothing, neither throws — so
showing what a path selected is the only feedback that exists.

### Porting Glance widgets

```bash
pnpm --filter @nexuscentral/api port-widget path/to/README.md
```

Reads a Glance `custom-api` block as a **fetch specification**: URL, parameters, headers, and
the `.String "field"` accessors the template reads. It prints a draft config and says which
guesses it made. It does not interpret the Go template — that is unbounded work for no benefit
— and it never emits markup. Glance is AGPL-3.0, and a URL with a set of field names is a fact
rather than expression; keeping template HTML out of this is deliberate.

---

## Feed widget filters

Tags and sources combine the way faceted search does, and the way the reader already did: **any
of** the selected tags, **any of** the selected sources, but a source has to satisfy **both**
lists to contribute.

That is the one combination easy to get wrong from a form — tick a tag, tick a source that does
not carry it, and the widget is correct and permanently empty. So the form counts the
intersection live and says why when the count is zero. An id left behind by a deleted source
matches nothing and shows up in that count the same way.

The source list is searchable above eight sources, on title **and** identifier — the same pair
the API's `q` filter searches. Filtering is client-side because the list arrives whole and
unpaginated. A ticked source stays on screen even when the search excludes it; otherwise you
filter, tick, filter again, and what you picked is neither reviewable nor removable without
reconstructing the search that found it.

---

## The shell

Two stacked bars. The **application bar** spans the full width above the sidebar and carries
what belongs to the app rather than to a page: the name, search, refresh, the theme toggle and
the shortcut list. The **page bar** sits below it, inside the content column, and names where
you are.

Splitting them means the brand stays put while navigating, which is what makes the second bar
readable as "where you are". The page bar is the **single** place a page name is rendered.
Dashboards resolve to their real name rather than a generic label, because "Home" and
"Security" are the point of having several.

---

## Updates

### Which GitHub endpoint

`/compare/{sha}...main` answers the question _and_ counts the commits between, but it carries
the full patch for every changed file — **132 KB across five commits** of this repository, and
it grows with how far behind you are. That makes it heaviest exactly when you have reason to
check.

`commits?sha=main&per_page=1` is 6 KB flat. The compare _page_ is linked instead, so the diff
stays one click away and costs this app nothing.

The comparison is by **prefix**: `deploy.sh` passes seven characters and GitHub answers with
forty, and `===` would have called every deployment stale — a bug that would have looked like a
working feature, since "Update available" is the plausible answer.

`GIT_SHA` is a runtime variable, not a build arg: a build arg invalidates the image layer on
every commit, and `--no-build` would then ship an image labelled with the previous deployment's
sha.

### `unknown` is a state, not an error

A dev run has no build sha. GitHub can be unreachable, rate-limited, or answer something
unexpected. Each says so in those words, and none of them is `up_to_date`. A wrong "Update
available" costs a click; a wrong "Up to date" means running a known-broken build and believing
otherwise. Both suites assert it directly.

The refresh button forces past the cache but not past a 60-second floor, and never past a
rate-limit backoff — retrying inside GitHub's window earns another 403, and that 403 counts
against the next window too.

### Why a host agent, not the Docker socket

Updating means `git fetch`, `docker compose build`, a database dump and a migration. A
container can only do that if it holds the Docker socket, and **the Docker socket is root on
the host**: anything holding it can start a privileged container that mounts `/`. The API is on
the internet behind one password, and the host runs other applications. Handing it the socket
would mean one authentication bug costs the whole machine rather than one app.

A socket-proxy sidecar moves the privilege rather than removing it, and still cannot `git
fetch` or run a migration.

So the container **asks** and the host **acts**. The request is a **trigger, not a parameter** —
nothing in `request.json` ever reaches a command line, because `deploy.sh` always deploys the
head of `main`. A test asserts the file has exactly one key.

`UPDATE_CONTROL_DIR` is unset by default: with no agent listening the button would appear and
do nothing, and a button that silently does nothing is worse than no button. For the same
reason a request nothing claims within five minutes reads as `unclaimed`, and an `unavailable`
run explains itself when an update is available rather than leaving a silence where the button
would be.

---

## Deployment ordering

The order in `deploy.sh` is deliberate, and changing it breaks a first deploy:

1. **`.env` is validated first**, before anything with a side effect — a half-filled file
   fails in a second rather than after a `reset --hard` has already moved the working tree.
2. **PostgreSQL comes up before the build**, so the credential check fails in seconds rather
   than after three minutes of compiling.
3. **The migration runs in a one-shot `run --rm` container**, and only then does the
   application start. The API seeds the Home dashboard on first boot, and an API that starts
   before the migration finds no tables, logs the failure and never retries — so a first
   deploy in the other order comes up empty.

Nothing is rolled back automatically. Restoring after a migration discards anything written
since the dump, which is a decision to take with the logs in front of you, so the script
prints them and the exact commands rather than acting.

`.env` is untracked, so it survives every `git reset --hard` the deploy does.

The API logs a startup warning when it is bound to all interfaces with `TRUST_PROXY` unset:
that combination means either it is directly exposed or client IPs are wrong.

`docker-compose.dev.yml` is not named `docker-compose.override.yml` on purpose — that filename
loads automatically, including on the VPS, and publishing the database there would undo a
constraint the deployment relies on.

A dump that restores nothing is not a backup, so `backup-db.sh` rejects an empty or malformed
dump rather than rotating a good one out for it, and the restore half ships with it.

---

## Testing

There is deliberately no frontend E2E suite. The web tests render each page against a stubbed
API, and a separate test walks every `t()` call site to check the copy contract — no missing
keys, no unused keys, no string hardcoded in a component.

Two habits are worth keeping:

**Mutate the component to check the test.** A test asserting that something is _absent_ can
pass before the data has arrived, and keep passing with the feature deleted. One did: the
update indicator's absence test waited on `fetch` having been called, which fires before React
re-renders. It was found by mutating the component to always show the badge, not by reading the
test.

**Measure before designing.** Every adapter decision here — the Reddit rate limit, the RSS
image coverage table, the YouTube `media:group` shape, the GitHub payload sizes — came from
probing the real thing, and in each case the measurement changed the design.
