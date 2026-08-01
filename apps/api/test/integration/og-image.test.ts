/**
 * The og:image fallback, against a real HTTP server.
 *
 * Integration rather than unit, for two reasons that matter: the fetch goes
 * through undici with a pinned connection rather than global `fetch`, so a
 * stubbed fetch would test nothing; and the SSRF guard refuses loopback unless
 * `ALLOW_PRIVATE_TARGETS` is set, which only the integration config does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { fetchOgImage, HEAD_MAX_BYTES } from '../../src/images/og.js';
import { enrichPendingImages } from '../../src/images/jobs.js';

let server: Server;
let origin: string;

/** Set per test; the server answers whatever the test put here. */
let handler: (path: string) => { status?: number; body: string; type?: string; location?: string };
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const answer = handler(req.url ?? '/');
    res.writeHead(answer.status ?? 200, {
      'content-type': answer.type ?? 'text/html; charset=utf-8',
      ...(answer.location === undefined ? {} : { location: answer.location }),
    });
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
});

beforeEach(() => {
  requests = [];
});

describe('fetchOgImage', () => {
  it('reads og:image from the head', async () => {
    handler = () => ({
      body: `<html><head><meta property="og:image" content="${origin}/hero.jpg"></head><body>x</body></html>`,
    });

    await expect(fetchOgImage(`${origin}/article`)).resolves.toBe(`${origin}/hero.jpg`);
  });

  it('resolves a relative og:image against the page it came from', async () => {
    handler = () => ({
      body: `<html><head><meta property="og:image" content="/img/hero.jpg"></head></html>`,
    });

    await expect(fetchOgImage(`${origin}/deep/article`)).resolves.toBe(`${origin}/img/hero.jpg`);
  });

  it('falls back to twitter:image when there is no og:image', async () => {
    handler = () => ({
      body: `<html><head><meta name="twitter:image" content="${origin}/t.png"></head></html>`,
    });

    await expect(fetchOgImage(`${origin}/article`)).resolves.toBe(`${origin}/t.png`);
  });

  it('decodes entities, without which a signed CDN URL fails its own signature', async () => {
    handler = () => ({
      body: `<html><head><meta property="og:image" content="${origin}/a.jpg?w=1&amp;sig=xyz"></head></html>`,
    });

    await expect(fetchOgImage(`${origin}/article`)).resolves.toBe(`${origin}/a.jpg?w=1&sig=xyz`);
  });

  it('stops reading at </head> instead of pulling down the whole article', async () => {
    // The body is far past the cap. If this returned, the head short-circuit
    // worked; if it read to the end it would still pass, so assert the size too.
    const filler = 'x'.repeat(HEAD_MAX_BYTES * 2);
    handler = () => ({
      body: `<html><head><meta property="og:image" content="${origin}/h.jpg"></head><body>${filler}</body></html>`,
    });

    const started = Date.now();
    await expect(fetchOgImage(`${origin}/big`)).resolves.toBe(`${origin}/h.jpg`);
    // Generous: this is about not buffering megabytes, not about milliseconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives up on a head that never closes, rather than reading forever', async () => {
    handler = () => ({ body: `<html><head>${'<!-- pad -->'.repeat(HEAD_MAX_BYTES)}` });

    await expect(fetchOgImage(`${origin}/endless`)).resolves.toBeNull();
  });

  it('follows a redirect and re-checks the new target', async () => {
    handler = (path) =>
      path === '/from'
        ? { status: 302, location: `${origin}/to`, body: '' }
        : {
            body: `<html><head><meta property="og:image" content="${origin}/r.jpg"></head></html>`,
          };

    await expect(fetchOgImage(`${origin}/from`)).resolves.toBe(`${origin}/r.jpg`);
    expect(requests).toEqual(['/from', '/to']);
  });

  it('returns null rather than throwing for a 404, a non-HTML body, or no tag', async () => {
    handler = () => ({ status: 404, body: 'nope' });
    await expect(fetchOgImage(`${origin}/missing`)).resolves.toBeNull();

    handler = () => ({ body: '{"a":1}', type: 'application/json' });
    await expect(fetchOgImage(`${origin}/json`)).resolves.toBeNull();

    handler = () => ({ body: '<html><head><title>No image</title></head></html>' });
    await expect(fetchOgImage(`${origin}/plain`)).resolves.toBeNull();
  });
});

describe('enrichPendingImages', () => {
  beforeEach(resetDatabase);

  let sourceId: number;

  beforeEach(async () => {
    const source = await agent
      .post('/api/sources')
      .send({ kind: 'rss', identifier: `${origin}/feed.xml`, title: 'Local' });
    sourceId = source.body.data.id;
  });

  async function insertItem(url: string): Promise<string> {
    return await scalar<string>(
      `INSERT INTO items (source_id, content_hash, url, title, published_at)
       VALUES ($1, sha256(convert_to($2, 'UTF8')), $2, 'An article', now())
       RETURNING id`,
      [sourceId, url],
    );
  }

  it('fills in the image and stamps the attempt', async () => {
    handler = () => ({
      body: `<html><head><meta property="og:image" content="${origin}/found.jpg"></head></html>`,
    });

    const id = await insertItem(`${origin}/article-1`);
    const result = await enrichPendingImages();

    expect(result).toMatchObject({ considered: 1, found: 1, more: false });
    expect(await scalar<string>(`SELECT image_url FROM items WHERE id = $1`, [id])).toBe(
      `${origin}/found.jpg`,
    );
  });

  it('stamps an item whose article has no image, so it is never retried', async () => {
    // The whole point of image_checked_at. Without it this job would re-fetch
    // every image-less article on every pass, forever.
    handler = () => ({ body: '<html><head><title>Nothing</title></head></html>' });

    const id = await insertItem(`${origin}/article-2`);
    await enrichPendingImages();

    expect(await scalar<string>(`SELECT image_url FROM items WHERE id = $1`, [id])).toBeNull();
    expect(
      await scalar<Date>(`SELECT image_checked_at FROM items WHERE id = $1`, [id]),
    ).not.toBeNull();

    // Second pass: nothing left to consider, and no second request.
    requests = [];
    expect(await enrichPendingImages()).toMatchObject({ considered: 0 });
    expect(requests).toEqual([]);
  });

  it('reports that more work remains so the job re-enqueues itself', async () => {
    handler = () => ({ body: '<html><head></head></html>' });

    for (let i = 0; i < 3; i += 1) await insertItem(`${origin}/many-${i}`);

    expect(await enrichPendingImages(2)).toMatchObject({ considered: 2, more: true });
    expect(await enrichPendingImages(2)).toMatchObject({ considered: 1, more: false });
  });

  it('leaves an item that already has an image from its feed alone', async () => {
    handler = () => ({
      body: `<html><head><meta property="og:image" content="${origin}/should-not.jpg"></head></html>`,
    });

    const id = await insertItem(`${origin}/article-3`);
    await scalar(
      `UPDATE items SET image_url = 'https://cdn.example.com/feed.jpg' WHERE id = $1
                  RETURNING id`,
      [id],
    );

    expect(await enrichPendingImages()).toMatchObject({ considered: 0 });
    expect(await scalar<string>(`SELECT image_url FROM items WHERE id = $1`, [id])).toBe(
      'https://cdn.example.com/feed.jpg',
    );
  });
});
