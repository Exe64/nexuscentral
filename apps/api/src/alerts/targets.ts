/**
 * Where a notification goes (02-SPEC-ingestion.md 6).
 *
 * Four shapes, all free and self-hostable. Each one only has to turn a batch of
 * alerts into a request; sending, retrying and recording are the delivery job's
 * problem, not theirs.
 *
 * The configured URL is used **verbatim** for every kind. The spec writes Gotify
 * as `POST {url}/message?token=…`, but appending a path to a URL the user typed
 * is the kind of helpfulness that produces a 404 nobody can explain -- especially
 * behind a reverse proxy with a subpath. The settings panel says what to paste.
 */

import type { WebhookKind } from '@nexuscentral/shared';
import type { PendingAlert } from '../db/alerts.js';

/** What the delivery job sends. */
export interface OutboundRequest {
  url: string;
  init: RequestInit;
}

export interface AlertBatch {
  alerts: readonly PendingAlert[];
  /** True for "Send test notification", so the text says so. */
  test?: boolean;
}

/** Reused by every kind: one line per alert, oldest first. */
function lines(batch: AlertBatch): string[] {
  return batch.alerts.map(
    (alert) =>
      `• ${alert.itemTitle}\n  ${alert.sourceTitle} — ${alert.ruleName}\n  ${alert.itemUrl}`,
  );
}

function title(batch: AlertBatch): string {
  if (batch.test === true) return 'nexuscentral: test notification';
  const count = batch.alerts.length;
  if (count === 1) {
    // One alert names its rule, because that is the useful part on a lock screen.
    return `nexuscentral: ${batch.alerts[0]?.ruleName ?? 'alert'}`;
  }
  const rules = new Set(batch.alerts.map((alert) => alert.ruleName));
  return rules.size === 1
    ? `nexuscentral: ${count} matches for ${[...rules][0] ?? ''}`
    : `nexuscentral: ${count} alerts`;
}

function body(batch: AlertBatch): string {
  if (batch.test === true) {
    return 'If you can read this, alert delivery is configured correctly.';
  }
  return lines(batch).join('\n\n');
}

/**
 * Notification bodies are capped.
 *
 * ntfy rejects oversized messages and Discord hard-limits an embed description to
 * 4096 characters. Forty matches at three lines each clears both, so the batch is
 * summarised rather than truncated mid-sentence.
 */
const MAX_BODY = 3500;

function trimmedBody(batch: AlertBatch): string {
  if (batch.test === true) return body(batch);

  const all = lines(batch);
  const whole = all.join('\n\n');
  if (whole.length <= MAX_BODY) return whole;

  // Fit as many whole entries as the budget allows, then say what was left out.
  // Saying so is the point: silently dropping 163 of 200 matches would make the
  // notification lie about what happened.
  let shown = 0;
  let assembled = '';
  for (const line of all) {
    if (assembled.length + line.length + 2 > MAX_BODY) break;
    assembled += (shown === 0 ? '' : '\n\n') + line;
    shown += 1;
  }

  const dropped = all.length - shown;
  if (dropped === 0) return assembled;
  return `${assembled}\n\n… and ${dropped} more. Open the dashboard for the full list.`;
}

export interface TargetBuilder {
  build(url: string, batch: AlertBatch): OutboundRequest;
}

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const BUILDERS: Record<Exclude<WebhookKind, 'none'>, TargetBuilder> = {
  /**
   * ntfy takes the message as the raw body and everything else as headers.
   * Headers must be latin-1, so the title is stripped of anything else rather
   * than making the request throw.
   */
  ntfy: {
    build(url, batch) {
      const clickable = batch.alerts.length === 1 ? batch.alerts[0]?.itemUrl : undefined;
      const headers: Record<string, string> = {
        Title: title(batch).replace(/[^\x20-\x7e]/g, ''),
        Priority: batch.test === true ? 'default' : 'high',
        Tags: batch.test === true ? 'white_check_mark' : 'bell',
      };
      if (clickable !== undefined) headers.Click = clickable;

      return { url, init: { method: 'POST', headers, body: trimmedBody(batch) } };
    },
  },

  gotify: {
    build(url, batch) {
      return {
        url,
        init: json({
          title: title(batch),
          message: trimmedBody(batch),
          priority: batch.test === true ? 5 : 8,
        }),
      };
    },
  },

  discord: {
    build(url, batch) {
      // One embed per alert reads far better than one wall of text, but Discord
      // caps a message at 10 embeds -- so past that it falls back to the list.
      const useEmbeds = batch.test !== true && batch.alerts.length <= 10;

      if (useEmbeds) {
        return {
          url,
          init: json({
            content: title(batch),
            embeds: batch.alerts.map((alert) => ({
              title: alert.itemTitle.slice(0, 256),
              url: alert.itemUrl,
              description: `${alert.sourceTitle} — ${alert.ruleName}`.slice(0, 4096),
            })),
          }),
        };
      }

      return { url, init: json({ content: `**${title(batch)}**\n${trimmedBody(batch)}` }) };
    },
  },

  /** Everything, unformatted, for whatever the user has wired up downstream. */
  generic: {
    build(url, batch) {
      return {
        url,
        init: json({
          title: title(batch),
          test: batch.test === true,
          count: batch.alerts.length,
          alerts: batch.alerts,
        }),
      };
    },
  },
};

export function buildRequest(
  kind: WebhookKind,
  url: string,
  batch: AlertBatch,
): OutboundRequest | null {
  if (kind === 'none') return null;
  return BUILDERS[kind].build(url, batch);
}

/** Exposed for the tests, which assert on the copy rather than re-deriving it. */
export const __testing = { title, body, trimmedBody, MAX_BODY };
