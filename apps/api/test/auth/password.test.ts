/**
 * Password hashing.
 *
 * The properties worth asserting are the ones whose absence is invisible: that
 * two hashes of the same password differ, that the cost is actually paid, and
 * that a malformed hash fails closed instead of throwing.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from '../../src/auth/password.js';

const PASSWORD = 'a-perfectly-ordinary-long-password';

describe('hashPassword', () => {
  it('round-trips', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(`${PASSWORD}x`, hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password never produces the same hash', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    // Both still verify: the salt travels with the hash.
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it('records its parameters in the encoded form', async () => {
    const hash = await hashPassword(PASSWORD);
    const [scheme, N, r, p] = hash.split('$');

    expect(scheme).toBe('scrypt');
    // Raising the cost later must not invalidate hashes made today, which is only
    // true because these travel with the hash.
    expect(Number(N)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('actually costs something', async () => {
    // A hash that returns instantly is a hash with the parameters silently
    // dropped -- which is exactly what promisify(scrypt) did before this was
    // written by hand.
    const started = performance.now();
    await hashPassword(PASSWORD);
    expect(performance.now() - started).toBeGreaterThan(20);
  });

  it('normalises Unicode, so the same typed password matches either encoding', async () => {
    // U+00E9 vs U+0065 U+0301 -- the same "é" as far as any user is concerned.
    const composed = 'mot-de-passe-café-long';
    const decomposed = composed.normalize('NFD');
    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });
});

describe('verifyPassword on a damaged hash', () => {
  it.each([
    ['empty', ''],
    ['not scrypt', 'bcrypt$10$abc$def$ghi$jkl'],
    ['too few fields', 'scrypt$32768$8$1$onlysalt'],
    ['non-numeric cost', 'scrypt$x$8$1$c2FsdA$aGFzaA'],
    ['empty salt', 'scrypt$32768$8$1$$aGFzaA'],
    ['absurd cost', 'scrypt$1073741824$8$1$c2FsdA$aGFzaA'],
  ])('returns false rather than throwing: %s', async (_label, encoded) => {
    // A corrupted row must lock the account, not 500 every login attempt.
    await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(false);
  });
});

describe('passwordProblem', () => {
  it('accepts a long password', () => {
    expect(passwordProblem(PASSWORD)).toBeNull();
  });

  it('rejects one shorter than the floor', () => {
    expect(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toContain(
      String(MIN_PASSWORD_LENGTH),
    );
    expect(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects whitespace pretending to be length', () => {
    expect(passwordProblem(' '.repeat(20))).toContain('whitespace');
  });

  it('rejects something long enough to be a denial of service', () => {
    expect(passwordProblem('x'.repeat(5000))).toContain('at most');
  });

  it('does not impose composition rules', () => {
    // No "one uppercase, one digit, one symbol". Those push people to Password1!
    expect(passwordProblem('correct horse battery staple')).toBeNull();
  });
});
