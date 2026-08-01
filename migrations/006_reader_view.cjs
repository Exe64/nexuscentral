/**
 * 006_reader_view
 *
 * How the reader lays items out.
 *
 * In `settings` rather than in the browser, for the same reason `theme_preset`
 * is: it is a durable preference, not view state, and putting it here means it
 * survives a reload and follows the user to another device. The spec's rule --
 * configuration lives in PostgreSQL and is managed through the UI -- covers this.
 *
 * `list` is the default because it is what the reader already did; nobody's view
 * changes underneath them when this migration runs.
 */

/* eslint-disable */
'use strict';

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings
      ADD COLUMN reader_view text NOT NULL DEFAULT 'list';
  `);

  pgm.sql(`
    ALTER TABLE settings
      ADD CONSTRAINT settings_reader_view_valid CHECK (
        reader_view IN ('list', 'cards', 'titles')
      );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_reader_view_valid;`);
  pgm.sql(`ALTER TABLE settings DROP COLUMN IF EXISTS reader_view;`);
};
