/**
 * Settings routes (03-SPEC-api.md 8).
 *
 * Secrets go in and are never returned. `GET` answers with a `configured` flag
 * and where the value in effect came from.
 */

import { Router } from 'express';
import { z } from 'zod';
import { READER_VIEWS, THEME_MODES, THEME_PRESETS, WEBHOOK_KINDS } from '@nexuscentral/shared';
import {
  getRawSettings,
  resolveNitterBaseUrls,
  resolveRedditCredentials,
  toPublicSettings,
  updateSettings,
} from '../../db/settings.js';
import { redditBudget } from '../../adapters/reddit/budget.js';
import { RedditTokenCache, redditTokenCache, RedditAuthError } from '../../adapters/reddit/auth.js';
import { redditGet, RedditApiError } from '../../adapters/reddit/client.js';
import { probeNitterInstance } from '../../adapters/nitter/probe.js';
import { sendTestNotification } from '../../alerts/deliver.js';
import { HttpError } from '../errors.js';
import { absoluteUrl, parseBody } from '../validation.js';

export const settingsRouter: Router = Router();

/**
 * An empty string clears a secret; `undefined` (absent) leaves it alone. Without
 * that distinction there would be no way to un-set a credential through the API.
 */
const nullableSecret = z
  .string()
  .max(200)
  .transform((value) => (value.trim() === '' ? null : value.trim()))
  .nullable()
  .optional();

const patchSchema = z
  .object({
    themeMode: z.enum(THEME_MODES).optional(),
    themePreset: z.enum(THEME_PRESETS).optional(),
    readerView: z.enum(READER_VIEWS).optional(),
    accentHue: z.number().int().min(0).max(360).optional(),
    accentChroma: z.number().min(0).max(0.37).optional(),
    itemsRetentionDays: z.number().int().min(1).max(3650).optional(),
    alertWebhookUrl: absoluteUrl.nullable().optional(),
    alertWebhookKind: z.enum(WEBHOOK_KINDS).optional(),
    redditClientId: nullableSecret,
    redditClientSecret: nullableSecret,
    nitterBaseUrls: z.array(absoluteUrl).max(10).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one setting' });

settingsRouter.get('/settings', async (_req, res) => {
  res.json({ data: toPublicSettings(await getRawSettings()) });
});

settingsRouter.patch('/settings', async (req, res) => {
  const body = parseBody(patchSchema, req);

  // A webhook target without a kind would never fire, and a kind without a target
  // is the same mistake from the other side.
  if (body.alertWebhookKind !== undefined && body.alertWebhookKind !== 'none') {
    const current = await getRawSettings();
    const url = body.alertWebhookUrl ?? current.alertWebhookUrl;
    if (url === null || url === '') {
      throw HttpError.validation(
        `A webhook URL is required for the "${body.alertWebhookKind}" delivery target.`,
        { alertWebhookUrl: ['Required when a delivery target is selected'] },
      );
    }
  }

  const updated = await updateSettings(body);

  // Credentials may have changed; a token minted for the old client id is no
  // longer valid for the new one.
  if (body.redditClientId !== undefined || body.redditClientSecret !== undefined) {
    redditTokenCache.invalidate();
  }

  res.json({ data: toPublicSettings(updated) });
});

/**
 * `POST /api/settings/test-reddit` -- verify the OAuth credentials.
 *
 * Uses a throwaway token cache so a successful test does not populate the shared
 * one with a token the poller might otherwise rely on, and a failing test does not
 * evict a token that still works.
 */
settingsRouter.post('/settings/test-reddit', async (_req, res) => {
  const settings = await getRawSettings();
  const credentials = resolveRedditCredentials(settings);

  if (credentials === null) {
    res.status(200).json({
      data: {
        ok: false,
        reason: 'not_configured',
        message:
          'No Reddit client id and secret are configured. Add them here, or set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.',
      },
    });
    return;
  }

  const tokens = new RedditTokenCache();

  try {
    // `/api/v1/me` is the cheapest authenticated call and needs no subreddit.
    await redditGet<unknown>('/api/v1/me?raw_json=1', { credentials, tokens });
  } catch (err) {
    if (err instanceof RedditAuthError || err instanceof RedditApiError) {
      // A failed test is a successful answer to "are these credentials good?", so
      // it is 200 with ok:false rather than an error envelope.
      res.status(200).json({
        data: {
          ok: false,
          reason: err.status === 401 ? 'rejected' : 'upstream',
          message: err.message,
          origin: credentials.origin,
        },
      });
      return;
    }
    throw err;
  }

  res.json({
    data: {
      ok: true,
      origin: credentials.origin,
      userAgent: credentials.userAgent,
      budget: redditBudget.snapshot(),
    },
  });
});

/**
 * `POST /api/settings/test-nitter` -- check each configured instance.
 *
 * Every instance is reported, not just the first that works: the list is ordered
 * and the user needs to know which entries are dead weight.
 */
settingsRouter.post('/settings/test-nitter', async (_req, res) => {
  const { urls, origin } = resolveNitterBaseUrls(await getRawSettings());

  if (urls.length === 0) {
    res.json({
      data: {
        ok: false,
        reason: 'not_configured',
        message: 'No Nitter instances are configured. X support needs a self-hosted instance.',
        instances: [],
      },
    });
    return;
  }

  const instances = await Promise.all(urls.map((baseUrl) => probeNitterInstance(baseUrl)));

  res.json({
    data: {
      ok: instances.some((instance) => instance.ok),
      origin,
      instances,
    },
  });
});

/**
 * `POST /api/settings/test-webhook` -- send a real notification, now.
 *
 * One attempt rather than the delivery job's three: the user is watching, and
 * waiting thirty-one seconds to be told the URL is wrong is worse than being told
 * straight away. Nothing is written to the `alerts` table.
 */
settingsRouter.post('/settings/test-webhook', async (_req, res) => {
  const settings = await getRawSettings();

  if (settings.alertWebhookKind === 'none' || settings.alertWebhookUrl === null) {
    res.json({
      data: {
        ok: false,
        reason: 'not_configured',
        message: 'No delivery target is configured. Alerts stay in the dashboard only.',
      },
    });
    return;
  }

  const result = await sendTestNotification();
  res.json({
    data: {
      ok: result.ok,
      kind: settings.alertWebhookKind,
      ...(result.error === undefined ? {} : { message: result.error }),
    },
  });
});
