/**
 * Dates and numbers go through `Intl`, never string concatenation
 * (04-SPEC-frontend.md 6).
 */

import { dateTimeFormat, numberFormat, relativeTimeFormat } from '../i18n.tsx';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago". Falls back to "now" under a minute rather than "0 seconds ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const deltaSeconds = (then - now) / 1000;
  const magnitude = Math.abs(deltaSeconds);

  for (const [unit, size] of UNITS) {
    if (magnitude >= size) {
      return relativeTimeFormat.format(Math.round(deltaSeconds / size), unit);
    }
  }
  return relativeTimeFormat.format(0, 'minute');
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormat.format(date);
}

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}
