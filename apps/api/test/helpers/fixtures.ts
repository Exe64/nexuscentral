import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Logger, Source } from '@feedhub/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** Read a recorded fixture. Adapter tests never touch the network. */
export function fixture(kind: string, name: string): string {
  return readFileSync(join(here, '..', 'fixtures', kind, name), 'utf8');
}

/** A source with sane defaults, overridable per test. */
export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 1,
    kind: 'rss',
    title: 'Test Feed',
    identifier: 'https://example.com/feed.xml',
    siteUrl: 'https://example.com',
    iconUrl: null,
    weight: 1,
    active: true,
    pollInterval: '15 minutes',
    tags: [],
    health: {
      lastRunAt: null,
      lastOkAt: null,
      lastError: null,
      consecutiveFailures: 0,
      consecutiveEmpty: 0,
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

export interface RecordedLog {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  obj: unknown;
  msg?: string | undefined;
}

/** A Logger that records instead of writing, so tests can assert on WARN lines. */
export function recordingLogger(): { logger: Logger; records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const at =
    (level: RecordedLog['level']) =>
    (obj: unknown, msg?: string): void => {
      records.push({ level, obj, msg });
    };

  return {
    records,
    logger: {
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    },
  };
}
