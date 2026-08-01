/**
 * That the og:image fetcher respects the SSRF guard.
 *
 * A unit test on purpose. The integration suite sets `ALLOW_PRIVATE_TARGETS`, so
 * the same assertion there passes on a connection timeout and would keep passing
 * with the guard deleted. Here the guard is on and it is the only thing that can
 * produce this result.
 */

import { describe, expect, it } from 'vitest';
import { fetchOgImage } from '../../src/images/og.js';

describe('fetchOgImage and the SSRF guard', () => {
  it('refuses blocked addresses without opening a connection', async () => {
    // If any of these reached the network the test would take seconds rather
    // than milliseconds, so the timing below is part of the assertion.
    const blocked = [
      // The cloud metadata endpoint, which is the whole reason this guard exists.
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1/admin',
      'http://10.0.0.5/internal',
      'http://[::1]/',
      'file:///etc/passwd',
      'http://user:pass@example.com/',
    ];

    const started = Date.now();
    for (const url of blocked) {
      await expect(fetchOgImage(url), url).resolves.toBeNull();
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never throws, so one hostile URL cannot fail a whole batch', async () => {
    // The job runs unattended over URLs third parties chose. An exception here
    // would abandon the other twenty-four items in the batch.
    await expect(fetchOgImage('not a url')).resolves.toBeNull();
    await expect(fetchOgImage('')).resolves.toBeNull();
  });
});
