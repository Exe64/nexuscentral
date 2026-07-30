/**
 * 003_theme_preset
 *
 * Named themes alongside the derived accent ramp.
 *
 * `theme_mode` (light/dark/system) and `theme_preset` are orthogonal: every preset
 * defines both a light and a dark variant, so switching mode never strands the
 * user on a palette that does not exist.
 *
 * `default` is the accent-derived theme from Phase 4 and stays the default.
 */

/* eslint-disable */
'use strict';

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings
      ADD COLUMN theme_preset text NOT NULL DEFAULT 'default';
  `);

  pgm.sql(`
    ALTER TABLE settings
      ADD CONSTRAINT settings_preset_valid CHECK (
        theme_preset IN ('default', 'solarized', 'terminal', 'vt220', 'powershell')
      );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_preset_valid;`);
  pgm.sql(`ALTER TABLE settings DROP COLUMN IF EXISTS theme_preset;`);
};
