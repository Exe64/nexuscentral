/**
 * Tag routes (03-SPEC-api.md 3).
 */

import { Router } from 'express';
import { z } from 'zod';
import { TAG_COLORS } from '@feedhub/shared';
import { createTag, deleteTag, listTags, updateTag } from '../../db/tags.js';
import { isSluggable } from '../../lib/slug.js';
import { HttpError } from '../errors.js';
import { intParam, parseBody, shortText } from '../validation.js';

export const tagsRouter: Router = Router();

const nameSchema = shortText(80).refine(isSluggable, {
  message: 'Name must contain at least one letter or digit',
});

const createSchema = z.object({
  name: nameSchema,
  color: z.enum(TAG_COLORS).default('neutral'),
});

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    color: z.enum(TAG_COLORS).optional(),
  })
  .refine((body) => body.name !== undefined || body.color !== undefined, {
    message: 'Provide at least one of name or color',
  });

tagsRouter.get('/tags', async (_req, res) => {
  res.json({ data: await listTags() });
});

tagsRouter.post('/tags', async (req, res) => {
  const body = parseBody(createSchema, req);
  res.status(201).json({ data: await createTag(body) });
});

tagsRouter.patch('/tags/:id', async (req, res) => {
  const id = intParam(req, 'id');
  const body = parseBody(patchSchema, req);

  const tag = await updateTag(id, body);
  if (tag === null) throw HttpError.notFound('Tag');

  res.json({ data: tag });
});

tagsRouter.delete('/tags/:id', async (req, res) => {
  const id = intParam(req, 'id');
  const result = await deleteTag(id);

  if (!result.deleted) throw HttpError.notFound('Tag');

  // The widget count lets the UI warn that a dashboard filter just changed.
  res.json({
    data: {
      affectedWidgets: result.affectedWidgets,
      affectedRules: result.affectedRules,
      affectedSources: result.affectedSources,
    },
  });
});
