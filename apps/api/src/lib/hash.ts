/**
 * The deduplication key (02-SPEC-ingestion.md 4).
 *
 *   content_hash = sha256(kind + '|' + identifier + '|' + (guid ?? canonicalize(url)))
 *
 * The hash includes the source, so the same article arriving from two feeds
 * appears twice. That is deliberate: cross-source dedup would hide the fact that
 * a story is spreading.
 */

import { createHash } from 'node:crypto';
import type { SourceKind } from '@feedhub/shared';
import { canonicalize } from './canonicalize.js';

export interface ContentHashInput {
  kind: SourceKind;
  identifier: string;
  /** Adapter-supplied stable id. Preferred over the URL when present. */
  guid?: string | undefined;
  url: string;
}

export function contentHash({ kind, identifier, guid, url }: ContentHashInput): Buffer {
  // An adapter that supplies a guid is asserting it is stable; trust it over a
  // URL, which can change when a CMS rewrites its permalinks.
  const discriminator = guid !== undefined && guid.length > 0 ? guid : canonicalize(url);
  return createHash('sha256').update(`${kind}|${identifier}|${discriminator}`, 'utf8').digest();
}
