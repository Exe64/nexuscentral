# 01 — SPEC: Data model

PostgreSQL 16. All migrations under `/migrations`, managed by `node-pg-migrate`.
All timestamps are `timestamptz`, stored in UTC.

---

## 1. Schema

### 1.1 `tags`

```sql
CREATE TABLE tags (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL,
  color       text NOT NULL DEFAULT 'neutral',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_slug_unique UNIQUE (slug),
  CONSTRAINT tags_color_valid CHECK (
    color IN ('neutral','red','orange','amber','green','teal','blue','violet','pink')
  )
);
```

`slug` is `name` lowercased, non-alphanumerics collapsed to `-`. Generated server-side;
never trust the client. `color` is a token name, not a hex value — actual colours are
resolved by the theme (see `04-SPEC-frontend.md` §5).

### 1.2 `sources`

```sql
CREATE TYPE source_kind AS ENUM ('rss', 'reddit', 'nitter');

CREATE TABLE sources (
  id              serial PRIMARY KEY,
  kind            source_kind NOT NULL,
  title           text NOT NULL,
  -- Canonical identifier per kind:
  --   rss    -> absolute feed URL
  --   reddit -> subreddit name, lowercase, no "r/" prefix
  --   nitter -> X handle, lowercase, no "@" prefix
  identifier      text NOT NULL,
  site_url        text,
  icon_url        text,
  weight          numeric(4,2) NOT NULL DEFAULT 1.00,
  active          boolean NOT NULL DEFAULT true,
  poll_interval   interval NOT NULL DEFAULT '15 minutes',

  -- Conditional-request state (rss only)
  http_etag       text,
  http_modified   text,

  -- Health
  last_run_at     timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  consecutive_empty     integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_identity_unique UNIQUE (kind, identifier),
  CONSTRAINT sources_weight_range CHECK (weight >= 0 AND weight <= 10)
);

CREATE INDEX sources_due_idx ON sources (active, last_run_at NULLS FIRST);
```

`weight` multiplies the item's base score. `1.00` is neutral.

### 1.3 `source_tags`

```sql
CREATE TABLE source_tags (
  source_id  integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tag_id     integer NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  PRIMARY KEY (source_id, tag_id)
);

CREATE INDEX source_tags_tag_idx ON source_tags (tag_id);
```

### 1.4 `items`

The normalised store. One row per distinct piece of content.

```sql
CREATE TABLE items (
  id            bigserial PRIMARY KEY,
  source_id     integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,

  -- Deduplication key. See 02-SPEC-ingestion.md §4.
  content_hash  bytea NOT NULL,

  url           text NOT NULL,
  title         text NOT NULL,
  summary       text,           -- plain text, HTML stripped, max 1000 chars
  author        text,
  published_at  timestamptz NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),

  -- Source-specific engagement signals, null when not applicable
  engagement_score    integer,  -- reddit: ups
  engagement_comments integer,  -- reddit: num_comments

  -- Scoring output
  score          numeric(6,2) NOT NULL DEFAULT 0,
  matched_rules  integer[] NOT NULL DEFAULT '{}',
  scored_at      timestamptz,

  -- User state
  read_at        timestamptz,
  starred        boolean NOT NULL DEFAULT false,

  raw            jsonb,          -- original payload, for debugging adapters

  CONSTRAINT items_hash_unique UNIQUE (content_hash)
);

CREATE INDEX items_feed_idx     ON items (published_at DESC) WHERE read_at IS NULL;
CREATE INDEX items_score_idx    ON items (score DESC, published_at DESC);
CREATE INDEX items_source_idx   ON items (source_id, published_at DESC);
CREATE INDEX items_starred_idx  ON items (published_at DESC) WHERE starred = true;
CREATE INDEX items_search_idx   ON items
  USING gin (to_tsvector('simple', title || ' ' || coalesce(summary,'')));
```

`raw` is retained only for items younger than 7 days (see §3).

### 1.5 `rules`

```sql
CREATE TYPE rule_scope AS ENUM ('title', 'summary', 'both', 'author');

CREATE TABLE rules (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  pattern     text NOT NULL,        -- JS-flavoured regex source, no delimiters
  flags       text NOT NULL DEFAULT 'i',
  scope       rule_scope NOT NULL DEFAULT 'both',
  weight      numeric(4,2) NOT NULL DEFAULT 1.00,
  alert       boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  -- When non-empty, the rule only applies to items from sources carrying one of these tags
  tag_filter  integer[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rules_flags_valid CHECK (flags ~ '^[imsu]*$')
);
```

