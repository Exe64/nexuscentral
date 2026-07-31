/**
 * Source persistence, including the polling schedule and health bookkeeping.
 */

import type { PoolClient } from 'pg';
import type { ConditionalState, Source, SourceKind, Tag, TagColor } from '@nexuscentral/shared';
import { query, transaction } from './pool.js';
import { formatPollInterval } from '../lib/interval.js';
import { HttpError } from '../http/errors.js';

/** Failures beyond this point mean a permanently dead feed; stop paying for it. */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** A Nitter instance fails by returning a well-formed empty feed. */
export const EMPTY_RUNS_BEFORE_ALERT = 3;

interface SourceRow {
  id: number;
  kind: SourceKind;
  title: string;
  identifier: string;
  site_url: string | null;
  icon_url: string | null;
  weight: number;
  active: boolean;
  poll_interval_seconds: number;
  last_run_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_empty: number;
  created_at: Date;
}

interface TagRow {
  source_id: number;
  id: number;
  name: string;
  slug: string;
  color: string;
  created_at: Date;
}

const SOURCE_COLUMNS = `
  s.id, s.kind, s.title, s.identifier, s.site_url, s.icon_url,
  s.weight, s.active,
  extract(epoch from s.poll_interval)::int AS poll_interval_seconds,
  s.last_run_at, s.last_ok_at, s.last_error,
  s.consecutive_failures, s.consecutive_empty, s.created_at
`;

function toSource(row: SourceRow, tags: Tag[]): Source {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    identifier: row.identifier,
    siteUrl: row.site_url,
    iconUrl: row.icon_url,
    weight: row.weight,
    active: row.active,
    pollInterval: formatPollInterval(row.poll_interval_seconds),
    tags,
    health: {
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      lastOkAt: row.last_ok_at?.toISOString() ?? null,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
      consecutiveEmpty: row.consecutive_empty,
    },
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Fetch the tags for a set of sources in one query and group them.
 *
 * Aggregating to JSON inside the source query would work, but it pushes
 * timestamp formatting into SQL where the session timezone can change the answer.
 * `pg` hands back real Date objects, so grouping in JS keeps the format exact.
 */
export async function tagsBySourceId(sourceIds: readonly number[]): Promise<Map<number, Tag[]>> {
  const grouped = new Map<number, Tag[]>();
  if (sourceIds.length === 0) return grouped;

  const { rows } = await query<TagRow>(
    `SELECT st.source_id, t.id, t.name, t.slug, t.color, t.created_at
       FROM source_tags st
       JOIN tags t ON t.id = st.tag_id
      WHERE st.source_id = ANY($1::int[])
      ORDER BY t.name ASC`,
    [sourceIds],
  );

  for (const row of rows) {
    const tag: Tag = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      color: row.color as TagColor,
      createdAt: row.created_at.toISOString(),
    };
    const existing = grouped.get(row.source_id);
    if (existing === undefined) grouped.set(row.source_id, [tag]);
    else existing.push(tag);
  }

  return grouped;
}

export interface SourceFilters {
  kind?: SourceKind | undefined;
  tagId?: number | undefined;
  active?: boolean | undefined;
  q?: string | undefined;
}

export async function listSources(filters: SourceFilters = {}): Promise<Source[]> {
  const where: string[] = [];
  const params: (string | number | boolean)[] = [];

  if (filters.kind !== undefined) {
    params.push(filters.kind);
    where.push(`s.kind = $${params.length}`);
  }
  if (filters.active !== undefined) {
    params.push(filters.active);
    where.push(`s.active = $${params.length}`);
  }
  if (filters.tagId !== undefined) {
    params.push(filters.tagId);
    where.push(
      `EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id = s.id AND st.tag_id = $${params.length})`,
    );
  }
  if (filters.q !== undefined && filters.q.trim() !== '') {
    // Title and identifier both: users search for "nutanix" and for the feed URL.
    params.push(`%${filters.q.trim()}%`);
    where.push(`(s.title ILIKE $${params.length} OR s.identifier ILIKE $${params.length})`);
  }

  const { rows } = await query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}
       FROM sources s
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.title ASC, s.id ASC`,
    params,
  );

  const tags = await tagsBySourceId(rows.map((row) => row.id));
  return rows.map((row) => toSource(row, tags.get(row.id) ?? []));
}

export async function getSource(id: number): Promise<Source | null> {
  const { rows } = await query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const tags = await tagsBySourceId([row.id]);
  return toSource(row, tags.get(row.id) ?? []);
}

export async function findSourceByIdentity(
  kind: SourceKind,
  identifier: string,
): Promise<{ id: number } | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM sources WHERE kind = $1 AND identifier = $2`,
    [kind, identifier],
  );
  return rows[0] ?? null;
}

