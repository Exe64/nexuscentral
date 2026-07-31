/**
 * Alert delivery (02-SPEC-ingestion.md 6).
 *
 * Three rules the spec is explicit about, and each one is here for a reason worth
 * remembering:
 *
 * - **One notification per batch, not per alert.** A rule matching forty items in
 *   one poll must produce one push. Grouping happens by reading every pending
 *   alert at delivery time, not by counting what triggered the job.
 * - **At most one notification per 60 seconds.** Two polls a few seconds apart
 *   must not mean two pushes. When the last one was too recent the job re-queues
 *   itself for the remainder and the alerts simply stay pending.
 * - **A failed push never loses an alert.** `delivery_error` is recorded and
 *   `delivered_at` stays null, so the in-app widget remains the source of truth
 *   and the next run retries the same rows.
 */

import type { WebhookKind } from '@nexuscentral/shared';
import {
  markDelivered,
  markDeliveryFailed,
  pendingAlerts,
  type PendingAlert,
} from '../db/alerts.js';
import { getRawSettings } from '../db/settings.js';
import { logger } from '../logger.js';
import { buildRequest, type AlertBatch } from './targets.js';

const log = logger.child({ component: 'alerts' });

/** Minimum spacing between notifications. */
export const MIN_INTERVAL_MS = 60_000;

/** How many alerts one notification may describe. Beyond this the body is summarised. */
export const MAX_PER_BATCH = 40;

/** 02-SPEC-ingestion.md 6: three attempts, 1s then 5s then 25s. */
export const RETRY_DELAYS_MS = [1_000, 5_000, 25_000] as const;

export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * When the last notification went out.
 *
 * In memory: this is a politeness limit on outbound pushes, and a restart
 * resetting it costs at most one extra notification. Persisting it would mean a
 * write per delivery to protect against something harmless.
 */
let lastDeliveryAt = 0;

/** Test seam. The clock is the only thing these tests cannot wait out. */
export function __resetDeliveryClock(at = 0): void {
  lastDeliveryAt = at;
}

export interface DeliveryOutcome {
  /** `sent` counts alerts included in a notification, not notifications. */
  sent: number;
  skipped: 'not-configured' | 'nothing-pending' | 'too-soon' | null;
  /** Milliseconds until a retry is worth attempting, when skipped as too soon. */
  retryInMs?: number;
  error?: string;
}

async function post(url: string, init: RequestInit): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      // The body often says exactly what is wrong -- a bad ntfy topic, a revoked
      // Discord webhook -- and it is the difference between a useful
      // `delivery_error` and "HTTP 400".
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send with the specified backoff.
 *
 * Retried here rather than by re-queueing the job: a queue-level retry would
 * re-read the pending set and could group differently on the second attempt,
 * which makes "one notification per batch" untrue in exactly the case where it
 * matters.
 */
export async function sendWithRetry(
  kind: WebhookKind,
  url: string,
  batch: AlertBatch,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = buildRequest(kind, url, batch);
  if (request === null) return { ok: false, error: 'No webhook configured' };

  let lastError = 'unknown';

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      await post(request.url, request.init);
      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const wait = delays[attempt];
      // No sleep after the final attempt -- that would just delay the failure.
      if (attempt < delays.length - 1 && wait !== undefined) {
        log.warn({ attempt: attempt + 1, err: lastError, kind }, 'Alert delivery failed, retrying');
        await sleep(wait);
      }
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Deliver whatever is pending, as one notification.
 *
 * Returns rather than throws on every expected outcome: an unconfigured webhook
 * and an empty queue are both normal, and a job that fails for them would fill
 * the queue's failure counters with nothing worth looking at.
 */
export async function deliverPendingAlerts(now = Date.now()): Promise<DeliveryOutcome> {
  const settings = await getRawSettings();
  const kind = settings.alertWebhookKind;
  const url = settings.alertWebhookUrl;

  if (kind === 'none' || url === null || url === '') {
    return { sent: 0, skipped: 'not-configured' };
  }

  const since = now - lastDeliveryAt;
  if (since < MIN_INTERVAL_MS) {
    // Pending alerts stay pending; the widget shows them either way.
    return { sent: 0, skipped: 'too-soon', retryInMs: MIN_INTERVAL_MS - since };
  }

  const alerts: PendingAlert[] = await pendingAlerts(MAX_PER_BATCH);
  if (alerts.length === 0) return { sent: 0, skipped: 'nothing-pending' };

  const ids = alerts.map((alert) => alert.id);
  const result = await sendWithRetry(kind, url, { alerts });

  if (!result.ok) {
    await markDeliveryFailed(ids, result.error);
    log.error({ err: result.error, kind, count: alerts.length }, 'Alert delivery failed');
    return { sent: 0, skipped: null, error: result.error };
  }

  // Only stamp the clock on a real send, so a run that failed does not buy the
  // next one a 60 second wait.
  lastDeliveryAt = now;
  await markDelivered(ids);

  log.info({ kind, count: alerts.length }, 'Alerts delivered');
  return { sent: alerts.length, skipped: null };
}

/** "Send test notification" from the settings page. Never touches the alerts table. */
export async function sendTestNotification(): Promise<{ ok: boolean; error?: string }> {
  const settings = await getRawSettings();
  const kind = settings.alertWebhookKind;
  const url = settings.alertWebhookUrl;

  if (kind === 'none' || url === null || url === '') {
    return { ok: false, error: 'No webhook is configured.' };
  }

  // One attempt, not three: the user is watching, and waiting 31 seconds to be
  // told the URL is wrong is worse than being told immediately.
  const result = await sendWithRetry(kind, url, { alerts: [], test: true }, [0]);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
