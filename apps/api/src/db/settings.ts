/**
 * The settings singleton (01-SPEC-data-model.md 1.8).
 *
 * Two different precedence rules apply here, and the difference is deliberate:
 *
 * - **Secrets** (`reddit_client_secret`): the environment wins. A deployment that
 *   passes credentials through the container environment must not be silently
 *   overridden by whatever is left in the database.
 * - **Everything else** (`nitter_base_urls`): the database wins when set, with the
 *   environment as the first-boot default. Configuration is meant to happen
 *   through the UI (00-CONTEXT.md 2); if the environment always won, the form
 *   would accept edits that do nothing.
 */

import type { SettingOrigin, Settings, ThemeMode, ThemePreset, WebhookKind } from '@feedhub/shared';
import { query } from './pool.js';
import { env } from '../config/env.js';

interface SettingsRow {
  theme_mode: string;
  theme_preset: string;
  accent_hue: number;
  accent_chroma: number;
  items_retention_days: number;
  alert_webhook_url: string | null;
  alert_webhook_kind: string;
  reddit_client_id: string | null;
  reddit_client_secret: string | null;
  nitter_base_urls: string[];
  updated_at: Date;
}

const COLUMNS = `
  theme_mode, theme_preset, accent_hue, accent_chroma, items_retention_days,
  alert_webhook_url, alert_webhook_kind,
  reddit_client_id, reddit_client_secret, nitter_base_urls, updated_at
`;

/** Everything in the row, secrets included. Never hand this to a response. */
export interface RawSettings {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  accentHue: number;
  accentChroma: number;
  itemsRetentionDays: number;
  alertWebhookUrl: string | null;
  alertWebhookKind: WebhookKind;
  redditClientId: string | null;
  redditClientSecret: string | null;
  nitterBaseUrls: string[];
  updatedAt: Date;
}

function toRaw(row: SettingsRow): RawSettings {
  return {
    themeMode: row.theme_mode as ThemeMode,
    themePreset: row.theme_preset as ThemePreset,
    accentHue: row.accent_hue,
    accentChroma: row.accent_chroma,
    itemsRetentionDays: row.items_retention_days,
    alertWebhookUrl: row.alert_webhook_url,
    alertWebhookKind: row.alert_webhook_kind as WebhookKind,
    redditClientId: row.reddit_client_id,
    redditClientSecret: row.reddit_client_secret,
    nitterBaseUrls: row.nitter_base_urls,
    updatedAt: row.updated_at,
  };
}

/**
 * Read the singleton, creating it if a hand-restored database is missing it.
 *
 * Migration 001 inserts the row; the upsert here means a partial restore cannot
 * leave the app with nothing to read.
 */
export async function getRawSettings(): Promise<RawSettings> {
  const { rows } = await query<SettingsRow>(`SELECT ${COLUMNS} FROM settings WHERE id = true`);
  const row = rows[0];
  if (row !== undefined) return toRaw(row);

  const created = await query<SettingsRow>(
    `INSERT INTO settings (id) VALUES (true)
     ON CONFLICT (id) DO UPDATE SET updated_at = now()
     RETURNING ${COLUMNS}`,
  );
  return toRaw(created.rows[0] as SettingsRow);
}

export interface SettingsPatch {
  themeMode?: ThemeMode;
  themePreset?: ThemePreset;
  accentHue?: number;
  accentChroma?: number;
  itemsRetentionDays?: number;
  alertWebhookUrl?: string | null;
  alertWebhookKind?: WebhookKind;
  redditClientId?: string | null;
  redditClientSecret?: string | null;
  nitterBaseUrls?: string[];
}

