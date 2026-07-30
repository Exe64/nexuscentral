import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPIRY_MARGIN_SECONDS,
  RedditAuthError,
  RedditTokenCache,
  TOKEN_URL,
} from '../../src/adapters/reddit/auth.js';
import type { RedditCredentials } from '../../src/db/settings.js';
import { fixture } from '../helpers/fixtures.js';
import { stubFetch } from '../helpers/stub-fetch.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

const CREDENTIALS: RedditCredentials = {
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  userAgent: 'feedhub/1.0 (self-hosted personal aggregator)',
  origin: 'settings',
};

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function fakeNow(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_700_000_000_000;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe('RedditTokenCache', () => {
  it('authenticates with HTTP basic auth and the client-credentials grant', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { body: fixture('reddit', 'token.json'), headers: JSON_HEADERS },
    });
    restore = stub.restore;

    const token = await new RedditTokenCache().getToken(CREDENTIALS);

    expect(token).toBe('eyJhbGciOiJSUzI1NiIsImtpZCI6IlNIQTI1NjpF');

    const [request] = stub.requests;
    expect(request?.method).toBe('POST');
    expect(request?.headers['authorization']).toBe(
      `Basic ${Buffer.from('client-abc:secret-xyz').toString('base64')}`,
    );
    // Reddit blocks generic agents, including here.
    expect(request?.headers['user-agent']).toBe(CREDENTIALS.userAgent);
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('reuses the cached token rather than paying for a round trip', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { body: fixture('reddit', 'token.json'), headers: JSON_HEADERS },
    });
    restore = stub.restore;

    const cache = new RedditTokenCache();
    await cache.getToken(CREDENTIALS);
    await cache.getToken(CREDENTIALS);
    await cache.getToken(CREDENTIALS);

    expect(stub.requests).toHaveLength(1);
  });

  it('refreshes early, before the token actually expires', async () => {
    const clock = fakeNow();
    const stub = stubFetch({
      [TOKEN_URL]: {
        body: JSON.stringify({ access_token: 't', expires_in: 3600 }),
        headers: JSON_HEADERS,
      },
    });
    restore = stub.restore;

    const cache = new RedditTokenCache(clock.now);
    await cache.getToken(CREDENTIALS);

    // Just inside the safety margin: still cached.
    clock.advance((3600 - EXPIRY_MARGIN_SECONDS - 1) * 1000);
    await cache.getToken(CREDENTIALS);
    expect(stub.requests).toHaveLength(1);

    // Past the margin, but before the real expiry: refreshed anyway, so a request
    // is never made with a token that expires mid-flight.
    clock.advance(2000);
    await cache.getToken(CREDENTIALS);
    expect(stub.requests).toHaveLength(2);
  });

  it('deduplicates concurrent refreshes so four pollers fetch one token', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { body: fixture('reddit', 'token.json'), headers: JSON_HEADERS },
    });
    restore = stub.restore;

    const cache = new RedditTokenCache();
    const tokens = await Promise.all([
      cache.getToken(CREDENTIALS),
      cache.getToken(CREDENTIALS),
      cache.getToken(CREDENTIALS),
      cache.getToken(CREDENTIALS),
    ]);

    expect(new Set(tokens).size).toBe(1);
    expect(stub.requests).toHaveLength(1);
  });

  it('discards a token minted for a different client id', async () => {
    let call = 0;
    const stub = stubFetch({
      [TOKEN_URL]: () => {
        call += 1;
        return {
          body: JSON.stringify({ access_token: `token-${call}`, expires_in: 3600 }),
          headers: JSON_HEADERS,
        };
      },
    });
    restore = stub.restore;

    const cache = new RedditTokenCache();
    expect(await cache.getToken(CREDENTIALS)).toBe('token-1');

    // The user changed the credentials in Settings.
    expect(await cache.getToken({ ...CREDENTIALS, clientId: 'client-def' })).toBe('token-2');
  });

  it('forgets the token on invalidate', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { body: fixture('reddit', 'token.json'), headers: JSON_HEADERS },
    });
    restore = stub.restore;

    const cache = new RedditTokenCache();
    await cache.getToken(CREDENTIALS);
    cache.invalidate();
    await cache.getToken(CREDENTIALS);

    expect(stub.requests).toHaveLength(2);
  });

  it('distinguishes bad credentials from Reddit being down', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { status: 401, body: '{"error":"invalid_client"}', headers: JSON_HEADERS },
    });
    restore = stub.restore;

    // The settings UI has to be able to say "check your credentials" rather than
    // "something went wrong".
    await expect(new RedditTokenCache().getToken(CREDENTIALS)).rejects.toMatchObject({
      name: 'RedditAuthError',
      status: 401,
    });
    await expect(new RedditTokenCache().getToken(CREDENTIALS)).rejects.toThrow(/Settings/);
  });

  it('reports a response with no access_token', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { body: '{"error":"unsupported_grant_type"}', headers: JSON_HEADERS },
    });
    restore = stub.restore;

    await expect(new RedditTokenCache().getToken(CREDENTIALS)).rejects.toThrow(
      /unsupported_grant_type/,
    );
  });

  it('reports a non-JSON response', async () => {
    const stub = stubFetch({
      [TOKEN_URL]: { body: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } },
    });
    restore = stub.restore;

    await expect(new RedditTokenCache().getToken(CREDENTIALS)).rejects.toBeInstanceOf(
      RedditAuthError,
    );
  });

  it('never produces an expiry in the past, however short the lifetime', async () => {
    const clock = fakeNow();
    const stub = stubFetch({
      // Shorter than the safety margin.
      [TOKEN_URL]: {
        body: JSON.stringify({ access_token: 't', expires_in: 10 }),
        headers: JSON_HEADERS,
      },
    });
    restore = stub.restore;

    const cache = new RedditTokenCache(clock.now);
    await cache.getToken(CREDENTIALS);

    // Still usable immediately rather than already stale, which would loop.
    await cache.getToken(CREDENTIALS);
    expect(stub.requests).toHaveLength(1);
  });
});
