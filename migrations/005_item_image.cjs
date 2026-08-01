/**
 * 005_item_image
 *
 * Preview images on items.
 *
 * `image_url` is the thumbnail to render. `image_checked_at` records that the
 * og:image fallback has *run*, which is not the same thing as it having found
 * something: most items that end up without an image are items whose article
 * genuinely has no og:image, and without this column the enrichment job would
 * re-fetch every one of them on every pass, forever.
 *
 * Both are nullable and neither is on the read path of any existing query, so
 * this is additive for a database already full of items: they simply have no
 * thumbnail until something re-polls or the backfill runs.
 */

/* eslint-disable */
'use strict';

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE items
      ADD COLUMN image_url       text,
      ADD COLUMN image_checked_at timestamptz;
  `);

  // The enrichment job's only query: items still worth trying, newest first.
  // Partial, because the rows it must never return -- those already carrying an
  // image, and those already tried -- are the overwhelming majority once the
  // backlog has been worked through, and there is no point indexing them.
  pgm.sql(`
    CREATE INDEX items_image_pending_idx
      ON items (published_at DESC)
      WHERE image_url IS NULL AND image_checked_at IS NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS items_image_pending_idx;`);
  pgm.sql(`ALTER TABLE items DROP COLUMN IF EXISTS image_checked_at;`);
  pgm.sql(`ALTER TABLE items DROP COLUMN IF EXISTS image_url;`);
};
