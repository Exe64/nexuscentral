/**
 * Alert persistence, read side.
 *
 * Nothing writes to this table yet: delivery and the rules that create alerts are
 * Phase 6. The reads exist now because the `alerts` widget needs them, and a widget
 * that says "No alerts. Turn on alerting in a rule to get notified here." is a
 * better empty state than a placeholder.
 */

import type { Alert, Item, SourceKind, Tag } from '@nexuscentral/shared';
import { query } from './pool.js';
import { tagsBySourceId } from './sources.js';

interface AlertRow {
  id: string;
  created_at: Date;
  delivered_at: Date | null;
  delivery_error: string | null;
  acknowledged_at: Date | null;
  rule_id: number;
  rule_name: string;
  item_id: string;
  url: string;
  title: string;
  summary: string | null;
  author: string | null;
  published_at: Date;
  fetched_at: Date;
  engagement_score: number | null;
  engagement_comments: number | null;
  score: number;
  matched_rules: number[];
  read_at: Date | null;
  starred: boolean;
  source_id: number;
  source_title: string;
  source_kind: SourceKind;
  source_icon_url: string | null;
}

function toAlert(row: AlertRow, tags: Tag[]): Alert {
  const item: Item = {
    id: row.item_id,
    url: row.url,
    title: row.title,
    summary: row.summary,
    author: row.author,
    publishedAt: row.published_at.toISOString(),
    fetchedAt: row.fetched_at.toISOString(),
    engagementScore: row.engagement_score,
    engagementComments: row.engagement_comments,
    score: row.score,
    matchedRules: row.matched_rules,
    readAt: row.read_at?.toISOString() ?? null,
    starred: row.starred,
    source: {
      id: row.source_id,
      title: row.source_title,
      kind: row.source_kind,
      iconUrl: row.source_icon_url,
      tags,
    },
  };

  return {
    id: row.id,
    item,
    rule: { id: row.rule_id, name: row.rule_name },
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    deliveryError: row.delivery_error,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
  };
}

export interface ListAlertsOptions {
  acknowledged?: boolean | undefined;
  limit?: number | undefined;
}

/** Newest first, with the matched rule name and the item, denormalised. */
export async function listAlerts(options: ListAlertsOptions = {}): Promise<Alert[]> {
  const params: (number | boolean)[] = [];
  let where = '';

  if (options.acknowledged !== undefined) {
    where = options.acknowledged
      ? 'WHERE a.acknowledged_at IS NOT NULL'
      : 'WHERE a.acknowledged_at IS NULL';
  }

  params.push(options.limit ?? 50);

  const { rows } = await query<AlertRow>(
    `SELECT a.id, a.created_at, a.delivered_at, a.delivery_error, a.acknowledged_at,
            r.id AS rule_id, r.name AS rule_name,
            i.id AS item_id, i.url, i.title, i.summary, i.author, i.published_at, i.fetched_at,
            i.engagement_score, i.engagement_comments, i.score, i.matched_rules,
            i.read_at, i.starred,
            s.id AS source_id, s.title AS source_title, s.kind AS source_kind,
            s.icon_url AS source_icon_url
       FROM alerts a
       JOIN rules r ON r.id = a.rule_id
       JOIN items i ON i.id = a.item_id
       JOIN sources s ON s.id = i.source_id
       ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const tags = await tagsBySourceId([...new Set(rows.map((row) => row.source_id))]);
  return rows.map((row) => toAlert(row, tags.get(row.source_id) ?? []));
}

export async function acknowledgeAlert(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE alerts SET acknowledged_at = now() WHERE id = $1::bigint AND acknowledged_at IS NULL`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function acknowledgeAllAlerts(): Promise<number> {
  const result = await query(
    `UPDATE alerts SET acknowledged_at = now() WHERE acknowledged_at IS NULL`,
  );
  return result.rowCount ?? 0;
}

export async function alertCounts(): Promise<{
  total: number;
  unacknowledged: number;
  undelivered: number;
}> {
  const { rows } = await query<{ total: number; unacknowledged: number; undelivered: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unacknowledged,
            count(*) FILTER (WHERE delivered_at IS NULL)::int AS undelivered
       FROM alerts`,
  );
  return rows[0] ?? { total: 0, unacknowledged: 0, undelivered: 0 };
}

/** Top sources by item count, for the stats widget. */
export async function topSourcesByVolume(
  limit: number,
): Promise<{ id: number; title: string; count: number }[]> {
  const { rows } = await query<{ id: number; title: string; count: number }>(
    `SELECT s.id, s.title, count(i.id)::int AS count
       FROM sources s
       JOIN items i ON i.source_id = s.id
      GROUP BY s.id, s.title
      ORDER BY count DESC, s.title ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}