export interface CreateSourceInput {
  kind: SourceKind;
  identifier: string;
  title: string;
  siteUrl?: string | null;
  iconUrl?: string | null;
  weight?: number;
  active?: boolean;
  pollIntervalSeconds: number;
  tagIds?: readonly number[];
  /**
   * Recorded at creation when the source cannot be polled yet -- missing Reddit
   * credentials, no Nitter instance. The UI renders `health.lastError`, so this is
   * how a deliberately inactive source explains itself.
   */
  lastError?: string;
}

export async function createSource(input: CreateSourceInput): Promise<Source> {
  const id = await transaction(async (client) => {
    let inserted: number;
    try {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO sources
           (kind, identifier, title, site_url, icon_url, weight, active, poll_interval, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, make_interval(secs => $8), $9)
         RETURNING id`,
        [
          input.kind,
          input.identifier,
          input.title,
          input.siteUrl ?? null,
          input.iconUrl ?? null,
          input.weight ?? 1,
          input.active ?? true,
          input.pollIntervalSeconds,
          input.lastError ?? null,
        ],
      );
      inserted = (rows[0] as { id: number }).id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await findSourceByIdentity(input.kind, input.identifier);
        // The UI offers to open the existing source, so it needs the id.
        throw HttpError.conflict(`This ${input.kind} source is already tracked`, {
          existingId: existing?.id ?? null,
        });
      }
      throw err;
    }

    await attachTags(client, inserted, input.tagIds ?? []);
    return inserted;
  });

  // Non-null: the row was just inserted inside the transaction that committed.
  return (await getSource(id)) as Source;
}

export interface UpdateSourceInput {
  title?: string;
  siteUrl?: string | null;
  iconUrl?: string | null;
  weight?: number;
  active?: boolean;
  pollIntervalSeconds?: number;
  tagIds?: readonly number[];
}

export async function updateSource(id: number, patch: UpdateSourceInput): Promise<Source | null> {
  const updated = await transaction(async (client) => {
    const sets: string[] = [];
    const params: (string | number | boolean | null)[] = [];

    const set = (column: string, value: string | number | boolean | null): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.title !== undefined) set('title', patch.title);
    if (patch.siteUrl !== undefined) set('site_url', patch.siteUrl);
    if (patch.iconUrl !== undefined) set('icon_url', patch.iconUrl);
    if (patch.weight !== undefined) set('weight', patch.weight);
    if (patch.pollIntervalSeconds !== undefined) {
      params.push(patch.pollIntervalSeconds);
      sets.push(`poll_interval = make_interval(secs => $${params.length})`);
    }
    if (patch.active !== undefined) {
      set('active', patch.active);
      // Re-activating a source that was auto-deactivated must clear the backoff,
      // or it would immediately be considered overdue by a factor of eight.
      if (patch.active) sets.push('consecutive_failures = 0', 'last_error = NULL');
    }

    let exists = true;
    if (sets.length > 0) {
      params.push(id);
      const result = await client.query(
        `UPDATE sources SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );
      exists = (result.rowCount ?? 0) > 0;
    } else {
      const check = await client.query(`SELECT 1 FROM sources WHERE id = $1`, [id]);
      exists = (check.rowCount ?? 0) > 0;
    }

    if (!exists) return false;

    if (patch.tagIds !== undefined) {
      await client.query(`DELETE FROM source_tags WHERE source_id = $1`, [id]);
      await attachTags(client, id, patch.tagIds);
    }

    return true;
  });

  return updated ? getSource(id) : null;
}

