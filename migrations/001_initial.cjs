/**
 * 001_initial -- the full schema from 01-SPEC-data-model.md.
 *
 * Written as raw SQL rather than node-pg-migrate's builder DSL: the spec is the
 * source of truth and a literal transcription is trivially reviewable against
 * it. Every constraint and index below appears in that document.
 */

/* eslint-disable */
'use strict';

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // --- tags ---------------------------------------------------------------
  pgm.sql(`
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
  `);

  // --- sources ------------------------------------------------------------
  pgm.sql(`CREATE TYPE source_kind AS ENUM ('rss', 'reddit', 'nitter');`);

  pgm.sql(`
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
  `);

  pgm.sql(`CREATE INDEX sources_due_idx ON sources (active, last_run_at NULLS FIRST);`);

  // --- source_tags --------------------------------------------------------
  pgm.sql(`
    CREATE TABLE source_tags (
      source_id  integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      tag_id     integer NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
      PRIMARY KEY (source_id, tag_id)
    );
  `);

  pgm.sql(`CREATE INDEX source_tags_tag_idx ON source_tags (tag_id);`);

  // --- items --------------------------------------------------------------
  pgm.sql(`
    CREATE TABLE items (
      id            bigserial PRIMARY KEY,
      source_id     integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,

      -- Deduplication key. See 02-SPEC-ingestion.md 4.
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
  `);

  pgm.sql(`CREATE INDEX items_feed_idx    ON items (published_at DESC) WHERE read_at IS NULL;`);
  pgm.sql(`CREATE INDEX items_score_idx   ON items (score DESC, published_at DESC);`);
  pgm.sql(`CREATE INDEX items_source_idx  ON items (source_id, published_at DESC);`);
  pgm.sql(`CREATE INDEX items_starred_idx ON items (published_at DESC) WHERE starred = true;`);
  pgm.sql(`
    CREATE INDEX items_search_idx ON items
      USING gin (to_tsvector('simple', title || ' ' || coalesce(summary,'')));
  `);

  // --- rules --------------------------------------------------------------
  pgm.sql(`CREATE TYPE rule_scope AS ENUM ('title', 'summary', 'both', 'author');`);

  pgm.sql(`
    CREATE TABLE rules (
      id          serial PRIMARY KEY,
      name        text NOT NULL,
      pattern     text NOT NULL,        -- JS-flavoured regex source, no delimiters
      flags       text NOT NULL DEFAULT 'i',
      scope       rule_scope NOT NULL DEFAULT 'both',
      weight      numeric(4,2) NOT NULL DEFAULT 1.00,
      alert       boolean NOT NULL DEFAULT false,
      active      boolean NOT NULL DEFAULT true,
      -- When non-empty, the rule only applies to items from sources carrying
      -- one of these tags
      tag_filter  integer[] NOT NULL DEFAULT '{}',
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rules_flags_valid CHECK (flags ~ '^[imsu]*$')
    );
  `);

  // --- alerts -------------------------------------------------------------
  pgm.sql(`
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
  `);

  pgm.sql(`CREATE INDEX alerts_pending_idx ON alerts (created_at) WHERE delivered_at IS NULL;`);

  // --- dashboards and widgets --------------------------------------------
  pgm.sql(`
    CREATE TABLE dashboards (
      id         serial PRIMARY KEY,
      name       text NOT NULL,
      position   integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TYPE widget_type AS ENUM ('feed', 'custom_api', 'alerts', 'source_health', 'stats');
  `);

  pgm.sql(`
    CREATE TABLE widgets (
      id            serial PRIMARY KEY,
      dashboard_id  integer NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      type          widget_type NOT NULL,
      title         text NOT NULL,
      config        jsonb NOT NULL DEFAULT '{}',
      layout        jsonb NOT NULL DEFAULT '{}',
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX widgets_dashboard_idx ON widgets (dashboard_id);`);

  // --- settings (singleton) ----------------------------------------------
  pgm.sql(`
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
  `);

  // The singleton row must exist for the app to have anything to read.
  pgm.sql(`INSERT INTO settings (id) VALUES (true);`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Reverse dependency order. Tables first, then the enum types they used.
  pgm.sql(`DROP TABLE IF EXISTS settings;`);
  pgm.sql(`DROP TABLE IF EXISTS widgets;`);
  pgm.sql(`DROP TABLE IF EXISTS dashboards;`);
  pgm.sql(`DROP TABLE IF EXISTS alerts;`);
  pgm.sql(`DROP TABLE IF EXISTS rules;`);
  pgm.sql(`DROP TABLE IF EXISTS items;`);
  pgm.sql(`DROP TABLE IF EXISTS source_tags;`);
  pgm.sql(`DROP TABLE IF EXISTS sources;`);
  pgm.sql(`DROP TABLE IF EXISTS tags;`);

  pgm.sql(`DROP TYPE IF EXISTS widget_type;`);
  pgm.sql(`DROP TYPE IF EXISTS rule_scope;`);
  pgm.sql(`DROP TYPE IF EXISTS source_kind;`);
};