export async function updateSettings(patch: SettingsPatch): Promise<RawSettings> {
  const sets: string[] = [];
  const params: (string | number | null | string[])[] = [];

  const set = (column: string, value: string | number | null | string[]): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.themeMode !== undefined) set('theme_mode', patch.themeMode);
  if (patch.themePreset !== undefined) set('theme_preset', patch.themePreset);
  if (patch.accentHue !== undefined) set('accent_hue', patch.accentHue);
  if (patch.accentChroma !== undefined) set('accent_chroma', patch.accentChroma);
  if (patch.itemsRetentionDays !== undefined) set('items_retention_days', patch.itemsRetentionDays);
  if (patch.alertWebhookUrl !== undefined) set('alert_webhook_url', patch.alertWebhookUrl);
  if (patch.alertWebhookKind !== undefined) set('alert_webhook_kind', patch.alertWebhookKind);
  if (patch.redditClientId !== undefined) set('reddit_client_id', patch.redditClientId);
  if (patch.redditClientSecret !== undefined) set('reddit_client_secret', patch.redditClientSecret);
  if (patch.nitterBaseUrls !== undefined) set('nitter_base_urls', patch.nitterBaseUrls);

  if (sets.length === 0) return getRawSettings();

  // Make sure the row exists before updating it.
  await getRawSettings();

  const { rows } = await query<SettingsRow>(
    `UPDATE settings SET ${sets.join(', ')}, updated_at = now()
      WHERE id = true
      RETURNING ${COLUMNS}`,
    params,
  );
  return toRaw(rows[0] as SettingsRow);
}

// --- effective values ------------------------------------------------------

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  origin: SettingOrigin;
}

/**
 * The credentials to actually authenticate with, or null when Reddit is not
 * configured. Both halves must come from the same place: mixing an environment
 * id with a stored secret would produce a confusing 401.
 */
export function resolveRedditCredentials(settings: RawSettings): RedditCredentials | null {
  const userAgent = env.REDDIT_USER_AGENT;

  if (env.REDDIT_CLIENT_ID !== undefined && env.REDDIT_CLIENT_SECRET !== undefined) {
    return {
      clientId: env.REDDIT_CLIENT_ID,
      clientSecret: env.REDDIT_CLIENT_SECRET,
      userAgent,
      origin: 'env',
    };
  }

  if (
    settings.redditClientId !== null &&
    settings.redditClientId !== '' &&
    settings.redditClientSecret !== null &&
    settings.redditClientSecret !== ''
  ) {
    return {
      clientId: settings.redditClientId,
      clientSecret: settings.redditClientSecret,
      userAgent,
      origin: 'settings',
    };
  }

  return null;
}

/** The Nitter instances to try, in order. Database first, environment as default. */
export function resolveNitterBaseUrls(settings: RawSettings): {
  urls: string[];
  origin: SettingOrigin;
} {
  if (settings.nitterBaseUrls.length > 0) {
    return { urls: settings.nitterBaseUrls, origin: 'settings' };
  }
  return { urls: env.NITTER_BASE_URLS, origin: 'env' };
}

/** The API-facing shape: no secrets, plus enough context to explain precedence. */
export function toPublicSettings(settings: RawSettings): Settings {
  const credentials = resolveRedditCredentials(settings);
  const nitter = resolveNitterBaseUrls(settings);

  const storedRedditComplete =
    settings.redditClientId !== null &&
    settings.redditClientId !== '' &&
    settings.redditClientSecret !== null &&
    settings.redditClientSecret !== '';

  return {
    themeMode: settings.themeMode,
    themePreset: settings.themePreset,
    accentHue: settings.accentHue,
    accentChroma: settings.accentChroma,
    itemsRetentionDays: settings.itemsRetentionDays,
    alertWebhookUrl: settings.alertWebhookUrl,
    alertWebhookKind: settings.alertWebhookKind,
    reddit: {
      configured: credentials !== null,
      origin: credentials?.origin ?? null,
      // Worth saying out loud: otherwise editing the form looks like a no-op.
      envOverridesSettings: credentials?.origin === 'env' && storedRedditComplete,
    },
    nitterBaseUrls: nitter.urls,
    nitterBaseUrlsOrigin: nitter.origin,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

/** True when Reddit can be polled at all. Reddit sources are created inactive otherwise. */
export async function isRedditConfigured(): Promise<boolean> {
  return resolveRedditCredentials(await getRawSettings()) !== null;
}
