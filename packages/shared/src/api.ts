/**
 * API transport envelopes (see 03-SPEC-api.md 1).
 *
 * One error shape everywhere; cursor pagination everywhere, never offsets.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  /** No session, or one that has expired. The client's cue to show the login page. */
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'UPSTREAM_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface Page<T> {
  data: T[];
  /** Opaque base64url cursor encoding `(sortValue, id)`. Null on the last page. */
  nextCursor: string | null;
}

/** Per-widget entry in the batched dashboard data response. */
export type WidgetPayload =
  { status: 'ok'; data: unknown } | { status: 'error'; error: ApiError['error'] };

export interface DashboardData {
  widgets: Record<string, WidgetPayload>;
  generatedAt: string;
}
