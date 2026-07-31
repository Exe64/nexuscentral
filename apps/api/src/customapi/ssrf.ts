/**
 * The SSRF guard for `custom_api` widgets (03-SPEC-api.md 7).
 *
 * The backend fetches on the browser's behalf, which means a widget URL is an
 * instruction to make this server issue a request. Left unchecked that reaches
 * the Docker network, the host's loopback, and on a cloud host the metadata
 * service at 169.254.169.254 -- which hands out credentials.
 *
 * **Resolve first, then check.** Checking the hostname is not a guard: `localhost`
 * has a thousand spellings, and a name the attacker controls can simply resolve
 * to 127.0.0.1. Every address the name resolves to is checked, and the request is
 * pinned to the address that was checked, so a second lookup cannot return
 * something else in between (DNS rebinding).
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../config/env.js';

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

/** Parse an IPv4 dotted quad into a 32-bit number, or null. */
function toV4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

const V4_BLOCKS: { name: string; base: string; bits: number }[] = [
  { name: 'this network', base: '0.0.0.0', bits: 8 },
  { name: 'loopback', base: '127.0.0.0', bits: 8 },
  { name: 'private', base: '10.0.0.0', bits: 8 },
  { name: 'private', base: '172.16.0.0', bits: 12 },
  { name: 'private', base: '192.168.0.0', bits: 16 },
  // The cloud metadata service lives here. This is the one that leaks credentials.
  { name: 'link-local', base: '169.254.0.0', bits: 16 },
  { name: 'carrier-grade NAT', base: '100.64.0.0', bits: 10 },
  { name: 'benchmarking', base: '198.18.0.0', bits: 15 },
  { name: 'multicast', base: '224.0.0.0', bits: 4 },
  { name: 'reserved', base: '240.0.0.0', bits: 4 },
];

function v4Block(address: string): string | null {
  const value = toV4(address);
  if (value === null) return null;

  for (const block of V4_BLOCKS) {
    const base = toV4(block.base);
    if (base === null) continue;
    const mask = block.bits === 0 ? 0 : (0xffffffff << (32 - block.bits)) >>> 0;
    if ((value & mask) === (base & mask)) return block.name;
  }
  return null;
}

function v6Block(address: string): string | null {
  const lower = address.toLowerCase().split('%')[0] ?? '';

  if (lower === '::1') return 'loopback';
  if (lower === '::' || lower === '::0') return 'unspecified';

  // IPv4-mapped (::ffff:1.2.3.4) is an IPv4 address wearing a hat; unwrap it or
  // the whole v4 block list is trivially bypassed.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return v4Block(mapped[1]);

  const head = lower.split(':')[0] ?? '';
  const first = Number.parseInt(head.padStart(4, '0').slice(0, 4), 16);
  if (Number.isNaN(first)) return null;

  // fc00::/7 -- unique local.
  if ((first & 0xfe00) === 0xfc00) return 'unique local';
  // fe80::/10 -- link-local.
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  // ff00::/8 -- multicast.
  if ((first & 0xff00) === 0xff00) return 'multicast';

  return null;
}

/** The block an address belongs to, or null when it is routable and public. */
export function blockedRange(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return v4Block(address);
  if (family === 6) return v6Block(address);
  return null;
}

export interface ResolvedTarget {
  url: URL;
  /** The address the request must connect to, already checked. */
  address: string;
  family: 4 | 6;
}

/**
 * Validate a URL and resolve it to a single checked address.
 *
 * Throws `BlockedTargetError` with a reason the user can act on: "this is a
 * private address" is useful, "request failed" is not.
 */
export async function resolveTarget(raw: string): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError('That is not a valid absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // file:, gopher:, and friends. Nothing good comes of allowing them here.
    throw new BlockedTargetError(`Only http and https are allowed, not "${url.protocol}".`);
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in the URL would be logged and stored in the widget config.
    throw new BlockedTargetError('Remove the credentials from the URL and use a header instead.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup, but still needs checking.
  if (isIP(host) !== 0) {
    const block = blockedRange(host);
    if (block !== null && !env.ALLOW_PRIVATE_TARGETS) {
      throw new BlockedTargetError(`${host} is a ${block} address, which is not allowed.`);
    }
    return { url, address: host, family: isIP(host) === 6 ? 6 : 4 };
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedTargetError(`Could not resolve ${host}.`);
  }

  if (addresses.length === 0) throw new BlockedTargetError(`${host} resolved to nothing.`);

  if (!env.ALLOW_PRIVATE_TARGETS) {
    // Every address, not just the first: a name that resolves to both a public
    // and a private address must not be usable to reach the private one.
    for (const entry of addresses) {
      const block = blockedRange(entry.address);
      if (block !== null) {
        throw new BlockedTargetError(
          `${host} resolves to ${entry.address}, a ${block} address, which is not allowed.`,
        );
      }
    }
  }

  const chosen = addresses[0] as { address: string; family: number };
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}
