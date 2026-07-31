/**
 * Password hashing.
 *
 * scrypt from `node:crypto`, not bcrypt or argon2. Both of those mean a native
 * module, which means a compiler in the Docker build and a rebuild on every Node
 * upgrade; scrypt is memory-hard, in the standard library, and needs neither.
 *
 * The encoded form carries its own parameters:
 *
 *   scrypt$32768$8$1$<salt base64url>$<hash base64url>
 *
 * so raising the cost later is a one-line change and old hashes keep verifying
 * against the parameters they were made with.
 */

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hand-rolled rather than `promisify(scrypt)`: promisify resolves to the
 * three-argument overload, which drops the options object that carries N, r, p
 * and maxmem -- silently hashing with the defaults instead.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * N = 2^15, r = 8, p = 1 -- about 100 ms and 32 MB per hash.
 *
 * `maxmem` has to be raised explicitly: Node defaults to 32 MB and this costs
 * exactly N * r * 128 = 32 MB, which trips the limit rather than sitting under it.
 */
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 } as const;

const SALT_BYTES = 16;

/** Minimum length. Long beats clever: this is the only credential in the system. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });

  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${b64(salt)}$${b64(derived)}`;
}

/**
 * Verify a password against an encoded hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row must
 * lock the account, not crash every login attempt with a 500.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
  } catch {
    // Parameters outside what this build will spend memory on.
    return false;
  }

  // Constant time: a byte-by-byte early return leaks the hash one comparison at a
  // time. Lengths are equal by construction above, but guard anyway --
  // timingSafeEqual throws on a mismatch.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Reject the passwords that make the rest of this pointless.
 *
 * Deliberately not a complexity rule -- no "one uppercase, one digit". Length is
 * what matters, and composition rules push people towards `Password1!`.
 */
export function passwordProblem(password: string): string | null {
  const normalised = password.normalize('NFKC');
  if (normalised.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (normalised.length > MAX_PASSWORD_LENGTH) {
    return `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (normalised.trim().length === 0) return 'The password cannot be only whitespace.';
  return null;
}
