/**
 * Source routes (03-SPEC-api.md 2).
 */

import { Router } from 'express';
import { z } from 'zod';
import { SOURCE_KINDS, type ResolvedSource, type SourceKind } from '@nexuscentral/shared';
import { detectKind, resolveInput } from '../../adapters/registry.js';
import {
  createSource,
  deleteSource,
  findSourceByIdentity,
  getSource,
  listSources,
  listUnhealthySources,
  updateSource,
} from '../../db/sources.js';
import { assertTagsExist } from '../../db/tags.js';
import { getRawSettings, isRedditConfigured, resolveNitterBaseUrls } from '../../db/settings.js';
import { buildOpml, parseOpml } from '../../opml/index.js';
import { importOpml } from '../../ingest/import.js';
import { parsePollInterval } from '../../lib/interval.js';
import { enqueuePoll } from '../../worker/index.js';
import { HttpError } from '../errors.js';
import { intParam, parseBody, parseQuery, queryBoolean, shortText } from '../validation.js';

export const sourcesRouter: Router = Router();

/** The UI must not hang on a slow upstream (03-SPEC-api.md 2). */
const RESOLVE_TIMEOUT_MS = 15_000;

const listQuerySchema = z.object({
  kind: z.enum(SOURCE_KINDS).optional(),
  tag: z.coerce.number().int().positive().optional(),
  active: queryBoolean,
  q: z.string().optional(),
  /**
   * `unhealthy` selects what the source_health widget shows: anything failing or
   * silently empty, worst first.
   */
  health: z.enum(['unhealthy']).optional(),
});

const createSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  identifier: shortText(2000),
  title: shortText(300),
  siteUrl: z.string().trim().max(2000).nullish(),
  iconUrl: z.string().trim().max(2000).nullish(),
  tagIds: z.array(z.number().int().positive()).max(50).default([]),
  weight: z.number().min(0).max(10).default(1),
  pollInterval: z.string().default('15 minutes'),
  active: z.boolean().optional(),
});

const patchSchema = z.object({
  title: shortText(300).optional(),
  siteUrl: z.string().trim().max(2000).nullish(),
  iconUrl: z.string().trim().max(2000).nullish(),
  tagIds: z.array(z.number().int().positive()).max(50).optional(),
  weight: z.number().min(0).max(10).optional(),
  pollInterval: z.string().optional(),
  active: z.boolean().optional(),
});

const resolveSchema = z.object({
  input: shortText(2000),
});

const importSchema = z.object({
  opml: z
    .string()
    .min(1)
    .max(5 * 1024 * 1024),
  /** Tags applied to every imported source, on top of its OPML folders. */
  tagIds: z.array(z.number().int().positive()).max(50).default([]),
  /** Create tags for OPML folder names. On by default: folders are the tags. */
  importCategoriesAsTags: z.boolean().default(true),
});

sourcesRouter.get('/sources', async (req, res) => {
  const query = parseQuery(listQuerySchema, req);

  const data =
    query.health === 'unhealthy'
      ? await listUnhealthySources()
      : await listSources({
          kind: query.kind,
          tagId: query.tag,
          active: query.active,
          q: query.q,
        });

  res.json({ data });
});

/**
 * `POST /api/sources/resolve` -- one free-text input, the server works out the
 * rest. Registered before `/sources/:id` so the literal path wins.
 */
sourcesRouter.post('/sources/resolve', async (req, res) => {
  const { input } = parseBody(resolveSchema, req);

  let candidates: ResolvedSource[];
  try {
    candidates = await withTimeout(resolveInput(input), RESOLVE_TIMEOUT_MS, input);
  } catch (err) {
    // A validation problem (an unsupported kind, an empty input) is the caller's;
    // anything else is the upstream failing and must not read as a 500.
    if (err instanceof HttpError) throw err;
    throw HttpError.upstream(err instanceof Error ? err.message : 'Could not resolve that input', {
      input,
    });
  }

  if (candidates.length === 0) {
    throw HttpError.upstream('No feed found at that address', {
      input,
      detectedKind: detectKind(input).kind,
    });
  }

  // Flag the ones already tracked so the UI can offer to open them instead.
  const annotated = await Promise.all(
    candidates.map(async (candidate) => {
      const existing = await findSourceByIdentity(candidate.kind, candidate.identifier);
      return {
        ...candidate,
        sampleItems: candidate.sampleItems.map((item) => ({
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt.toISOString(),
          ...(item.summary === undefined ? {} : { summary: item.summary }),
        })),
        existingSourceId: existing?.id ?? null,
      };
    }),
  );

  res.json({ candidates: annotated });
});

sourcesRouter.get('/sources/export', async (_req, res) => {
  const sources = await listSources();

  // Only RSS sources have a feed URL to put in an xmlUrl attribute. Reddit and
  // Nitter sources are identified by a subreddit or a handle and have no OPML
  // representation, so they are reported rather than silently dropped.
  const exportable = sources.filter((source) => source.kind === 'rss');

  const opml = buildOpml(
    exportable.map((source) => ({
      title: source.title,
      xmlUrl: source.identifier,
      htmlUrl: source.siteUrl,
      categories: source.tags.map((tag) => tag.name),
    })),
  );

  res.setHeader('Content-Type', 'text/x-opml+xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="nexuscentral-sources.opml"');
  res.setHeader('X-Nexuscentral-Skipped-Sources', String(sources.length - exportable.length));
  res.send(opml);
});

