/**
 * `POST /api/custom-api/preview` (03-SPEC-api.md 7).
 *
 * Test a fetch spec before saving it. This is where a bad URL, a missing
 * environment variable or a JSONPath that selects nothing gets reported -- at
 * save time, in front of someone who can fix it, rather than as an error inside a
 * widget three days later.
 *
 * It runs the same code the widget resolver runs. A preview that took a different
 * path would be a preview of something else.
 */

import { Router } from 'express';
import { z } from 'zod';
import { CUSTOM_API_RENDERS } from '@nexuscentral/shared';
import { CustomApiError, fetchSpec, referencedVariables } from '../../customapi/fetch.js';
import { applyMapping, MappingError, MAX_ITEMS, selectRoot } from '../../customapi/mapping.js';
import { BlockedTargetError } from '../../customapi/ssrf.js';
import { HttpError } from '../errors.js';
import { parseBody } from '../validation.js';

export const customApiRouter: Router = Router();

const stringMap = z.record(z.string().max(500)).default({});

const previewSchema = z.object({
  url: z.string().min(1).max(2000),
  params: stringMap,
  headers: stringMap,
  mapping: z
    .object({
      root: z.string().max(500).default('$'),
      fields: z.record(z.string().max(500)).default({}),
    })
    .default({ root: '$', fields: {} }),
  render: z.enum(CUSTOM_API_RENDERS).default('list'),
});

/** Turn the module's error types into the API envelope, with the reason intact. */
function toHttpError(err: unknown): HttpError {
  if (err instanceof BlockedTargetError) return HttpError.validation(err.message);
  if (err instanceof MappingError) return HttpError.validation(err.message);

  if (err instanceof CustomApiError) {
    // A placeholder or a mapping problem is the user's config; a timeout or a 502
    // is the target's fault and reads differently in the UI.
    return err.kind === 'placeholder'
      ? HttpError.validation(err.message)
      : HttpError.upstream(err.message);
  }

  return HttpError.upstream(err instanceof Error ? err.message : String(err));
}

customApiRouter.post('/custom-api/preview', async (req, res) => {
  const body = parseBody(previewSchema, req);

  // Reported whether or not the fetch works: the user needs to know which
  // variables the server must have before this widget can be saved.
  const variables = referencedVariables(body);

  try {
    const response = await fetchSpec(body);
    const mapped = applyMapping(response.body, body.mapping);

    // Only when nothing mapped: with items in hand the sample is noise, but with
    // none it is the only way to see what the root should have been.
    const rootSample =
      mapped.items.length === 0
        ? selectRoot(response.body, body.mapping.root).slice(0, 2)
        : undefined;

    res.json({
      data: {
        ok: true,
        status: response.status,
        finalUrl: response.finalUrl,
        bytes: response.bytes,
        durationMs: response.durationMs,
        variables,
        items: mapped.items.slice(0, 10),
        matched: mapped.matched,
        droppedWithoutTitle: mapped.dropped,
        cappedAt: mapped.matched > MAX_ITEMS ? MAX_ITEMS : null,
        ...(rootSample === undefined ? {} : { rootSample }),
      },
    });
  } catch (err) {
    throw toHttpError(err);
  }
});
