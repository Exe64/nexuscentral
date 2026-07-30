import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Rules } from '../src/pages/Rules.tsx';
import { Reader } from '../src/pages/Reader.tsx';
import { makeItem, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY_TAGS = { body: { data: [] } };

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'CVE mentions',
    pattern: 'CVE-\\d{4}',
    flags: 'i',
    scope: 'both',
    weight: 5,
    alert: true,
    active: true,
    tagFilter: [],
    lastError: null,
    lastErrorAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the rules list', () => {
  it('invites the user to add a first rule', async () => {
    stubApi({ 'GET /api/rules': { body: { data: [] } }, 'GET /api/tags': EMPTY_TAGS });

    renderPage(<Rules />);

    expect(
      await screen.findByText('No rules yet. Rules boost or bury items by keyword.'),
    ).toBeDefined();
  });

  it('shows a rule with its pattern and weight', async () => {
    stubApi({
      'GET /api/rules': { body: { data: [rule({ weight: -3, alert: false })] } },
      'GET /api/tags': EMPTY_TAGS,
    });

    renderPage(<Rules />);

    expect(await screen.findByText('CVE mentions')).toBeDefined();
    expect(screen.getByText('CVE-\\d{4}')).toBeDefined();
    expect(screen.getByText('-3')).toBeDefined();
  });

  it('explains a rule the matcher disabled', async () => {
    stubApi({
      'GET /api/rules': {
        body: {
          data: [
            rule({
              active: false,
              lastError:
                'Pattern exceeded the 50ms matching budget on a single item and was disabled.',
              lastErrorAt: '2026-07-30T09:00:00.000Z',
            }),
          ],
        },
      },
      'GET /api/tags': EMPTY_TAGS,
    });

    renderPage(<Rules />);

    // A rule that silently stopped applying would be worse than a visibly broken one.
    expect(await screen.findByText(/Disabled automatically/)).toBeDefined();
    expect(screen.getByText(/50ms matching budget/)).toBeDefined();
  });
});

describe('the live test panel', () => {
  it('says nothing until there is a pattern to test', async () => {
    const stub = stubApi({ 'GET /api/rules': { body: { data: [] } }, 'GET /api/tags': EMPTY_TAGS });

    renderPage(<Rules />);

    expect(await screen.findByText('Enter a pattern to test it.')).toBeDefined();
    expect(stub.calls).not.toContain('POST /api/rules/test');
  });

  it('reports match counts against real items as the user types', async () => {
    // The acceptance criterion.
    stubApi({
      'GET /api/rules': { body: { data: [] } },
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/rules/test': {
        body: {
          valid: true,
          matchCount: 17,
          sampleSize: 300,
          matches: [
            {
              itemId: '8412',
              title: 'Nutanix publishes CVE-2026-31337 advisory',
              sourceTitle: 'Nutanix Blog',
              highlight: { field: 'title', start: 18, end: 26 },
            },
          ],
        },
      },
    });

    renderPage(<Rules />);
    await userEvent.type(await screen.findByLabelText(/^Pattern/), 'CVE');

    expect(await screen.findByText('17 of 300 recent items match.')).toBeDefined();
    expect(screen.getByText('Nutanix Blog · in title')).toBeDefined();
    // The matched span is marked, not just the row.
    expect(screen.getByText('CVE-2026').tagName).toBe('MARK');
  });

  it('says the rule would do nothing when nothing matches', async () => {
    stubApi({
      'GET /api/rules': { body: { data: [] } },
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/rules/test': {
        body: { valid: true, matchCount: 0, sampleSize: 300, matches: [] },
      },
    });

    renderPage(<Rules />);
    await userEvent.type(await screen.findByLabelText(/^Pattern/), 'zzz');

    expect(
      await screen.findByText('No recent items match. The rule would do nothing today.'),
    ).toBeDefined();
  });

  it('reports an unsafe pattern without breaking the panel', async () => {
    stubApi({
      'GET /api/rules': { body: { data: [] } },
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/rules/test': {
        body: {
          valid: false,
          error: '"(\\w+)+" repeats a group that already repeats without bound.',
        },
      },
    });

    renderPage(<Rules />);
    await userEvent.type(await screen.findByLabelText(/^Pattern/), '(x+)+');

    // The user is mid-edit; this is data, not an error state.
    expect(await screen.findByText(/repeats a group that already repeats/)).toBeDefined();
  });

  it('debounces, so a typed pattern costs one request and not one per key', async () => {
    const stub = stubApi({
      'GET /api/rules': { body: { data: [] } },
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/rules/test': {
        body: { valid: true, matchCount: 1, sampleSize: 300, matches: [] },
      },
    });

    renderPage(<Rules />);
    // `{` opens a key descriptor in userEvent, so a literal brace is doubled.
    await userEvent.type(await screen.findByLabelText(/^Pattern/), 'CVE-\\d{{4}');

    await waitFor(() => {
      expect(stub.calls.filter((call) => call === 'POST /api/rules/test').length).toBeGreaterThan(
        0,
      );
    });

    const requests = stub.calls.filter((call) => call === 'POST /api/rules/test').length;
    expect(requests).toBeLessThan(4);
  });
});