`weight` may be negative — that is how noise is demoted.

Patterns are user-supplied regexes and are a ReDoS surface. Mitigation in
`02-SPEC-ingestion.md` §5.3.

### 1.6 `alerts`

```sql
CREATE TABLE alerts (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rule_id       integer NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  delivery_error text,
  acknowledged_at timestamptz,
  CONSTRAINT alerts_unique UNIQUE (item_id, rule_id)
);

CREATE INDEX alerts_pending_idx ON alerts (created_at) WHERE delivered_at IS NULL;
```

### 1.7 `dashboards` and `widgets`

```sql
CREATE TABLE dashboards (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE widget_type AS ENUM ('feed', 'custom_api', 'alerts', 'source_health', 'stats');

CREATE TABLE widgets (
  id            serial PRIMARY KEY,
  dashboard_id  integer NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type          widget_type NOT NULL,
  title         text NOT NULL,
  config        jsonb NOT NULL DEFAULT '{}',
  layout        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX widgets_dashboard_idx ON widgets (dashboard_id);
```

**`layout` shape** — one entry per `react-grid-layout` breakpoint:

```json
{
  "lg": { "x": 0, "y": 0, "w": 4, "h": 6 },
  "md": { "x": 0, "y": 0, "w": 5, "h": 6 },
  "sm": { "x": 0, "y": 0, "w": 6, "h": 6 }
}
```

`config` shapes are defined per widget type in `04-SPEC-frontend.md` §4. Validate with
`zod` on write; a widget with an invalid config must be rejected at the API boundary, not
discovered at render time.

### 1.8 `settings`

Singleton row, enforced.

```sql
CREATE TABLE settings (
  id                 boolean PRIMARY KEY DEFAULT true,
  theme_mode         text NOT NULL DEFAULT 'system',
  accent_hue         integer NOT NULL DEFAULT 250,
  accent_chroma      numeric(4,3) NOT NULL DEFAULT 0.140,
  items_retention_days  integer NOT NULL DEFAULT 90,
  alert_webhook_url  text,
  alert_webhook_kind text NOT NULL DEFAULT 'none',
  reddit_client_id   text,
  reddit_client_secret text,
  nitter_base_urls   text[] NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id),
  CONSTRAINT settings_theme_valid CHECK (theme_mode IN ('light','dark','system')),
  CONSTRAINT settings_hue_range CHECK (accent_hue BETWEEN 0 AND 360),
  CONSTRAINT settings_chroma_range CHECK (accent_chroma BETWEEN 0 AND 0.37),
  CONSTRAINT settings_webhook_valid CHECK (
    alert_webhook_kind IN ('none','ntfy','gotify','discord','generic')
  )
);
```

Secrets (`reddit_client_secret`) may be supplied by environment variable instead; the env
value wins when both are present. **Never return secret columns from the API** — expose a
boolean `configured` flag instead.

---

## 2. Referential rules

- Deleting a source cascades to its items, and through them to alerts. This is intended:
  removing a source removes its history.
- Deleting a tag removes it from sources and strips it from `rules.tag_filter`
  (application-level, in the same transaction — arrays have no FK support).
- Deleting a rule cascades to its alerts but leaves `items.matched_rules` stale. A
  rescoring job (§3) reconciles this.

## 3. Maintenance jobs

Registered with `pg-boss`, all idempotent.

| Job               | Schedule                     | Action                                                                                                     |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `retention:items` | daily 03:00                  | Delete items older than `items_retention_days` that are not starred.                                       |
| `retention:raw`   | daily 03:10                  | `UPDATE items SET raw = NULL WHERE fetched_at < now() - interval '7 days'`                                 |
| `rescore:all`     | on rule create/update/delete | Recompute `score` and `matched_rules` for all items from the last 30 days. Batch 500 rows per transaction. |
| `vacuum:analyze`  | weekly                       | `VACUUM ANALYZE items`                                                                                     |

`rescore:all` must be debounced — rapid successive rule edits enqueue one job, not five.

## 4. Seed data

On first boot, when `dashboards` is empty:

- Create dashboard `Home` at position 0.
- Create three widgets: a `feed` widget with no tag filter sorted by score, an `alerts`
  widget, and a `source_health` widget.
- Create no tags, sources or rules. Empty states in the UI must be genuinely useful — see
  `04-SPEC-frontend.md` §8.
