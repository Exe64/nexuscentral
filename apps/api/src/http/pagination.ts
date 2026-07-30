/**
 * Cursor pagination (03-SPEC-api.md 1).
 *
 * Lists are cursor-paginated, never offset-paginated: OFFSET 5000 makes
 * PostgreSQL walk 5000 rows to discard them, and a row inserted mid-scroll
 * shifts every subsequent page.
 *
 * The cursor encodes `(sortValue, id)` base64url. It is opaque to the client and
 * must be treated as untrusted input on the way back in.
 */

import { HttpError } from './errors.js';

export interface Cursor {
  /** The sort column's value for the last row of the previous page. */
  v: string | number;
  /** The tiebreaker, as a string because item ids are bigint. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw HttpError.validation('Malformed cursor');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) ||
    !('id' in parsed) ||
    typeof (parsed as Cursor).id !== 'string'
  ) {
    throw HttpError.validation('Malformed cursor');
  }

  const cursor = parsed as Cursor;
  if (typeof cursor.v !== 'string' && typeof cursor.v !== 'number') {
    throw HttpError.validation('Malformed cursor');
  }
  // The id lands in a bigint comparison; reject anything that is not digits
  // rather than letting PostgreSQL raise a type error.
  if (!/^\d+$/.test(cursor.id)) {
    throw HttpError.validation('Malformed cursor');
  }

  return cursor;
}

/**
 * Build a page from `limit + 1` fetched rows: the extra row is what proves there
 * is a next page, without a second COUNT query.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => Cursor,
): { data: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { data: rows, nextCursor: null };

  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    nextCursor: last === undefined ? null : encodeCursor(toCursor(last)),
  };
}
