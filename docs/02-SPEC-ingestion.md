# 02 — SPEC: Ingestion, scoring and alerting

---

## 1. Architecture

```
pg-boss scheduler
      │
      ├─ poll:source (one job per due source)
      │        │
      │        ├─ RssAdapter ──┐
      │        ├─ RedditAdapter┤──> NormalizedItem[] ──> dedup ──> insert
      │        └─ NitterAdapter┘                                     │
      │                                                              v
      ├─ score:items ────────────────────────────────────────> scoring engine
      │                                                              │
      └─ deliver:alerts <───────────────────────────────────────────┘
```

The API server and the worker run in the **same process** by default, controlled by
`WORKER_ENABLED=true`. Keep them separable — no worker code may import from the HTTP layer.

## 2. Adapter contract

```ts
// packages/shared/src/adapter.ts
export interface NormalizedItem {
  url: string;
  title: string;
  summary?: string;
  author?: string;
  publishedAt: Date;
  engagementScore?: number;
  engagementComments?: number;
  guid?: string; // adapter-supplied stable id, preferred for dedup
  raw: unknown;
}

export interface FetchContext {
  source: Source;
  signal: AbortSignal; // 30s timeout, enforced by the runner
  logger: Logger;
}

export interface FetchResult {
  items: NormalizedItem[];
  notModified?: boolean; // HTTP 304 — items must be empty
  etag?: string;
  lastModified?: string;
}

export interface SourceAdapter {
  kind: SourceKind;
  fetch(ctx: FetchContext): Promise<FetchResult>;
  /** Validate + enrich a user-entered identifier before the source is created. */
  resolve(input: string): Promise<ResolvedSource>;
}
```

Every adapter must be unit-testable against recorded fixtures with no network access.
Store fixtures in `/apps/api/test/fixtures/<kind>/`.

## 3. Adapters

### 3.1 RSS

- Send `If-None-Match` / `If-Modified-Since` from `sources.http_etag` / `http_modified`.
  On `304`, return `{ items: [], notModified: true }` and do not touch the item store.
- `User-Agent: nexuscentral/<version> (+self-hosted)`.
- Accept `application/rss+xml`, `application/atom+xml`, `application/xml`, `text/xml`.
- Cap response body at 10 MB; abort beyond.
- `publishedAt` fallback chain: `isoDate` → `pubDate` → `updated` → `now()`. Log at WARN
  when falling through to `now()`, it means the feed is unreliable and dedup carries more
  weight.
- `summary`: strip HTML, collapse whitespace, truncate to 1000 chars on a word boundary.

**`resolve(input)`** must accept a page URL, not just a feed URL:

1. If the URL responds with an XML content type, it is the feed.
2. Otherwise fetch as HTML and look for
   `<link rel="alternate" type="application/rss+xml|application/atom+xml">`.
3. If several are found, return all candidates and let the UI choose.
4. Also try `/feed`, `/rss`, `/index.xml`, `/atom.xml` relative to the origin as a last
   resort.

Return `{ feedUrl, title, siteUrl, iconUrl, sampleItems: NormalizedItem[3] }`.

### 3.2 Reddit

**Auth.** OAuth2 `client_credentials` against `https://www.reddit.com/api/v1/access_token`
with HTTP basic auth (`client_id:client_secret`). Cache the token in memory with a 60s
safety margin before its `expires_in`. A token refresh is one request — negligible.

**Requests.** All data calls go to `https://oauth.reddit.com`, never `www.reddit.com`.
`User-Agent` must be descriptive and stable, e.g.
`nexuscentral/1.0 (self-hosted personal aggregator)`. Reddit blocks generic agents.

Endpoint: `GET /r/{subreddit}/new?limit=100`. Use `before={fullname}` with the newest
previously-seen fullname (stored in `items.raw->>'name'` for that source) to fetch only
what is new.

**Rate limiting.** After every response read:

```
x-ratelimit-used       requests used in the current window
x-ratelimit-remaining  requests left
x-ratelimit-reset      seconds until the window resets
```

Maintain a shared `RedditBudget` singleton. Before dispatching, if `remaining < 10`, sleep
until `reset`. Do **not** hardcode a counter — the headers are authoritative and the
published limits have changed before.

**Never** call the unauthenticated `.json` endpoints. They are IP-tracked, capped near
10 QPM, and the deployment runs on a datacenter IP.

**Mapping.** `data.children[].data`:

| Reddit field                                 | NormalizedItem       |
| -------------------------------------------- | -------------------- |
| `permalink` (prefix `https://reddit.com`)    | `url`                |
| `title`                                      | `title`              |
| `selftext` (truncated) or `url` if link post | `summary`            |
| `author`                                     | `author`             |
| `created_utc` × 1000                         | `publishedAt`        |
| `ups`                                        | `engagementScore`    |
| `num_comments`                               | `engagementComments` |
| `name` (e.g. `t3_abc123`)                    | `guid`               |

Skip items where `stickied` is true.

**`resolve(input)`** accepts `nutanix`, `r/nutanix`, `/r/nutanix`, or a full reddit URL.
Normalise to a bare lowercase subreddit name, then `GET /r/{name}/about` to confirm it
exists and pull `title`, `icon_img`, `subscribers`.

**Credentials missing.** If `reddit_client_id` is unset, Reddit sources must be created but
left inactive, and the UI must show why. Do not crash the worker.

### 3.3 Nitter (X/Twitter) — best-effort

- `settings.nitter_base_urls` holds an ordered list of instance base URLs, self-hosted
  first. Try each in order until one returns a parseable feed.
