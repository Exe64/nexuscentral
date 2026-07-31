/**
 * The SSRF guard.
 *
 * `169.254.169.254` is the acceptance criterion, but it is one address out of
 * several ranges that all reach somewhere they should not. The bypasses are the
 * interesting cases: a hostname that resolves to a private address, an
 * IPv4-mapped IPv6 address, and a redirect to somewhere private after a public
 * first hop.
 */

import { describe, expect, it, vi } from 'vitest';
import { blockedRange } from '../../src/customapi/ssrf.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const { resolveTarget, BlockedTargetError } = await import('../../src/customapi/ssrf.js');

describe('blockedRange', () => {
  it.each([
    // The one the acceptance criterion names: cloud metadata, hands out credentials.
    ['169.254.169.254', 'link-local'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.1', 'private'],
    ['0.0.0.0', 'this network'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    // An IPv4 address wearing an IPv6 hat. Missing this unwrapping makes the
    // whole v4 list bypassable with one prefix.
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:127.0.0.1', 'loopback'],
  ])('blocks %s as %s', (address, reason) => {
    expect(blockedRange(address)).toBe(reason);
  });

  it.each([
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['172.15.255.255'], // just below the private block
    ['172.32.0.1'], // just above it
    ['192.167.255.255'],
    ['2606:4700:4700::1111'],
  ])('allows the public address %s', (address) => {
    expect(blockedRange(address)).toBeNull();
  });

  it('is not fooled by the boundaries of 172.16/12', () => {
    expect(blockedRange('172.16.0.0')).toBe('private');
    expect(blockedRange('172.31.255.255')).toBe('private');
    expect(blockedRange('172.15.0.0')).toBeNull();
    expect(blockedRange('172.32.0.0')).toBeNull();
  });
});

describe('resolveTarget', () => {
  it('rejects a literal metadata address', async () => {
    await expect(resolveTarget('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      BlockedTargetError,
    );
  });

  it('rejects a hostname that resolves to a private address', async () => {
    // The bypass a hostname-only check would miss entirely.
    lookup.mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }]);

    await expect(resolveTarget('https://totally-legit.example.com/data')).rejects.toThrow(
      /10\.1\.2\.3.*private/,
    );
  });

  it('rejects when any resolved address is private, not just the first', async () => {
    lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    // Checking only the first would let a dual-record name through.
    await expect(resolveTarget('https://mixed.example.com/')).rejects.toThrow(/loopback/);
  });

  it('allows a public hostname and pins the address it checked', async () => {
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);

    const target = await resolveTarget('https://example.com/api?x=1');

    expect(target.address).toBe('93.184.216.34');
    expect(target.url.hostname).toBe('example.com');
  });

  it.each([
    ['file:///etc/passwd', /http and https/],
    ['gopher://example.com/', /http and https/],
    ['not a url', /valid absolute URL/],
  ])('rejects %s', async (url, expected) => {
    await expect(resolveTarget(url)).rejects.toThrow(expected);
  });

  it('rejects credentials embedded in the URL', async () => {
    // They would end up in the stored widget config and in logs.
    await expect(resolveTarget('https://user:pass@example.com/')).rejects.toThrow(/credentials/);
  });

  it('reports a name that resolves to nothing', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(resolveTarget('https://nope.example.com/')).rejects.toThrow(/Could not resolve/);
  });

  it('handles a bracketed IPv6 literal', async () => {
    await expect(resolveTarget('http://[::1]:8080/')).rejects.toThrow(/loopback/);
  });
});
