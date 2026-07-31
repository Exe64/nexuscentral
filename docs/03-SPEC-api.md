# 03 — SPEC: HTTP API

Express 5, TypeScript. Base path `/api`. JSON in, JSON out. No authentication (see
`00-CONTEXT.md` §5).

---

## 1. Conventions

- All request bodies and query params validated with `zod`. A validation failure returns
  `400` with the field-level detail — never a stack trace.
- Errors use a single shape:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": { … } } }
```

Codes: `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `UPSTREAM_FAILED`,
`RATE_LIMITED`, `INTERNAL`.

- Lists are cursor-paginated, never offset-paginated:
  `?limit=50&cursor=<opaque>` → `{ data: [...], nextCursor: string | null }`.
  The cursor encodes `(sortValue, id)` base64url.
- `PATCH` accepts partial bodies. `PUT` is not used anywhere.

## 2. Sources

```
GET    /api/sources                 ?kind=&tag=&active=&q=
POST   /api/sources
GET    /api/sources/:id
PATCH  /api/sources/:id
DELETE /api/sources/:id
POST   /api/sources/:id/poll        force an immediate poll
POST   /api/sources/resolve         preview before creation
POST   /api/sources/import          OPML upload
GET    /api/sources/export          OPML download
```

### `POST /api/sources/resolve`

The single most important endpoint for usability. One free-text input, server figures out
the rest.

```json
// request
{ "input": "https://www.nutanix.com/blog" }

// response
{
  "candidates": [
    {
      "kind": "rss",
      "identifier": "https://www.nutanix.com/blog/rss.xml",
      "title": "Nutanix Blog",
      "siteUrl": "https://www.nutanix.com/blog",
      "iconUrl": "https://www.nutanix.com/favicon.ico",
      "sampleItems": [
        { "title": "…", "publishedAt": "2026-07-28T09:00:00Z", "url": "…" }
      ]
    }
  ]
}
```

Detection order:

1. `r/name`, `/r/name`, or a `reddit.com/r/…` URL → `reddit`
2. `x.com/handle`, `twitter.com/handle`, or `@handle` → `nitter`
3. Anything else → `rss`, via the resolution chain in `02-SPEC-ingestion.md` §3.1

Always return `sampleItems` (up to 3). Seeing real items before committing is what makes
adding a source feel safe. Timeout the whole operation at 15 s and return
`UPSTREAM_FAILED` rather than hanging the UI.

### `POST /api/sources`

```json
{
  "kind": "reddit",
  "identifier": "nutanix",
  "title": "r/nutanix",
  "tagIds": [1, 4],
  "weight": 1.5,
  "pollInterval": "15 minutes"
}
```

`409 CONFLICT` when `(kind, identifier)` already exists, with the existing source's id in
`details` so the UI can offer to open it.

## 3. Tags

```
GET    /api/tags            includes sourceCount and unreadCount per tag
POST   /api/tags
PATCH  /api/tags/:id        rename, recolour
DELETE /api/tags/:id
```

Deleting a tag must, in one transaction: delete `source_tags` rows, strip the id from every
`rules.tag_filter`, and strip it from every `widgets.config.tagIds`. Return the count of
affected widgets so the UI can warn.

## 4. Items

```
GET    /api/items
GET    /api/items/:id        includes the score breakdown
POST   /api/items/:id/read
DELETE /api/items/:id/read   mark unread
POST   /api/items/:id/star
DELETE /api/items/:id/star
POST   /api/items/read-all   body: same filters as GET /api/items
```

`GET /api/items` query params:

| Param         | Type                               | Notes                                             |
| ------------- | ---------------------------------- | ------------------------------------------------- |
| `tagIds`      | `int[]`                            | Items from sources carrying **any** of these tags |
| `sourceIds`   | `int[]`                            |                                                   |
| `unreadOnly`  | `bool`                             | default `false`                                   |
| `starredOnly` | `bool`                             |                                                   |
| `minScore`    | `number`                           |                                                   |
| `since`       | `ISO date`                         |                                                   |
| `q`           | `string`                           | full-text over title + summary                    |
| `sort`        | `score \| published \| engagement` | default `published`                               |
| `limit`       | `int`                              | 1–100, default 50                                 |
| `cursor`      | `string`                           |                                                   |

Every item in the response carries its source (`id`, `title`, `kind`, `iconUrl`) and that
source's tags, denormalised. The client must never need a second round trip to render a
row.

## 5. Rules

