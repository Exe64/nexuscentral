/**
 * Thin fetch wrapper for the API.
 *
 * Every error the API produces has the same envelope (03-SPEC-api.md 1), so
 * unwrapping it belongs here rather than in every caller.
 */

import type { ApiError, ErrorCode } from '@nexuscentral/shared';

export class ApiRequestError extends Error {
  readonly code: ErrorCode | 'NETWORK';
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode | 'NETWORK', message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isApiError(body: unknown): body is ApiError {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as ApiError).error?.code === 'string'
  );
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Called whenever the API answers 401.
 *
 * A session can expire under any request, not just the one the user is watching,
 * so the reaction lives here rather than in each caller. `App` registers a
 * handler that flips the whole shell back to the login screen.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...rest,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new ApiRequestError('NETWORK', err instanceof Error ? err.message : String(err), 0);
  }

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    if (isApiError(parsed)) {
      // Notify before throwing: the caller's own error handling should run
      // against a shell that already knows the session is gone. The login
      // endpoint's own 401 ("Incorrect password") is not a lost session, so it
      // does not count.
      if (response.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();

      throw new ApiRequestError(
        parsed.error.code,
        parsed.error.message,
        response.status,
        parsed.error.details,
      );
    }
    // A non-enveloped failure means something upstream of the API answered --
    // the reverse proxy, most likely. Report the status, not a guess.
    throw new ApiRequestError('INTERNAL', `HTTP ${response.status}`, response.status, parsed);
  }

  return parsed as T;
}