export async function deleteSource(id: number): Promise<boolean> {
  // Items and, through them, alerts cascade. Removing a source removes its
  // history -- that is intended (01-SPEC-data-model.md 2).
  const result = await query(`DELETE FROM sources WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

async function attachTags(
  client: PoolClient,
  sourceId: number,
  tagIds: readonly number[],
): Promise<void> {
  if (tagIds.length === 0) return;
  await client.query(
    `INSERT INTO source_tags (source_id, tag_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [sourceId, [...new Set(tagIds)]],
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// --- polling ---------------------------------------------------------------

/** The conditional-request state, kept off the API-facing Source type. */
export async function getConditionalState(id: number): Promise<ConditionalState> {
  const { rows } = await query<{ http_etag: string | null; http_modified: string | null }>(
    `SELECT http_etag, http_modified FROM sources WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return {
    etag: row?.http_etag ?? undefined,
    lastModified: row?.http_modified ?? undefined,
  };
}

/**
 * Sources whose next poll is due.
 *
 * The effective interval is `poll_interval * min(8, 2 ^ consecutive_failures)`
 * (02-SPEC-ingestion.md 7): a failing feed is retried, but with decreasing
 * enthusiasm.
 */
export async function listDueSourceIds(limit = 200): Promise<number[]> {
  const { rows } = await query<{ id: number }>(
    `SELECT s.id
       FROM sources s
      WHERE s.active = true
        AND (
          s.last_run_at IS NULL
          OR s.last_run_at
             + (s.poll_interval * least(8::numeric, power(2::numeric, s.consecutive_failures)))
             < now()
        )
      ORDER BY s.last_run_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

export async function markPollStarted(id: number): Promise<void> {
  await query(`UPDATE sources SET last_run_at = now() WHERE id = $1`, [id]);
}

export interface PollSuccess {
  etag?: string | undefined;
  lastModified?: string | undefined;
  /**
   * `items`     -- the run returned content; the empty counter resets.
   * `empty`     -- zero items where that is a symptom. This is how a Nitter
   *                instance dies silently, so it counts towards
   *                `consecutive_empty`.
   * `unchanged` -- zero items where that is the normal steady state: an HTTP 304,
   *                or a cursor-based adapter reporting nothing new. Leaves the
   *                counter untouched, because otherwise every quiet subreddit
   *                would raise a health alert every 45 minutes.
   */
  outcome: 'items' | 'empty' | 'unchanged';
}

export async function markPollSuccess(id: number, result: PollSuccess): Promise<number> {
  const emptyExpression =
    result.outcome === 'empty'
      ? 'consecutive_empty + 1'
      : result.outcome === 'items'
        ? '0'
        : 'consecutive_empty';

  // Only overwrite the stored validators when the response supplied new ones: a
  // 304 carries no ETag, and clearing it would defeat the next conditional request.
  const { rows } = await query<{ consecutive_empty: number }>(
    `UPDATE sources
        SET last_ok_at = now(),
            last_error = NULL,
            consecutive_failures = 0,
            consecutive_empty = ${emptyExpression},
            http_etag = coalesce($2, http_etag),
            http_modified = coalesce($3, http_modified)
      WHERE id = $1
      RETURNING consecutive_empty`,
    [id, result.etag ?? null, result.lastModified ?? null],
  );

  return rows[0]?.consecutive_empty ?? 0;
}

export interface PollFailure {
  consecutiveFailures: number;
  /** True when this failure crossed the threshold and deactivated the source. */
  deactivated: boolean;
}

export async function markPollFailure(id: number, message: string): Promise<PollFailure> {
  const { rows } = await query<{ consecutive_failures: number; active: boolean }>(
    `UPDATE sources
        SET consecutive_failures = consecutive_failures + 1,
            last_error = $2,
            active = CASE WHEN consecutive_failures + 1 >= $3 THEN false ELSE active END
      WHERE id = $1
      RETURNING consecutive_failures, active`,
    [id, message.slice(0, 2000), MAX_CONSECUTIVE_FAILURES],
  );

  const row = rows[0];
  return {
    consecutiveFailures: row?.consecutive_failures ?? 0,
    deactivated: row !== undefined && !row.active,
  };
}

/** The most recent poll attempt across every source, for `GET /api/health`. */
export async function lastPollAt(): Promise<string | null> {
  const { rows } = await query<{ at: Date | null }>(`SELECT max(last_run_at) AS at FROM sources`);
  return rows[0]?.at?.toISOString() ?? null;
}

export interface SourceHealthCounts {
  total: number;
  active: number;
  failing: number;
  stale: number;
  /**
   * Sources returning a well-formed feed with nothing in it, repeatedly.
   *
   * Counted separately from `failing` because nothing about those runs looked
   * like an error: HTTP 200, a parseable feed, zero items. This is the counter
   * the Nitter silent-death rule exists for, and it is what the `source_health`
   * widget selects on alongside `consecutive_failures > 0`.
   */
  silentlyEmpty: number;
}

/** Counts for `GET /api/health`. `stale` means overdue by more than 3 intervals. */
export async function sourceHealthCounts(): Promise<SourceHealthCounts> {
  const { rows } = await query<SourceHealthCounts>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            count(*) FILTER (WHERE consecutive_failures > 0)::int AS failing,
            count(*) FILTER (WHERE consecutive_empty >= $1)::int AS "silentlyEmpty",
            count(*) FILTER (
              WHERE active AND last_run_at IS NOT NULL
                AND last_run_at + (poll_interval * 3) < now()
            )::int AS stale
       FROM sources`,
    [EMPTY_RUNS_BEFORE_ALERT],
  );
  return rows[0] ?? { total: 0, active: 0, failing: 0, stale: 0, silentlyEmpty: 0 };
}

/**
 * The sources the `source_health` widget lists: anything failing or silently
 * empty (04-SPEC-frontend.md 4.4).
 */
export async function listUnhealthySources(): Promise<Source[]> {
  const { rows } = await query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}
       FROM sources s
      WHERE s.consecutive_failures > 0 OR s.consecutive_empty >= $1
      ORDER BY s.consecutive_failures DESC, s.consecutive_empty DESC, s.title ASC`,
    [EMPTY_RUNS_BEFORE_ALERT],
  );

  const tags = await tagsBySourceId(rows.map((row) => row.id));
  return rows.map((row) => toSource(row, tags.get(row.id) ?? []));
}
