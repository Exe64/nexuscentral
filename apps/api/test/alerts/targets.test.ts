/**
 * How a batch of alerts turns into a request, per target.
 *
 * The assertions worth having are the ones about a *batch*: one notification for
 * forty matches is the acceptance criterion, and the shape of that one message is
 * what makes it useful rather than a wall of text.
 */

import { describe, expect, it } from 'vitest';
import { buildRequest, __testing } from '../../src/alerts/targets.js';
import type { PendingAlert } from '../../src/db/alerts.js';

function alert(n: number, overrides: Partial<PendingAlert> = {}): PendingAlert {
  return {
    id: String(n),
    itemTitle: `CVE-2026-000${n} in the storage layer`,
    itemUrl: `https://example.com/${n}`,
    itemSummary: 'A summary.',
    sourceTitle: 'Nutanix Blog',
    ruleName: 'CVE mentions',
    score: 9.1,
    createdAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

const many = (n: number): PendingAlert[] => Array.from({ length: n }, (_, i) => alert(i + 1));

function bodyOf(init: RequestInit): string {
  return typeof init.body === 'string' ? init.body : '';
}

describe('none', () => {
  it('builds nothing at all', () => {
    expect(buildRequest('none', 'https://example.com', { alerts: many(3) })).toBeNull();
  });
});

describe('ntfy', () => {
  it('puts the message in the body and everything else in headers', () => {
    const request = buildRequest('ntfy', 'https://ntfy.sh/mytopic', { alerts: [alert(1)] });

    expect(request?.url).toBe('https://ntfy.sh/mytopic');
    expect(request?.init.method).toBe('POST');
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.Title).toContain('CVE mentions');
    expect(headers.Priority).toBe('high');
    // A single alert is clickable straight to the item.
    expect(headers.Click).toBe('https://example.com/1');
    expect(bodyOf(request?.init ?? {})).toContain('CVE-2026-0001');
  });

  it('drops the click target for a grouped notification', () => {
    // Linking to one of forty items would be arbitrary.
    const request = buildRequest('ntfy', 'https://ntfy.sh/t', { alerts: many(5) });
    expect((request?.init.headers as Record<string, string>).Click).toBeUndefined();
  });

  it('keeps the title header inside latin-1', () => {
    const request = buildRequest('ntfy', 'https://ntfy.sh/t', {
      alerts: [alert(1, { ruleName: 'Sécurité — émojis 🔥' })],
    });
    const title = (request?.init.headers as Record<string, string>).Title ?? '';
    // A non-latin-1 header value makes fetch throw, which would turn a cosmetic
    // problem into a delivery failure.
    expect(/^[\x20-\x7e]*$/.test(title)).toBe(true);
  });
});

describe('gotify', () => {
  it('sends title, message and priority as JSON', () => {
    const request = buildRequest('gotify', 'https://gotify.example.com/message?token=abc', {
      alerts: many(3),
    });

    expect(request?.url).toBe('https://gotify.example.com/message?token=abc');
    const payload = JSON.parse(bodyOf(request?.init ?? {})) as Record<string, unknown>;
    expect(payload.title).toContain('3');
    expect(String(payload.message)).toContain('CVE-2026-0001');
    expect(payload.priority).toBe(8);
  });

  it('uses the URL exactly as configured', () => {
    // No path appending: a URL behind a subpath proxy would break, and a 404 from
    // a path the user never typed is impossible to debug.
    const request = buildRequest('gotify', 'https://g.example.com/sub/message?token=x', {
      alerts: [alert(1)],
    });
    expect(request?.url).toBe('https://g.example.com/sub/message?token=x');
  });
});

describe('discord', () => {
  it('uses one embed per alert when there are few', () => {
    const request = buildRequest('discord', 'https://discord.com/api/webhooks/x', {
      alerts: many(3),
    });
    const payload = JSON.parse(bodyOf(request?.init ?? {})) as {
      content: string;
      embeds: { title: string; url: string }[];
    };

    expect(payload.embeds).toHaveLength(3);
    expect(payload.embeds[0]?.url).toBe('https://example.com/1');
  });

  it('falls back to a text list past the ten-embed limit', () => {
    // Discord rejects a message with more than 10 embeds outright.
    const request = buildRequest('discord', 'https://discord.com/api/webhooks/x', {
      alerts: many(40),
    });
    const payload = JSON.parse(bodyOf(request?.init ?? {})) as {
      content: string;
      embeds?: unknown[];
    };

    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toContain('40');
  });
});

describe('generic', () => {
  it('sends the whole batch unformatted', () => {
    const request = buildRequest('generic', 'https://example.com/hook', { alerts: many(2) });
    const payload = JSON.parse(bodyOf(request?.init ?? {})) as {
      count: number;
      alerts: PendingAlert[];
      test: boolean;
    };

    expect(payload.count).toBe(2);
    expect(payload.alerts[0]?.itemUrl).toBe('https://example.com/1');
    expect(payload.test).toBe(false);
  });
});

describe('one notification for many alerts', () => {
  it('names the rule when every match came from the same one', () => {
    expect(__testing.title({ alerts: many(40) })).toContain('40 matches for CVE mentions');
  });

  it('just counts when the matches came from different rules', () => {
    const mixed = [alert(1), alert(2, { ruleName: 'Nutanix releases' })];
    expect(__testing.title({ alerts: mixed })).toBe('nexuscentral: 2 alerts');
  });

  it('summarises rather than truncating mid-entry', () => {
    const body = __testing.trimmedBody({ alerts: many(200) });

    expect(body.length).toBeLessThanOrEqual(__testing.MAX_BODY + 120);
    expect(body).toMatch(/and \d+ more/);
    // The last entry shown is whole, not cut in half.
    const beforeSummary = body.split('\n\n… and')[0] ?? '';
    expect(beforeSummary.trimEnd().endsWith('/')).toBe(false);
  });

  it('leaves a small batch alone', () => {
    const body = __testing.trimmedBody({ alerts: many(3) });
    expect(body).not.toMatch(/and \d+ more/);
    expect(body).toContain('CVE-2026-0003');
  });
});

describe('the test notification', () => {
  it('says what it is, and carries no alerts', () => {
    const request = buildRequest('ntfy', 'https://ntfy.sh/t', { alerts: [], test: true });
    expect((request?.init.headers as Record<string, string>).Title).toContain('test');
    expect(bodyOf(request?.init ?? {})).toContain('configured correctly');
  });

  it('is marked as a test for a generic receiver', () => {
    const request = buildRequest('generic', 'https://example.com/hook', {
      alerts: [],
      test: true,
    });
    const payload = JSON.parse(bodyOf(request?.init ?? {})) as { test: boolean };
    expect(payload.test).toBe(true);
  });
});