- Fetch `{base}/{handle}/rss` and parse it with the **RSS adapter's parser** — reuse, do
  not duplicate.
- Rewrite item URLs from the Nitter host to `https://x.com/...` so that `content_hash`
  stays stable if the instance changes. This is not optional; without it, switching
  instance duplicates the entire history.
- Strip the `RT by @handle:` prefix into a `retweet` boolean in `raw`.

**Silent-death detection.** This adapter fails by returning an empty but well-formed feed.
Increment `sources.consecutive_empty` on every zero-item run. At **3**, create a
`source_health` alert. Do not treat empty as success just because HTTP was 200.

Mark this adapter as degradable: its failures must never abort the polling cycle for other
sources.

## 4. Deduplication

```
content_hash = sha256(
  source.kind + '|' + source.identifier + '|' +
  (item.guid ?? canonicalize(item.url))
)
```

`canonicalize(url)`:

1. Lowercase scheme and host, strip `www.`
2. Drop the fragment
3. Remove tracking params: `utm_*`, `fbclid`, `gclid`, `ref`, `ref_src`, `s`, `si`
4. Sort remaining query params
5. Strip a trailing slash on a non-empty path

Insert with `ON CONFLICT (content_hash) DO NOTHING`, then use `RETURNING id` to determine
which rows were genuinely new — only those get scored and alerted on.

The hash includes the source, so the same article arriving from two feeds appears twice.
That is deliberate: cross-source dedup would hide the fact that a story is spreading.

## 5. Scoring engine

Pure function, no I/O, fully unit-tested.

```ts
score = (base + ruleWeights + engagement) × source.weight × recencyDecay
```

### 5.1 Components

**`base`** = `1.0` for every item.

**`ruleWeights`** = sum of `rule.weight` for every active rule whose pattern matches the
item within its `scope`, filtered by `tag_filter` when non-empty. Record every matching
rule id in `items.matched_rules`.

**`engagement`** — Reddit only, otherwise `0`:

```
engagement = min(2.0, log10(max(1, ups)) × 0.5)
```

Logarithmic so that a 5000-upvote post does not permanently outrank everything.

**`recencyDecay`** — half-life of 24 hours, floored:

```
recencyDecay = max(0.15, 0.5 ^ (ageHours / 24))
```

### 5.2 Rescoring

Scores depend on age, so they drift. Recompute in a `score:refresh` job every hour for
items from the last 7 days. Beyond that the decay floor makes further recomputation
pointless.

### 5.3 Regex safety

User-supplied patterns can hang the worker.

- Compile every pattern **once per scoring batch**, not per item.
- Reject patterns longer than 200 characters at the API boundary.
- Run matching inside a `worker_thread` with a 50 ms per-item budget. On timeout, deactivate
  the rule, set `last_error`, and surface it in the UI.
- Reject nested quantifiers detected by a simple heuristic (`(a+)+`, `(a*)*`) at creation
  time with an explanatory message.

### 5.4 Explainability

The API must be able to answer "why is this item scored 8.4?". Store `matched_rules` and
expose a computed breakdown on the item detail endpoint:

```json
{
  "score": 8.42,
  "breakdown": {
    "base": 1.0,
    "rules": [{ "id": 3, "name": "CVE mentions", "weight": 5.0 }],
    "engagement": 1.35,
    "sourceWeight": 1.5,
    "recencyDecay": 0.79
  }
}
```

## 6. Alerting

When a newly inserted item matches a rule with `alert = true`, insert into `alerts` and
enqueue `deliver:alerts`.

**Delivery targets** — all free and self-hostable:

| Kind      | Method                                                                               |
| --------- | ------------------------------------------------------------------------------------ |
| `ntfy`    | `POST {url}` with `Title`, `Priority`, `Tags`, `Click` headers. Recommended default. |
| `gotify`  | `POST {url}/message?token=…` with `{title, message, priority}`                       |
| `discord` | `POST {webhook}` with `{content, embeds:[{title,url,description}]}`                  |
| `generic` | `POST {url}` with the full alert JSON                                                |
| `none`    | In-app only                                                                          |

**Batching.** Deliver at most one notification per 60 seconds. If several alerts are
pending, send one grouped message. A rule matching 40 items must not produce 40 pushes.

**Retry.** 3 attempts with exponential backoff (1s, 5s, 25s). On final failure, record
`delivery_error` and leave `delivered_at` null — the in-app alerts widget remains the
source of truth.

**Never retroactively alert.** When a rule with `alert = true` is created, the rescoring
job must set `matched_rules` but must **not** generate alerts for pre-existing items.
Otherwise the first useful rule fires hundreds of notifications.

## 7. Scheduler

`poll:tick` runs every minute and enqueues `poll:source` for every source where
`last_run_at + poll_interval < now()` and `active = true`.

- Concurrency: 4 concurrent `poll:source` jobs.
- Per-job timeout: 60 s.
- Jitter: delay each enqueued job by `random(0, 20s)` to avoid a thundering herd on the
  minute boundary.

**Failure backoff.** On error, increment `consecutive_failures` and extend the effective
interval: `poll_interval × min(8, 2 ^ consecutive_failures)`. Reset to 0 on success. At
10 consecutive failures, set `active = false` and raise a health alert — a permanently dead
feed should stop consuming budget.

## 8. Observability

Structured JSON logs (`pino`). Every poll logs one line: source id, kind, duration, item
count, new count, HTTP status, error.

Expose `GET /api/health` returning per-source status, budget state and job queue depth.
This backs the `source_health` widget.
