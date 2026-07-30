import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const MINIMAL = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('parseEnv', () => {
  it('defaults to loopback so the API is never accidentally exposed', () => {
    const env = parseEnv(MINIMAL);
    expect(env.BIND_ADDR).toBe('127.0.0.1');
    expect(env.PORT).toBe(3000);
    expect(env.TRUST_PROXY).toBeUndefined();
  });

  it('requires DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('treats an empty string as unset so a documented-but-blank var is legal', () => {
    const env = parseEnv({ ...MINIMAL, TRUST_PROXY: '', NITTER_BASE_URLS: '' });
    expect(env.TRUST_PROXY).toBeUndefined();
    expect(env.NITTER_BASE_URLS).toEqual([]);
  });

  it('parses booleanish flags', () => {
    expect(parseEnv({ ...MINIMAL, WORKER_ENABLED: 'false' }).WORKER_ENABLED).toBe(false);
    expect(parseEnv({ ...MINIMAL, ALLOW_PRIVATE_TARGETS: '1' }).ALLOW_PRIVATE_TARGETS).toBe(true);
    expect(() => parseEnv({ ...MINIMAL, WORKER_ENABLED: 'yes' })).toThrow(/WORKER_ENABLED/);
  });

  it('splits NITTER_BASE_URLS on commas and trims', () => {
    const env = parseEnv({
      ...MINIMAL,
      NITTER_BASE_URLS: 'https://a.example , https://b.example',
    });
    expect(env.NITTER_BASE_URLS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv({ ...MINIMAL, PORT: '70000' })).toThrow(/PORT/);
  });
});
