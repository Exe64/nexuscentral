/**
 * The update indicator in the application bar.
 *
 * It appears only when there is something to act on. A permanent badge reading
 * "up to date" is chrome that says nothing 99% of the time, and chrome that says
 * nothing is chrome you stop seeing -- so it would be missing precisely on the
 * day it mattered.
 *
 * `unknown` deliberately shows nothing either. It is the *normal* state of a dev
 * run, which has no build sha, and a badge that is permanently lit outside
 * production is the same failure by another route.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { UpdateInfo } from '@nexuscentral/shared';
import { useUpdateStatus } from '../api/queries.ts';
import { useT } from '../i18n.tsx';

export interface Indicator {
  /** Key under `topbar.update.` */
  key: 'available' | 'running' | 'unclaimed' | 'failed';
  className: string;
  glyph: string;
}

/**
 * What the bar should show, or nothing at all.
 *
 * The run outranks the comparison: after a failed deploy the check still says
 * "update available", and "the last attempt failed" is the more useful of the
 * two facts. Same during a run -- what is happening beats what could.
 */
export function indicatorFor(info: UpdateInfo | undefined): Indicator | null {
  if (info === undefined) return null;

  switch (info.run.state) {
    case 'requested':
    case 'running':
      return { key: 'running', className: 'text-accent', glyph: '↻' };
    case 'unclaimed':
      return { key: 'unclaimed', className: 'text-warning', glyph: '!' };
    case 'failed':
      return { key: 'failed', className: 'text-negative', glyph: '!' };
    default:
      break;
  }

  return info.state === 'update_available'
    ? { key: 'available', className: 'text-warning', glyph: '●' }
    : null;
}

export function UpdateIndicator(): ReactNode {
  const t = useT();
  const status = useUpdateStatus();
  const indicator = indicatorFor(status.data);

  if (indicator === null) return null;

  const label = t(`topbar.update.${indicator.key}`);

  return (
    <Link
      // The hash is what the Updates panel scrolls to, so this lands on the
      // answer rather than at the top of a long settings page.
      to="/settings#updates"
      title={label}
      aria-label={label}
      className={`${indicator.className} hover:bg-hovered flex items-center gap-1.5 rounded px-2 py-1 text-sm transition-colors`}
    >
      <span aria-hidden="true">{indicator.glyph}</span>
      {/* The glyph alone is ambiguous, and the bar is crowded on a phone. The
          accessible name carries the words either way. */}
      <span className="hidden md:inline">{label}</span>
    </Link>
  );
}
