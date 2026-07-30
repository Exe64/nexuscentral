/**
 * Item persistence: the normalised store, its filters, and batch insertion.
 *
 * Every item returned carries its source and that source's tags denormalised.
 * The client must never need a second round trip to render a row
 * (03-SPEC-api.md 4).
 */

import type { Item, ItemSort, NormalizedItem, Source, SourceKind, Tag } from '@feedhub/shared';
import { query } from './pool.js';
import { tagsBySourceId } from './sources.js';
import { contentHash } from '../lib/hash.js';
import { buildPage, encodeCursor, type Cursor } from '../http/pagination.js';

interface ItemRow {
  id: string;
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

const ITEM_COLUMNS = `
  i.id, i.url, i.title, i.summary, i.author, i.published_at, i.fetched_at,
  i.engagement_score, i.engagement_comments, i.score, i.matched_rules,
  i.read_at, i.starred,
  s.id AS source_id, s.title AS source_title, s.kind AS source_kind,
  s.icon_url AS source_icon_url
`;

function toItem(row: ItemRow, tags: Tag[]): Item {
  return {
    id: row.id,
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
}

async function hydrate(rows: ItemRow[]): Promise<Item[]> {
  const tags = await tagsBySourceId([...new Set(rows.map((row) => row.source_id))]);
  return rows.map((row) => toItem(row, tags.get(row.source_id) ?? []));
}

// --- filtering -------------------------------------------------------------

export interface ItemFilters {
  tagIds?: readonly number[] | undefined;
  sourceIds?: readonly number[] | undefined;
  unreadOnly?: boolean | undefined;
  starredOnly?: boolean | undefined;
  minScore?: number | undefined;
  since?: Date | undefined;
  q?: string | undefined;
}

type SqlParam = string | number | boolean | Date | readonly number[];

/** Accumulates WHERE fragments and their positional parameters together. */
class WhereBuilder {
  readonly clauses: string[] = [];
  readonly params: SqlParam[] = [];

  add(fragment: (placeholder: string) => string, value: SqlParam): void {
    this.params.push(value);
    this.clauses.push(fragment(`$${this.params.length}`));
  }

  addRaw(clause: string): void {
    this.clauses.push(clause);
  }

  get sql(): string {
    return this.clauses.length > 0 ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

function applyFilters(where: WhereBuilder, filters: ItemFilters): void {
  if (filters.tagIds !== undefined && filters.tagIds.length > 0) {
    // "any of these tags", not "all of them" -- the reader is a union of interests.
    where.add(
      (p) =>
        `EXISTS (SELECT 1 FROM source_tags st
                  WHERE st.source_id = i.source_id AND st.tag_id = ANY(${p}::int[]))`,
      filters.tagIds,
    );
  }
  if (filters.sourceIds !== undefined && filters.sourceIds.length > 0) {
    where.add((p) => `i.source_id = ANY(${p}::int[])`, filters.sourceIds);
  }
  if (filters.unreadOnly === true) {
    where.addRaw('i.read_at IS NULL');
  }
  if (filters.starredOnly === true) {
    where.addRaw('i.starred = true');
  }
  if (filters.minScore !== undefined) {
    where.add((p) => `i.score >= ${p}::numeric`, filters.minScore);
  }
  if (filters.since !== undefined) {
    where.add((p) => `i.published_at >= ${p}::timestamptz`, filters.since);
  }
  if (filters.q !== undefined && filters.q.trim() !== '') {
    // This expression must match items_search_idx exactly or the index is unused.
    where.add(
      (p) =>
        `to_tsvector('simple', i.title || ' ' || coalesce(i.summary,''))
         @@ plainto_tsquery('simple', ${p})`,
      filters.q.trim(),
    );
  }
}

interface SortSpec {
  /** The ordered expression, also used for the cursor comparison. */
  expression: string;
  /** Cast applied to the cursor's sort value. */
  cast: string;
  cursorValue: (row: ItemRow) => string | number;
}

const SORTS: Record<ItemSort, SortSpec> = {
  published: {
    expression: 'i.published_at',
    cast: 'timestamptz',
    cursorValue: (row) => row.published_at.toISOString(),
  },
  score: {
    expression: 'i.score',
    cast: 'numeric',
    cursorValue: (row) => row.score,
  },
  engagement: {
    // Items with no engagement signal sort last rather than dropping out; a
    // NULLS LAST ordering cannot be expressed in a row comparison, so the null
    // is folded into a value below any real one.
    expression: 'coalesce(i.engagement_score, -1)',
    cast: 'int',
    cursorValue: (row) => row.engagement_score ?? -1,
  },
};

export interface ListItemsOptions extends ItemFilters {
  sort?: ItemSort | undefined;
  limit?: number | undefined;
  cursor?: Cursor | undefined;
}

export async function listItems(
  options: ListItemsOptions = {},
): Promise<{ data: Item[]; nextCursor: string | null }> {
  const sort = SORTS[options.sort ?? 'published'];
  const limit = options.limit ?? 50;

  const where = new WhereBuilder();
  applyFilters(where, options);

  if (options.cursor !== undefined) {
    // Row comparison, so the ordering index is still usable for the seek.
    where.params.push(options.cursor.v, options.cursor.id);
    const vPlaceholder = `$${where.params.length - 1}::${sort.cast}`;
    const idPlaceholder = `$${where.params.length}::bigint`;
    where.addRaw(`(${sort.expression}, i.id) < (${vPlaceholder}, ${idPlaceholder})`);
  }

  // Fetch one extra row to learn whether a next page exists.
  const params: SqlParam[] = [...where.params, limit + 1];

  const { rows } = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}
       FROM items i
       JOIN sources s ON s.id = i.source_id
       ${where.sql}
      ORDER BY ${sort.expression} DESC, i.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = buildPage(rows, limit, (row) => ({ v: sort.cursorValue(row), id: row.id }));
  return { data: await hydrate(page.data), nextCursor: page.nextCursor };
}

export async function getItem(id: string): Promise<Item | null> {
  const { rows } = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}
       FROM items i
       JOIN sources s ON s.id = i.source_id
      WHERE i.id = $1::bigint`,
    [id],
  );
  if (rows[0] === undefined) return null;
  const [item] = await hydrate(rows);
  return item ?? null;
}

// --- user state ------------------------------------------------------------

export async function setItemRead(id: string, read: boolean): Promise<boolean> {
  const result = await query(
    `UPDATE items SET read_at = ${read ? 'now()' : 'NULL'} WHERE id = $1::bigint`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setItemStarred(id: string, starred: boolean): Promise<boolean> {
  const result = await query(`UPDATE items SET starred = $2 WHERE id = $1::bigint`, [id, starred]);
  return (result.rowCount ?? 0) > 0;
}

/** Mark every item matching the same filters as `GET /api/items` as read. */
export async function markAllRead(filters: ItemFilters): Promise<number> {
  const where = new WhereBuilder();
  applyFilters(where, filters);
  where.addRaw('i.read_at IS NULL');

  const result = await query(
    `UPDATE items SET read_at = now()
      WHERE id IN (SELECT i.id FROM items i ${where.sql})`,
    where.params,
  );
  return result.rowCount ?? 0;
}

// --- ingestion -------------------------------------------------------------

export interface InsertResult {
  /** Ids of rows that were genuinely new. Only these get scored and alerted on. */
  insertedIds: string[];
  /** Items presented for insertion after in-batch deduplication. */
  considered: number;
}

/**
 * Insert a batch of normalised items, skipping ones already stored.
 *
 * `ON CONFLICT (content_hash) DO NOTHING ... RETURNING id` is what makes the
 * difference between "seen before" and "new" observable, and only new rows may
 * be scored or alerted on (02-SPEC-ingestion.md 4).
 */
export async function insertItems(
  source: Pick<Source, 'id' | 'kind' | 'identifier'>,
  items: readonly NormalizedItem[],
): Promise<InsertResult> {
  if (items.length === 0) return { insertedIds: [], considered: 0 };

  // Deduplicate inside the batch first: a feed that lists the same entry twice
  // would otherwise conflict with a row inserted by this very statement.
  const byHash = new Map<string, { item: NormalizedItem; hash: Buffer }>();
  for (const item of items) {
    const hash = contentHash({
      kind: source.kind,
      identifier: source.identifier,
      guid: item.guid,
      url: item.url,
    });
    const key = hash.toString('hex');
    if (!byHash.has(key)) byHash.set(key, { item, hash });
  }

  const batch = [...byHash.values()];

  const { rows } = await query<{ id: string }>(
    `INSERT INTO items
       (source_id, content_hash, url, title, summary, author, published_at,
        engagement_score, engagement_comments, raw)
     SELECT $1::int, h, u, t, sm, a, p, es, ec, r
       FROM unnest(
         $2::bytea[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::timestamptz[], $8::int[], $9::int[], $10::jsonb[]
       ) AS batch(h, u, t, sm, a, p, es, ec, r)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING id`,
    [
      source.id,
      batch.map((entry) => entry.hash),
      batch.map((entry) => entry.item.url),
      batch.map((entry) => entry.item.title),
      batch.map((entry) => entry.item.summary ?? null),
      batch.map((entry) => entry.item.author ?? null),
      batch.map((entry) => entry.item.publishedAt),
      batch.map((entry) => entry.item.engagementScore ?? null),
      batch.map((entry) => entry.item.engagementComments ?? null),
      batch.map((entry) => JSON.stringify(entry.item.raw ?? null)),
    ],
  );

  return { insertedIds: rows.map((row) => row.id), considered: batch.length };
}

/**
 * The newest Reddit fullname stored for a source, for use as a `before` cursor.
 *
 * Ordered by `published_at`, not by `id`: insertion order follows when we happened
 * to poll, and a listing can arrive out of order. `raw` is nulled for items older
 * than 7 days, so a source left unpolled for longer falls back to a full listing
 * rather than passing a cursor Reddit would reject.
 */
export async function newestFullnameForSource(sourceId: number): Promise<string | null> {
  const { rows } = await query<{ fullname: string }>(
    `SELECT raw->>'name' AS fullname
       FROM items
      WHERE source_id = $1
        AND raw ? 'name'
        AND raw->>'name' <> ''
      ORDER BY published_at DESC
      LIMIT 1`,
    [sourceId],
  );
  return rows[0]?.fullname ?? null;
}

export async function countItemsForSource(sourceId: number): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM items WHERE source_id = $1`,
    [sourceId],
  );
  return rows[0]?.n ?? 0;
}

/** Counts for the stats widget and `GET /api/stats`. */
export async function itemStats(): Promise<{
  total: number;
  unread: number;
  starred: number;
  today: number;
  thisWeek: number;
}> {
  const { rows } = await query<{
    total: number;
    unread: number;
    starred: number;
    today: number;
    this_week: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
            count(*) FILTER (WHERE starred)::int AS starred,
            count(*) FILTER (WHERE fetched_at >= date_trunc('day', now()))::int AS today,
            count(*) FILTER (WHERE fetched_at >= now() - interval '7 days')::int AS this_week
       FROM items`,
  );
  const row = rows[0];
  return {
    total: row?.total ?? 0,
    unread: row?.unread ?? 0,
    starred: row?.starred ?? 0,
    today: row?.today ?? 0,
    thisWeek: row?.this_week ?? 0,
  };
}

/** Exposed so a caller can build a cursor for an item it already holds. */
export function cursorForItem(item: Item, sort: ItemSort): string {
  const value: string | number =
    sort === 'published'
      ? item.publishedAt
      : sort === 'score'
        ? item.score
        : (item.engagementScore ?? -1);
  return encodeCursor({ v: value, id: item.id });
}
