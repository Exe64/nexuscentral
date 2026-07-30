import { afterEach, describe, expect, it } from 'vitest';
import { ITEM_BUDGET_MS, RuleMatcher } from '../../src/scoring/matcher.js';
import type { MatchableItem, RuleSpec } from '../../src/scoring/types.js';

let matcher: RuleMatcher | undefined;

afterEach(async () => {
  await matcher?.stop();
  matcher = undefined;
});

function rule(overrides: Partial<RuleSpec> = {}): RuleSpec {
  return {
    id: 1,
    name: 'CVE mentions',
    pattern: 'CVE-\\d{4}',
    flags: 'i',
    scope: 'both',
    tagFilter: [],
    weight: 5,
    ...overrides,
  };
}

function item(overrides: Partial<MatchableItem> = {}): MatchableItem {
  return {
    title: 'Nutanix publishes CVE-2026-31337 advisory',
    summary: 'A privilege escalation issue affects Prism Central.',
    author: 'security_team',
    tagIds: [],
    ...overrides,
  };
}

describe('RuleMatcher', () => {
  it('matches a rule across title and summary', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([rule()]);

    const outcome = await matcher.match([
      item(),
      item({ title: 'Sizing NVMe tiers', summary: 'No advisory here.' }),
    ]);

    expect(outcome.matchedRuleIds).toEqual([[1], []]);
    expect(outcome.timedOut).toEqual([]);
  });

  it('honours each scope', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([
      rule({ id: 1, scope: 'title', pattern: 'CVE' }),
      rule({ id: 2, scope: 'summary', pattern: 'privilege' }),
      rule({ id: 3, scope: 'author', pattern: 'security' }),
      rule({ id: 4, scope: 'both', pattern: 'escalation' }),
    ]);

    const outcome = await matcher.match([item()]);

    // Scope 'both' spans title and summary but never the author.
    expect(outcome.matchedRuleIds[0]?.sort()).toEqual([1, 2, 3, 4]);
  });

  it('does not let a summary match a title-scoped rule', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([rule({ scope: 'title', pattern: 'privilege' })]);

    const outcome = await matcher.match([item()]);
    expect(outcome.matchedRuleIds).toEqual([[]]);
  });

  it('applies a tag filter', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([rule({ tagFilter: [7, 9] })]);

    const outcome = await matcher.match([
      item({ tagIds: [9] }),
      item({ tagIds: [3] }),
      item({ tagIds: [] }),
    ]);

    // Non-empty filter means "only sources carrying one of these tags".
    expect(outcome.matchedRuleIds).toEqual([[1], [], []]);
  });

  it('treats an empty tag filter as "every source"', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([rule({ tagFilter: [] })]);

    const outcome = await matcher.match([item({ tagIds: [] }), item({ tagIds: [42] })]);
    expect(outcome.matchedRuleIds).toEqual([[1], [1]]);
  });

  it('handles a null summary and author without matching an empty string', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([
      rule({ id: 1, scope: 'summary', pattern: '^$' }),
      rule({ id: 2, scope: 'author', pattern: 'anyone' }),
    ]);

    const outcome = await matcher.match([
      item({ summary: null, author: null, title: 'Only a title' }),
    ]);

    // `^$` does match an empty subject -- that is correct regex behaviour and the
    // user's problem, not ours. The author rule must not match nothing.
    expect(outcome.matchedRuleIds[0]).toEqual([1]);
  });

  it('returns no matches when there are no rules', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([]);

    const outcome = await matcher.match([item(), item()]);
    expect(outcome.matchedRuleIds).toEqual([[], []]);
  });

  it('is stateless across calls despite reusing compiled patterns', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([rule({ pattern: 'CVE' })]);

    // A pattern compiled with the g flag would carry lastIndex between calls and
    // match only every other time. Those flags are rejected upstream; this proves
    // the consequence.
    for (let i = 0; i < 5; i += 1) {
      const outcome = await matcher.match([item()]);
      expect(outcome.matchedRuleIds).toEqual([[1]]);
    }
  });

  it('picks up a replaced rule set', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([rule({ id: 1, pattern: 'CVE' })]);
    expect((await matcher.match([item()])).matchedRuleIds).toEqual([[1]]);

    await matcher.setRules([rule({ id: 2, pattern: 'nothing here' })]);
    expect((await matcher.match([item()])).matchedRuleIds).toEqual([[]]);
  });
});

describe('the per-item time budget', () => {
  it('kills a catastrophically backtracking rule and names it', async () => {
    // This is the pattern the static heuristic exists to reject at creation. It is
    // used here on purpose: the budget is the defence for one that slipped through,
    // for instance a rule stored before the heuristic existed.
    matcher = new RuleMatcher();
    await matcher.setRules([
      rule({ id: 42, pattern: '(a+)+$', scope: 'title' }),
      rule({ id: 7, pattern: 'harmless', scope: 'title' }),
    ]);

    const startedAt = Date.now();
    const outcome = await matcher.match([
      { title: `${'a'.repeat(40)}b`, summary: null, author: null, tagIds: [] },
    ]);
    const elapsed = Date.now() - startedAt;

    expect(outcome.timedOut).toHaveLength(1);
    expect(outcome.timedOut[0]?.ruleId).toBe(42);
    // The whole point: bounded time, not "eventually".
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);

  it('finishes the rest of the batch after dropping the offender', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules([
      rule({ id: 42, pattern: '(a+)+$', scope: 'title' }),
      rule({ id: 7, pattern: 'Nutanix', scope: 'title' }),
    ]);

    const items: MatchableItem[] = [
      item({ title: 'Nutanix one' }),
      // The item that hangs.
      { title: `${'a'.repeat(40)}b`, summary: null, author: null, tagIds: [] },
      item({ title: 'Nutanix two' }),
      item({ title: 'Nutanix three' }),
    ];

    const outcome = await matcher.match(items);

    expect(outcome.timedOut[0]?.ruleId).toBe(42);
    // One result per input item, in order, whatever happened in between.
    expect(outcome.matchedRuleIds).toHaveLength(4);
    // The two items after the hang were still processed, without the dead rule.
    expect(outcome.matchedRuleIds[2]).toEqual([7]);
    expect(outcome.matchedRuleIds[3]).toEqual([7]);
  }, 20_000);

  it('does not flag a slow but bounded run as a timeout', async () => {
    matcher = new RuleMatcher();
    await matcher.setRules(
      // Fifty ordinary rules over a long subject: real work, well inside budget.
      Array.from({ length: 50 }, (_unused, index) =>
        rule({ id: index + 1, pattern: `token${index}`, scope: 'both' }),
      ),
    );

    const long = 'lorem ipsum dolor sit amet '.repeat(200);
    const outcome = await matcher.match(
      Array.from({ length: 50 }, () => item({ title: 'token7 here', summary: long })),
    );

    expect(outcome.timedOut).toEqual([]);
    expect(outcome.matchedRuleIds).toHaveLength(50);
    expect(outcome.matchedRuleIds[0]).toEqual([8]);
  });

  it('exposes the budget it enforces', () => {
    expect(ITEM_BUDGET_MS).toBe(50);
  });
});
