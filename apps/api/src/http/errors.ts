/**
 * One error shape for the whole API (see 03-SPEC-api.md 1).
 *
 *   { "error": { "code": "VALIDATION_FAILED", "message": "...", "details": {...} } }
 *
 * A validation failure returns field-level detail; nothing ever returns a stack
 * trace.
 */

import type { ErrorCode } from '@nexuscentral/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';
import { logger } from '../logger.js';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPSTREAM_FAILED: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static validation(message: string, details?: unknown): HttpError {
    return new HttpError('VALIDATION_FAILED', message, details);
  }

  static unauthorized(message = 'Authentication required.'): HttpError {
    return new HttpError('UNAUTHORIZED', message);
  }

  static notFound(what: string): HttpError {
    return new HttpError('NOT_FOUND', `${what} not found`);
  }

  static conflict(message: string, details?: unknown): HttpError {
    return new HttpError('CONFLICT', message, details);
  }

  static upstream(message: string, details?: unknown): HttpError {
    return new HttpError('UPSTREAM_FAILED', message, details);
  }

  static rateLimited(message: string, details?: unknown): HttpError {
    return new HttpError('RATE_LIMITED', message, details);
  }
}

/** Flatten a ZodError into `{ field: [messages] }`. */
function zodDetails(err: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '(root)';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(HttpError.notFound(`${req.method} ${req.path}`));
}

/**
 * Terminal error middleware. Express 5 forwards rejected async handlers here,
 * so route code can throw freely.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    const details = zodDetails(err);

    // Logged, unlike other 4xx. This API has exactly one client, so a body it
    // rejects means that client sent something wrong -- our bug, not a stranger's
    // bad request. It went unlogged, and the response said only "Request
    // validation failed", so a rejected layout save was invisible from the
    // server and from the browser at the same time.
    logger.warn({ method: req.method, path: req.path, details }, 'Request validation failed');

    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details,
      },
    });
    return;
  }

  if (err instanceof HttpError) {
    // 5xx is our fault and worth a log line; 4xx is the caller's and is not.
    if (err.status >= 500) logger.error({ err }, err.message);
    else logger.debug({ err: { code: err.code, message: err.message } }, err.message);

    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProduction ? 'Internal error' : err instanceof Error ? err.message : String(err),
    },
  });
}
