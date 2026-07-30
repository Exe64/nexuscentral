/**
 * Pattern safety (02-SPEC-ingestion.md 5.3).
 *
 * Rule patterns are user-supplied regexes and a ReDoS surface. Three defences,
 * in order of cost:
 *
 * 1. A length cap and a static heuristic, at the API boundary, with a message
 *    that says what is wrong rather than "invalid pattern".
 * 2. Compiling once per batch rather than once per item.
 * 3. A time budget enforced in a worker thread, which is the only defence that
 *    actually stops a pattern already running.
 *
 * This file is (1). It is a heuristic and says so: it rejects the shapes that
 * cause catastrophic backtracking in practice, not every pattern that could.
 */

export const MAX_PATTERN_LENGTH = 200;
export const ALLOWED_FLAGS = 'imsu';

export interface PatternProblem {
  code: 'too_long' | 'invalid_flags' | 'invalid_syntax' | 'nested_quantifier' | 'empty';
  message: string;
  /** Where in the pattern the problem is, when that is known. */
  index?: number;
}

export type PatternCheck = { ok: true } | { ok: false; problem: PatternProblem };

/**
 * An unbounded quantifier: one that can match arbitrarily many times. `{2,5}` is
 * bounded and safe to nest; `+`, `*` and `{2,}` are not.
 */
interface Quantifier {
  index: number;
  unbounded: boolean;
  length: number;
}

function readQuantifier(pattern: string, at: number): Quantifier | null {
  const char = pattern[at];

  if (char === '+' || char === '*') {
    // A trailing `?` only makes it lazy, which does not bound the repetition.
    const lazy = pattern[at + 1] === '?';
    return { index: at, unbounded: true, length: lazy ? 2 : 1 };
  }

  if (char === '{') {
    const close = pattern.indexOf('}', at);
    if (close === -1) return null;
    const body = pattern.slice(at + 1, close);
    const match = /^(\d*)(,?)(\d*)$/.exec(body);
    if (match === null) return null;

    const [, min, comma, max] = match;
    if (min === '' && max === '') return null;

    // `{2,}` is open-ended; `{2,5}` and `{3}` are not.
    const unbounded = comma === ',' && max === '';
    const lazy = pattern[close + 1] === '?';
    return { index: at, unbounded, length: close - at + 1 + (lazy ? 1 : 0) };
  }

  return null;
}

interface Group {
  start: number;
  end: number;
  /** True when the group body contains an unbounded quantifier at any depth. */
  containsUnbounded: boolean;
  /** True when the body is a single-character alternation of overlapping atoms. */
  bodyIsSimple: boolean;
}

/**
 * Walk the pattern once, recording groups and where unbounded quantifiers sit.
 *
 * Character classes are skipped wholesale: `[+*]` is a literal plus and star, not
 * quantifiers, and treating them as such would reject perfectly safe patterns.
 */
function scan(pattern: string): { groups: Group[]; quantifiers: Quantifier[] } {
  const groups: Group[] = [];
  const quantifiers: Quantifier[] = [];
  const open: { start: number; unboundedBefore: number }[] = [];

  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '\\') {
      // Escaped: the next character is a literal whatever it is.
      index += 2;
      continue;
    }

    if (char === '[') {
      // Skip the whole character class, honouring escapes inside it.
      let cursor = index + 1;
      if (pattern[cursor] === '^') cursor += 1;
      if (pattern[cursor] === ']') cursor += 1; // a leading ] is a literal
      while (cursor < pattern.length && pattern[cursor] !== ']') {
        cursor += pattern[cursor] === '\\' ? 2 : 1;
      }
      index = cursor + 1;
      continue;
    }

    if (char === '(') {
      open.push({ start: index, unboundedBefore: quantifiers.filter((q) => q.unbounded).length });
      index += 1;
      continue;
    }

    if (char === ')') {
      const opened = open.pop();
      if (opened !== undefined) {
        const unboundedInside =
          quantifiers.filter((q) => q.unbounded).length - opened.unboundedBefore;
        groups.push({
          start: opened.start,
          end: index,
          containsUnbounded: unboundedInside > 0,
          bodyIsSimple: /^\(\??[:=!]?[^()]*\)$/.test(pattern.slice(opened.start, index + 1)),
        });
      }
      index += 1;
      continue;
    }

    const quantifier = readQuantifier(pattern, index);
    if (quantifier !== null) {
      quantifiers.push(quantifier);
      index += quantifier.length;
      continue;
    }

    index += 1;
  }

  return { groups, quantifiers };
}

/**
 * The classic catastrophic shape: an unbounded quantifier applied to a group that
 * itself repeats without bound. `(a+)+`, `(a*)*`, `(\w+\s?)+` and friends.
 */
function findNestedQuantifier(pattern: string): PatternProblem | null {
  const { groups } = scan(pattern);

  for (const group of groups) {
    const outer = readQuantifier(pattern, group.end + 1);
    if (outer === null || !outer.unbounded) continue;
    if (!group.containsUnbounded) continue;

    const excerpt = pattern.slice(group.start, group.end + 1 + outer.length);
    return {
      code: 'nested_quantifier',
      index: group.start,
      message:
        `"${excerpt}" repeats a group that already repeats without bound. ` +
        'On input that nearly matches, this can take exponential time and hang the worker. ' +
        'Rewrite it with one quantifier -- for example "(\\w+)+" becomes "\\w+".',
    };
  }

  return null;
}

/**
 * Validate a pattern for storage and execution.
 *
 * Returns a problem rather than throwing so both the API boundary and the live
 * test panel can report it as data.
 */
export function checkPattern(pattern: string, flags = 'i'): PatternCheck {
  if (pattern.trim() === '') {
    return { ok: false, problem: { code: 'empty', message: 'A pattern is required.' } };
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      problem: {
        code: 'too_long',
        message: `A pattern may be at most ${MAX_PATTERN_LENGTH} characters; this one is ${pattern.length}.`,
      },
    };
  }

  const badFlag = [...flags].find((flag) => !ALLOWED_FLAGS.includes(flag));
  if (badFlag !== undefined) {
    return {
      ok: false,
      problem: {
        code: 'invalid_flags',
        // `g` and `y` carry lastIndex state across calls, which would make a rule
        // match or not depending on what was tested before it.
        message: `Flag "${badFlag}" is not allowed. Use any of: ${ALLOWED_FLAGS.split('').join(', ')}.`,
      },
    };
  }

  try {
    new RegExp(pattern, flags);
  } catch (err) {
    return {
      ok: false,
      problem: {
        code: 'invalid_syntax',
        message:
          err instanceof Error ? err.message : 'The pattern is not a valid regular expression.',
      },
    };
  }

  const nested = findNestedQuantifier(pattern);
  if (nested !== null) return { ok: false, problem: nested };

  return { ok: true };
}