describe('creating a rule', () => {
  it('sends the whole form and reports that scores are being recomputed', async () => {
    const stub = stubApi({
      'GET /api/rules': { body: { data: [] } },
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/rules': { status: 201, body: { data: rule() } },
      'POST /api/rules/test': {
        body: { valid: true, matchCount: 1, sampleSize: 300, matches: [] },
      },
    });

    renderPage(<Rules />);

    await userEvent.type(await screen.findByLabelText('Name'), 'CVE mentions');
    await userEvent.type(screen.getByLabelText(/^Pattern/), 'CVE-\\d{{4}');
    await userEvent.clear(screen.getByLabelText('Weight'));
    await userEvent.type(screen.getByLabelText('Weight'), '5');
    await userEvent.click(screen.getByLabelText('Notify me when this matches'));
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => {
      expect(stub.calls).toContain('POST /api/rules');
    });

    const post = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/rules' && (init as RequestInit | undefined)?.method === 'POST',
      );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      name: 'CVE mentions',
      pattern: 'CVE-\\d{4}',
      flags: 'i',
      scope: 'both',
      weight: 5,
      alert: true,
      tagFilter: [],
    });

    expect(await screen.findByText(/Scores are being recomputed/)).toBeDefined();
  });

  it('shows the server message when a pattern is rejected', async () => {
    stubApi({
      'GET /api/rules': { body: { data: [] } },
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/rules': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message:
              '"(\\w+)+" repeats a group that already repeats without bound. Rewrite it with one quantifier.',
          },
        },
      },
      'POST /api/rules/test': { body: { valid: true, matchCount: 0, sampleSize: 0, matches: [] } },
    });

    renderPage(<Rules />);
    await userEvent.type(await screen.findByLabelText('Name'), 'Bad');
    await userEvent.type(screen.getByLabelText(/^Pattern/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByText(/Rewrite it with one quantifier/)).toBeDefined();
  });
});

describe('the score breakdown popover', () => {
  it('explains every term and names the rules that fired', async () => {
    // The acceptance criterion.
    stubApi({
      'GET /api/items': { body: { data: [makeItem({ score: 8.42 })], nextCursor: null } },
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': { body: { data: [] } },
      'GET /api/items/1': {
        body: {
          data: {
            ...makeItem({ score: 8.42 }),
            liveScore: 8.42,
            breakdown: {
              base: 1,
              rules: [{ id: 3, name: 'CVE mentions', weight: 5 }],
              engagement: 1.35,
              sourceWeight: 1.5,
              recencyDecay: 0.79,
            },
          },
        },
      },
    });

    renderPage(<Reader />);

    await userEvent.click(await screen.findByRole('button', { name: 'Explain' }));

    const popover = await screen.findByRole('dialog', { name: 'Why this score' });
    expect(popover).toBeDefined();
    expect(screen.getByText('CVE mentions: +5.00')).toBeDefined();
    expect(screen.getByText(/1\.00 \+ 5\.00 \+ 1\.35.*1\.50.*0\.79/)).toBeDefined();
  });

  it('explains the gap between the stored score and the recomputed one', async () => {
    stubApi({
      'GET /api/items': { body: { data: [makeItem({ score: 8.42 })], nextCursor: null } },
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': { body: { data: [] } },
      'GET /api/items/1': {
        body: {
          data: {
            ...makeItem({ score: 8.42 }),
            liveScore: 7.9,
            breakdown: {
              base: 1,
              rules: [],
              engagement: 0,
              sourceWeight: 1,
              recencyDecay: 0.79,
            },
          },
        },
      },
    });

    renderPage(<Reader />);
    await userEvent.click(await screen.findByRole('button', { name: 'Explain' }));

    // Reporting the drift rather than hiding it.
    expect(await screen.findByText(/Stored score: 8\.42\. Recomputed now: 7\.90\./)).toBeDefined();
    expect(screen.getByText(/recency term keeps falling/)).toBeDefined();
  });

  it('says plainly when no rule matched', async () => {
    stubApi({
      'GET /api/items': { body: { data: [makeItem({ score: 1 })], nextCursor: null } },
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': { body: { data: [] } },
      'GET /api/items/1': {
        body: {
          data: {
            ...makeItem({ score: 1 }),
            liveScore: 1,
            breakdown: { base: 1, rules: [], engagement: 0, sourceWeight: 1, recencyDecay: 1 },
          },
        },
      },
    });

    renderPage(<Reader />);
    await userEvent.click(await screen.findByRole('button', { name: 'Explain' }));

    expect(await screen.findByText('No rule matched.')).toBeDefined();
  });
});
