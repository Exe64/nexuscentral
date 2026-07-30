/**
 * A tag, rendered in its colour.
 *
 * Reads `--tag-{colour}-bg` / `-fg`, which the contrast test holds to 4.5:1 in both
 * themes. Nothing here picks a colour itself.
 */

import type { ReactNode } from 'react';
import type { Tag } from '@feedhub/shared';

export function TagChip({ tag, count }: { tag: Tag; count?: number }): ReactNode {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs leading-tight"
      style={{
        backgroundColor: `var(--tag-${tag.color}-bg)`,
        color: `var(--tag-${tag.color}-fg)`,
      }}
    >
      {tag.name}
      {count !== undefined && <span className="tabular-nums opacity-80">{count}</span>}
    </span>
  );
}