sourcesRouter.post('/sources/import', async (req, res) => {
  // Accept either a raw OPML upload or a JSON envelope, because a file input and
  // a fetch() call naturally produce different content types.
  const body =
    typeof req.body === 'string'
      ? { opml: req.body, tagIds: [] as number[], importCategoriesAsTags: true }
      : parseBody(importSchema, req);

  await assertTagsExist(body.tagIds);

  const document = parseOpml(body.opml);
  if (document.feeds.length === 0) {
    throw HttpError.validation('No feeds found in that OPML document', {
      skippedOutlines: document.skipped,
    });
  }

  const result = await importOpml(document, {
    tagIds: body.tagIds,
    importCategoriesAsTags: body.importCategoriesAsTags,
  });

  res.status(201).json({ data: result });
});

sourcesRouter.post('/sources', async (req, res) => {
  const body = parseBody(createSchema, req);
  await assertTagsExist(body.tagIds);

  const pollIntervalSeconds = parsePollInterval(body.pollInterval);
  const identifier = normalizeIdentifier(body.kind, body.identifier);

  // A source of a kind that cannot be polled yet is still worth creating -- the
  // user found it now and would not come back to add it later. It is created
  // inactive with the reason recorded, so the UI can explain itself instead of
  // showing a healthy source that silently produces nothing.
  const blockedReason = await unpollableReason(body.kind);

  const source = await createSource({
    kind: body.kind,
    identifier,
    title: body.title,
    siteUrl: body.siteUrl ?? null,
    iconUrl: body.iconUrl ?? null,
    weight: body.weight,
    active: blockedReason === null ? (body.active ?? true) : false,
    pollIntervalSeconds,
    tagIds: body.tagIds,
    ...(blockedReason === null ? {} : { lastError: blockedReason }),
  });

  // Fetch straight away rather than waiting up to a full interval: a source that
  // shows nothing for 15 minutes reads as broken.
  if (source.active) await enqueuePoll(source.id, { immediate: true });

  res.status(201).json({ data: source });
});

/**
 * Why this kind of source cannot be polled right now, or null when it can.
 *
 * Reddit needs OAuth credentials; app registration is not self-service and takes
 * weeks. Nitter needs at least one instance. Both are configuration, not failure.
 */
async function unpollableReason(kind: SourceKind): Promise<string | null> {
  if (kind === 'reddit') {
    return (await isRedditConfigured())
      ? null
      : 'Reddit credentials are not configured. Add a client id and secret in Settings, then activate this source.';
  }
  if (kind === 'nitter') {
    const { urls } = resolveNitterBaseUrls(await getRawSettings());
    return urls.length > 0
      ? null
      : 'No Nitter instance is configured. Add one in Settings, then activate this source.';
  }
  return null;
}

sourcesRouter.get('/sources/:id', async (req, res) => {
  const source = await getSource(intParam(req, 'id'));
  if (source === null) throw HttpError.notFound('Source');
  res.json({ data: source });
});

sourcesRouter.patch('/sources/:id', async (req, res) => {
  const id = intParam(req, 'id');
  const body = parseBody(patchSchema, req);

  if (body.tagIds !== undefined) await assertTagsExist(body.tagIds);

  const source = await updateSource(id, {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.siteUrl === undefined ? {} : { siteUrl: body.siteUrl }),
    ...(body.iconUrl === undefined ? {} : { iconUrl: body.iconUrl }),
    ...(body.weight === undefined ? {} : { weight: body.weight }),
    ...(body.active === undefined ? {} : { active: body.active }),
    ...(body.tagIds === undefined ? {} : { tagIds: body.tagIds }),
    ...(body.pollInterval === undefined
      ? {}
      : { pollIntervalSeconds: parsePollInterval(body.pollInterval) }),
  });

  if (source === null) throw HttpError.notFound('Source');
  res.json({ data: source });
});

sourcesRouter.delete('/sources/:id', async (req, res) => {
  const deleted = await deleteSource(intParam(req, 'id'));
  if (!deleted) throw HttpError.notFound('Source');
  // Items and their alerts cascade: removing a source removes its history.
  res.status(204).end();
});

sourcesRouter.post('/sources/:id/poll', async (req, res) => {
  const id = intParam(req, 'id');
  const source = await getSource(id);
  if (source === null) throw HttpError.notFound('Source');

  const jobId = await enqueuePoll(id, { immediate: true });
  if (jobId === null) {
    // Either the worker is not running in this process, or a poll for this source
    // is already queued. Both mean "nothing new was scheduled".
    res.status(202).json({ data: { queued: false, sourceId: id } });
    return;
  }

  res.status(202).json({ data: { queued: true, sourceId: id, jobId } });
});

/** Canonical identifier per kind (01-SPEC-data-model.md 1.2). */
function normalizeIdentifier(kind: SourceKind, identifier: string): string {
  if (kind === 'reddit') return identifier.replace(/^\/?r\//i, '').toLowerCase();
  if (kind === 'nitter') return identifier.replace(/^@/, '').toLowerCase();
  return identifier;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, input: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(HttpError.upstream(`Resolving "${input}" timed out after ${ms}ms`, { input })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
