/**
 * `sources.poll_interval` is a PostgreSQL `interval`. The API talks in strings
 * like `15 minutes` (03-SPEC-api.md 2), and `pg` renders an interval as an
 * object, so the two need a defined round trip.
 */

import { HttpError } from '../http/errors.js';

/**
 * Polling faster than this is rude to the upstream and pointless for a feed that
 * publishes a few times a day. The ceiling exists so a typo cannot park a source
 * for a year.
 */
export const MIN_POLL_SECONDS = 5 * 60;
export const MAX_POLL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_POLL_SECONDS = 15 * 60;

const UNIT_SECONDS: Record<string, number> = {
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
  hour: 3600,
  hours: 3600,
  hr: 3600,
  hrs: 3600,
  day: 86_400,
  days: 86_400,
};

const PATTERN = /^\s*(\d+)\s*([a-z]+)\s*$/i;

/**
 * Parse `"15 minutes"` into seconds. Throws a validation error rather than
 * silently defaulting: a source polled on the wrong schedule is a bug the user
 * would not notice for hours.
 */
export function parsePollInterval(input: string): number {
  const match = PATTERN.exec(input);
  const unit = match?.[2]?.toLowerCase();
  const amount = match === null ? NaN : Number.parseInt(match[1] ?? '', 10);

  if (unit === undefined || !Number.isFinite(amount)) {
    throw HttpError.validation(
      `Invalid poll interval "${input}". Use a form like "15 minutes", "2 hours" or "1 day".`,
    );
  }

  const unitSeconds = UNIT_SECONDS[unit];
  if (unitSeconds === undefined) {
    throw HttpError.validation(`Unknown poll interval unit "${unit}". Use minutes, hours or days.`);
  }

  const seconds = amount * unitSeconds;
  if (seconds < MIN_POLL_SECONDS) {
    throw HttpError.validation(
      `Poll interval must be at least ${MIN_POLL_SECONDS / 60} minutes; polling faster is rude to the source.`,
    );
  }
  if (seconds > MAX_POLL_SECONDS) {
    throw HttpError.validation(`Poll interval must be at most ${MAX_POLL_SECONDS / 86_400} days.`);
  }

  return seconds;
}

/**
 * Render seconds back to the shortest exact human form, so a value the user typed
 * comes back the way they typed it: 900 -> `15 minutes`, 7200 -> `2 hours`.
 */
export function formatPollInterval(seconds: number): string {
  const units: [number, string][] = [
    [86_400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];

  for (const [size, name] of units) {
    if (seconds % size === 0 && seconds >= size) {
      const amount = seconds / size;
      return `${amount} ${name}${amount === 1 ? '' : 's'}`;
    }
  }

  return `${seconds} seconds`;
}
