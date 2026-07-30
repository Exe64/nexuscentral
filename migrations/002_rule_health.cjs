/**
 * 002_rule_health
 *
 * The ingestion spec requires that a rule whose pattern exceeds its time budget
 * be deactivated with `last_error` set and surfaced in the UI
 * (02-SPEC-ingestion.md 5.3). The data model spec's `rules` table has no such
 * column, so this adds it rather than dropping the behaviour.
 *
 * Also adds an index supporting the rescoring jobs, which select recent items by
 * `published_at` and update them in batches.
 */

/* eslint-disable */
'use strict';

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rules
      ADD COLUMN last_error    text,
      ADD COLUMN last_error_at timestamptz;
  `);

  // `rescore:all` walks the last 30 days and `score:refresh` the last 7, both
  // oldest-first in batches. Without this they seq-scan the whole table.
  pgm.sql(`CREATE INDEX items_rescore_idx ON items (published_at DESC, id DESC);`);

  // `score:refresh` skips items it has already recomputed within the hour.
  pgm.sql(`CREATE INDEX items_scored_at_idx ON items (scored_at NULLS FIRST);`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS items_scored_at_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS items_rescore_idx;`);
  pgm.sql(`ALTER TABLE rules DROP COLUMN IF EXISTS last_error_at;`);
  pgm.sql(`ALTER TABLE rules DROP COLUMN IF EXISTS last_error;`);
};