```
GET    /api/rules
POST   /api/rules
PATCH  /api/rules/:id
DELETE /api/rules/:id
POST   /api/rules/test        dry run — does not persist
```

### `POST /api/rules/test`

Non-negotiable feature. Without it, rules are written blind.

```json
// request
{ "pattern": "CVE-\\d{4}", "flags": "i", "scope": "both", "tagFilter": [] }

// response
{
  "valid": true,
  "matchCount": 17,
  "sampleSize": 300,
  "matches": [
    { "itemId": 8412, "title": "…", "sourceTitle": "…",
      "highlight": { "field": "title", "start": 12, "end": 20 } }
  ]
}
```

Run against the 300 most recent items. Return `{ valid: false, error }` for an invalid or
unsafe pattern instead of throwing. Apply the same ReDoS guards as the scoring engine.

Creating, updating or deleting a rule enqueues a debounced `rescore:all`.

## 6. Dashboards and widgets

```
GET    /api/dashboards
POST   /api/dashboards
PATCH  /api/dashboards/:id
DELETE /api/dashboards/:id
GET    /api/dashboards/:id            dashboard + widgets, no widget data
GET    /api/dashboards/:id/data       ← batched payloads for every widget
PATCH  /api/dashboards/:id/layout     bulk layout persistence

POST   /api/widgets
PATCH  /api/widgets/:id
DELETE /api/widgets/:id
POST   /api/widgets/:id/data          single-widget refresh
```

### `GET /api/dashboards/:id/data`

Resolves every widget's payload server-side, in parallel, and returns them keyed by widget
id. This is decision **D7** — it exists so the browser opens one connection, not fifteen.

```json
{
  "widgets": {
    "12": { "status": "ok", "data": { "items": [ … ], "total": 240 } },
    "13": { "status": "error", "error": { "code": "UPSTREAM_FAILED", "message": "…" } }
  },
  "generatedAt": "2026-07-30T08:12:00Z"
}
```

A single failing widget must degrade to a `status: "error"` entry. It must never fail the
whole response.

Cache each widget payload server-side keyed by
`hash(widget.id, widget.config, lastItemInsertedAt)`, TTL 60 s.

### `PATCH /api/dashboards/:id/layout`

```json
{ "layouts": [{ "widgetId": 12, "breakpoint": "lg", "x": 0, "y": 0, "w": 4, "h": 6 }] }
```

Called on drag/resize end, debounced client-side to ~1 s. One transaction for the whole
batch.

## 7. Custom API widgets

```
POST   /api/custom-api/preview     test a fetch spec before saving
```

The backend is the proxy for every `custom_api` widget — the browser never calls a third
party directly. This keeps API keys server-side and sidesteps CORS entirely.

```json
{
  "url": "https://api.github.com/repos/{owner}/{repo}/releases",
  "params": { "per_page": "5" },
  "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
  "mapping": {
    "root": "$",
    "fields": {
      "title": "$.name",
      "url": "$.html_url",
      "subtitle": "$.tag_name",
      "timestamp": "$.published_at"
    }
  }
}
```

- `${VAR}` placeholders resolve from environment variables server-side. A missing variable
  is an error at save time, not at render time.
- `mapping` uses JSONPath (`jsonpath-plus`). `root` selects the array; `fields` map each
  element to the generic item shape.
- **SSRF guard:** reject URLs resolving to private ranges (`10/8`, `172.16/12`,
  `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`) unless
  `ALLOW_PRIVATE_TARGETS=true` is set. Resolve DNS and check the resolved address, not the
  hostname.
- Cap response at 5 MB, timeout 15 s.
- Cache per widget config hash with the widget's configured TTL, default 30 min.

## 8. Settings and health

```
GET    /api/settings          secrets masked as { "configured": true }
PATCH  /api/settings
POST   /api/settings/test-webhook
POST   /api/settings/test-reddit    verifies OAuth credentials
GET    /api/health
GET    /api/stats                   counts for the stats widget
```

`GET /api/health`:

```json
{
  "status": "degraded",
  "sources": { "total": 42, "active": 40, "failing": 2, "stale": 1 },
  "reddit": { "configured": true, "remaining": 98, "resetIn": 412 },
  "queue": { "pending": 3, "failed": 0 },
  "lastPollAt": "2026-07-30T08:10:00Z"
}
```

`status` is `ok` when nothing is failing, `degraded` when some sources fail, `error` when
the database is unreachable.

## 9. Alerts

```
GET    /api/alerts               ?acknowledged=false
POST   /api/alerts/:id/ack
POST   /api/alerts/ack-all
```
