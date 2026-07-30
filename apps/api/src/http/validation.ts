/**
 * Request validation helpers.
 *
 * Every body and query parameter is validated with `zod`. A failure returns 400
 * with field-level detail and never a stack trace (03-SPEC-api.md 1) -- the
 * error middleware turns a thrown ZodError into exactly that.
 */

import type { Request } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { HttpError } from './errors.js';

/**
 * Inferring from the schema itself rather than from a `ZodType<T>` parameter:
 * with the latter, TypeScript can resolve `T` against either the input or the
 * output type, and a schema using `.default()` silently resolves to the input
 * side, making required fields look optional.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.body) as z.infer<S>;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.query) as z.infer<S>;
}

/** Express types a repeated path parameter as an array; take the first value. */
function rawParam(req: Request, name: string): string | undefined {
  const raw: unknown = req.params[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

/** A positive integer path parameter, e.g. `/api/sources/:id`. */
export function intParam(req: Request, name: string): number {
  const value = Number(rawParam(req, name));
  if (!Number.isInteger(value) || value <= 0) {
    throw HttpError.validation(`Invalid ${name}: expected a positive integer`);
  }
  return value;
}

/** A bigint path parameter, kept as a string so it survives the round trip. */
export function bigintParam(req: Request, name: string): string {
  const raw = rawParam(req, name);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw HttpError.validation(`Invalid ${name}: expected a positive integer`);
  }
  return raw;
}

/**
 * A repeatable, comma-separated list of integers.
 *
 * Accepts `?tagIds=1,2`, `?tagIds=1&tagIds=2` and any mix, because both forms
 * turn up in hand-written requests and in what the browser produces.
 */
export const intList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value, ctx): number[] | undefined => {
    if (value === undefined) return undefined;

    const parts = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
      entry
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    );

    const numbers: number[] = [];
    for (const part of parts) {
      const parsed = Number(part);
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${part}" is not an integer` });
        return z.NEVER;
      }
      numbers.push(parsed);
    }

    return numbers.length > 0 ? numbers : undefined;
  });

/** `?unreadOnly=true`. Query strings have no booleans, only the word. */
export const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true' || value === '1'));

export const queryNumber = z
  .string()
  .optional()
  .transform((value, ctx): number | undefined => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" is not a number` });
      return z.NEVER;
    }
    return parsed;
  });

export const queryDate = z
  .string()
  .optional()
  .transform((value, ctx): Date | undefined => {
    if (value === undefined || value === '') return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" is not an ISO 8601 date` });
      return z.NEVER;
    }
    return parsed;
  });

/** Trimmed, non-empty, length-bounded free text. */
export const shortText = (max = 200): z.ZodString =>
  z.string().trim().min(1, 'Must not be empty').max(max, `Must be at most ${max} characters`);

/** An absolute http(s) URL. Anything else is rejected at the boundary. */
export const absoluteUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Must be an absolute http or https URL' },
  );
