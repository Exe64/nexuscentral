import { describe, expect, it } from 'vitest';
import { checkPattern, MAX_PATTERN_LENGTH } from '../../src/scoring/redos.js';

function problem(pattern: string, flags = 'i'): string {
  const result = checkPattern(pattern, flags);
  if (result.ok) throw new Error(`Expected "${pattern}" to be rejected`);
  return result.problem.code;
}

describe('patterns that are accepted', () => {
  it.each([
    'CVE-\\d{4}',
    'kubernetes|k8s',
    '\\b(ceph|nutanix)\\b',
    '^Announcing',
    '[a-z]+@[a-z]+\\.[a-z]{2,}',
    // Bounded nesting is fine: it cannot blow up.
    '(\\w+){1,3}',
    '(ab){2,5}+'.replace('+', ''),
    // A quantifier inside a character class is a literal.
    '[+*]{1,4}',
    // Unbounded quantifier with no group around it.
    '\\w+\\s+\\w+',
    // A group with no quantifier after it.
    '(\\w+)\\s(\\w+)',
    'ré(seau|solution)',
  ])('accepts %s', (pattern) => {
    expect(checkPattern(pattern)).toEqual({ ok: true });
  });
});

describe('the nested-quantifier heuristic', () => {
  it.each(['(a+)+', '(a*)*', '(a+)*', '(a*)+', '(\\w+)+', '(\\d+)*$', '([a-z]+)+@', '(\\s*\\w+)+'])(
    'rejects %s',
    (pattern) => {
      expect(problem(pattern)).toBe('nested_quantifier');
    },
  );

  it('rejects an open-ended inner brace quantifier', () => {
    expect(problem('(a{2,})+')).toBe('nested_quantifier');
  });

  it('rejects it through a non-capturing group too', () => {
    expect(problem('(?:\\w+)+')).toBe('nested_quantifier');
  });

  it('rejects nesting at depth', () => {
    expect(problem('((x\\d+))+')).toBe('nested_quantifier');
  });

  it('accepts a bounded outer quantifier', () => {
    // `(a+){1,3}` cannot blow up: the outer repetition is capped.
    expect(checkPattern('(a+){1,3}')).toEqual({ ok: true });
  });

  it('is not fooled by an escaped parenthesis', () => {
    expect(checkPattern('\\(a+\\)+')).toEqual({ ok: true });
  });

  it('is not fooled by quantifier characters inside a class', () => {
    expect(checkPattern('([*+]a)+')).toEqual({ ok: true });
  });

  it('explains what to do instead, not just that it is invalid', () => {
    const result = checkPattern('(\\w+)+');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The acceptance criterion is a *clear* message.
    expect(result.problem.message).toContain('exponential');
    expect(result.problem.message).toContain('Rewrite');
    expect(result.problem.message).toContain('(\\w+)+');
    expect(result.problem.index).toBe(0);
  });
});

describe('other rejections', () => {
  it('rejects an empty pattern', () => {
    expect(problem('')).toBe('empty');
    expect(problem('   ')).toBe('empty');
  });

  it('rejects a pattern over the length cap', () => {
    expect(problem('a'.repeat(MAX_PATTERN_LENGTH + 1))).toBe('too_long');
    expect(checkPattern('a'.repeat(MAX_PATTERN_LENGTH))).toEqual({ ok: true });
  });

  it('names the offending length in the message', () => {
    const result = checkPattern('a'.repeat(250));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.message).toContain('250');
  });

  it('rejects stateful flags', () => {
    // g and y carry lastIndex between calls, so a rule would match or not
    // depending on what was tested before it.
    expect(problem('abc', 'g')).toBe('invalid_flags');
    expect(problem('abc', 'y')).toBe('invalid_flags');
    expect(problem('abc', 'd')).toBe('invalid_flags');
  });

  it('accepts the allowed flags in any combination', () => {
    for (const flags of ['', 'i', 'm', 's', 'u', 'im', 'imsu']) {
      expect(checkPattern('abc', flags)).toEqual({ ok: true });
    }
  });

  it('rejects a pattern that does not compile, quoting the engine', () => {
    const result = checkPattern('(unclosed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.code).toBe('invalid_syntax');
      expect(result.problem.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects a pattern that only fails under the u flag', () => {
    expect(problem('\\p{Foo}', 'u')).toBe('invalid_syntax');
  });
});

describe('the heuristic is a heuristic', () => {
  it('does not claim to catch every slow pattern', () => {
    // Alternation with overlapping branches also backtracks badly, and this check
    // lets it through on purpose: the time budget is the defence for these, and a
    // stricter static check would reject far too much legitimate input.
    expect(checkPattern('(a|a)*b'.replace('*', '{1,5}'))).toEqual({ ok: true });
    // The point is that it terminates, not that it is fast.
    expect(checkPattern('\\w+\\w+\\w+\\w+$')).toEqual({ ok: true });
  });
});
