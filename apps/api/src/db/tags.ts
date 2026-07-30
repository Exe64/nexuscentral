/**
 * Tag persistence.
 *
 * Tags are a normalised table rather than a `text[]` column so that renaming is
 * one UPDATE and autocomplete has something to query (decision D3).
 */

import type { PoolClient } from 'pg';
import type { Tag, TagColor, TagWithCounts } from '@feedhub/shared';
import { query, transaction } from './pool.js';
import { slugify } from '../lib/slug.js';
import { HttpError } from '../http/errors.js';

interface TagRow {
  id: number;
  name: string;
  slug: string;
  color: string;
  created_at: Date;
}

interface TagCountsRow extends TagRow {
  source_count: number;
  unread_count: number;
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color as TagColor,
    createdAt: row.created_at.toISOString(),
  };
}

/** A unique-violation on the slug means the user already has this tag. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function listTags(): Promise<TagWithCounts[]> {
  // The counts are scalar subqueries rather than joins: a LEFT JOIN over
  // source_tags and items would multiply rows and need two GROUP BY levels for
  // no gain at this scale.
  const { rows } = await query<TagCountsRow>(`
    SELECT t.id, t.name, t.slug, t.color, t.created_at,
           (SELECT count(*) FROM source_tags st WHERE st.tag_id = t.id)::int AS source_count,
           (SELECT count(*)
              FROM items i
              JOIN source_tags st ON st.source_id = i.source_id
             WHERE st.tag_id = t.id AND i.read_at IS NULL)::int AS unread_count
      FROM tags t
     ORDER BY t.name ASC
  `);

  return rows.map((row) => ({
    ...toTag(row),
    sourceCount: row.source_count,
    unreadCount: row.unread_count,
  }));
}

export async function getTag(id: number): Promise<Tag | null> {
  const { rows } = await query<TagRow>(
    `SELECT id, name, slug, color, created_at FROM tags WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : toTag(rows[0]);
}

export async function getTagsByIds(ids: readonly number[]): Promise<Tag[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<TagRow>(
    `SELECT id, name, slug, color, created_at FROM tags WHERE id = ANY($1::int[]) ORDER BY name`,
    [ids],
  );
  return rows.map(toTag);
}

export async function createTag(input: { name: string; color: TagColor }): Promise<Tag> {
  // Generated server-side; never trust a client-supplied slug.
  const slug = slugify(input.name);

  try {
    const { rows } = await query<TagRow>(
      `INSERT INTO tags (name, slug, color) VALUES ($1, $2, $3)
       RETURNING id, name, slug, color, created_at`,
      [input.name, slug, input.color],
    );
    // The INSERT ... RETURNING always yields exactly one row.
    return toTag(rows[0] as TagRow);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await query<{ id: number }>(`SELECT id FROM tags WHERE slug = $1`, [slug]);
      throw HttpError.conflict(`A tag with the slug "${slug}" already exists`, {
        existingId: existing.rows[0]?.id ?? null,
        slug,
      });
    }
    throw err;
  }
}

export async function updateTag(
  id: number,
  patch: { name?: string; color?: TagColor },
): Promise<Tag | null> {
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (patch.name !== undefined) {
    // A rename regenerates the slug: the slug is derived data, not user input.
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
    params.push(slugify(patch.name));
    sets.push(`slug = $${params.length}`);
  }
  if (patch.color !== undefined) {
    params.push(patch.color);
    sets.push(`color = $${params.length}`);
  }

  if (sets.length === 0) return getTag(id);

  params.push(id);

  try {
    const { rows } = await query<TagRow>(
      `UPDATE tags SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, slug, color, created_at`,
      params,
    );
    return rows[0] === undefined ? null : toTag(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw HttpError.conflict('Another tag already uses that name');
    }
    throw err;
  }
}

export interface TagDeletionResult {
  deleted: boolean;
  /** Widgets whose `config.tagIds` referenced the tag, so the UI can warn. */
  affectedWidgets: number;
  affectedRules: number;
  affectedSources: number;
}

/**
 * Delete a tag and every reference to it, in one transaction.
 *
 * `source_tags` cascades, but `rules.tag_filter` and `widgets.config.tagIds` are
 * arrays inside columns -- PostgreSQL has no foreign keys for those, so the
 * cleanup is application-level and must not be allowed to half-apply
 * (01-SPEC-data-model.md 2).
 */
export async function deleteTag(id: number): Promise<TagDeletionResult> {
  return transaction(async (client: PoolClient) => {
    const sources = await client.query(`DELETE FROM source_tags WHERE tag_id = $1`, [id]);

    const rules = await client.query(
      `UPDATE rules SET tag_filter = array_remove(tag_filter, $1) WHERE $1 = ANY(tag_filter)`,
      [id],
    );

    // Rebuild the array without the id rather than deleting the key: a feed
    // widget with no tagIds means "all sources", which is a different filter.
    const widgets = await client.query(
      `UPDATE widgets w
          SET config = jsonb_set(
                w.config,
                '{tagIds}',
                coalesce((
                  SELECT jsonb_agg(v)
                    FROM jsonb_array_elements(w.config->'tagIds') AS v
                   WHERE v <> to_jsonb($1::int)
                ), '[]'::jsonb)
              )
        WHERE w.config->'tagIds' @> to_jsonb($1::int)`,
      [id],
    );

    const deleted = await client.query(`DELETE FROM tags WHERE id = $1`, [id]);

    return {
      deleted: (deleted.rowCount ?? 0) > 0,
      affectedWidgets: widgets.rowCount ?? 0,
      affectedRules: rules.rowCount ?? 0,
      affectedSources: sources.rowCount ?? 0,
    };
  });
}

/**
 * Get or create a tag per name, keyed by the returned slug.
 *
 * Used by OPML import, where folder names become tags. Two folders that differ
 * only in case or punctuation collapse to one tag, which is the point of the slug.
 */
export async function ensureTagsByName(names: readonly string[]): Promise<Map<string, Tag>> {
  const bySlug = new Map<string, Tag>();

  const wanted = new Map<string, string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed === '') continue;
    const slug = slugify(trimmed);
    // A name with no alphanumerics cannot produce a slug; skip rather than
    // inserting a row that would collide with the next such name.
    if (slug === '') continue;
    if (!wanted.has(slug)) wanted.set(slug, trimmed);
  }

  if (wanted.size === 0) return bySlug;

  // Insert what is missing, then read the full set back: ON CONFLICT DO NOTHING
  // returns nothing for rows that already existed, so one INSERT is not enough.
  await query(
    `INSERT INTO tags (name, slug)
     SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (slug) DO NOTHING`,
    [[...wanted.values()], [...wanted.keys()]],
  );

  const { rows } = await query<TagRow>(
    `SELECT id, name, slug, color, created_at FROM tags WHERE slug = ANY($1::text[])`,
    [[...wanted.keys()]],
  );

  for (const row of rows) bySlug.set(row.slug, toTag(row));
  return bySlug;
}

/** Reject tag ids that do not exist before they reach a foreign key. */
export async function assertTagsExist(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;

  const { rows } = await query<{ id: number }>(`SELECT id FROM tags WHERE id = ANY($1::int[])`, [
    ids,
  ]);
  const found = new Set(rows.map((row) => row.id));
  const missing = [...new Set(ids)].filter((id) => !found.has(id));

  if (missing.length > 0) {
    throw HttpError.validation('Unknown tag ids', { tagIds: missing });
  }
}
