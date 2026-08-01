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

/**
 * Whether the deployed build is the newest commit on the repository's main
 * branch.
 *
 * `unknown` is its own state rather than an error: a dev run has no build sha to
 * compare, and GitHub being unreachable is not the same claim as "up to date".
 * Reporting either as up to date would be the one wrong answer.
 */
export const UPDATE_STATES = ['up_to_date', 'update_available', 'unknown', 'disabled'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export interface UpdateStatus {
  state: UpdateState;
  /** The deployed commit, as passed at boot. Short or full. Null in a dev run. */
  current: string | null;
  /** Head of the default branch, abbreviated to seven for display. */
  latest: string | null;
  /** First line of the latest commit message. */
  latestSubject: string | null;
  latestAt: string | null;
  /** A github.com compare page -- a link for a human, not another API call. */
  compareUrl: string | null;
  /** When the answer was fetched, not when it was served from cache. */
  checkedAt: string;
  /** Why the state is `unknown`, for the UI to show instead of a bare shrug. */
  reason: string | null;
}
