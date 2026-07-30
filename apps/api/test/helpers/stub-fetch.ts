import { vi } from 'vitest';

export interface StubbedResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Final URL after redirects. Defaults to the requested URL. */
  url?: string;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Replace global `fetch` with a router keyed by URL, so the HTTP layer -- not
 * just the parser -- is exercised without a network. A route may be a function
 * to vary the answer across calls, which is how the 304 path is tested.
 */
export function stubFetch(
  routes: Record<string, StubbedResponse | ((req: RecordedRequest) => StubbedResponse)>,
): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = [];

  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders !== undefined) {
      for (const [name, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
    }

    const request: RecordedRequest = { url, method: init?.method ?? 'GET', headers };
    requests.push(request);

    const route = routes[url];
    if (route === undefined) {
      return Promise.reject(new Error(`stubFetch: no route for ${url}`));
    }

    const spec = typeof route === 'function' ? route(request) : route;
    const status = spec.status ?? 200;
    // 204 and 304 must carry no body, per the Response constructor's own rules.
    const body = status === 204 || status === 304 ? null : (spec.body ?? '');

    const response = new Response(body, {
      status,
      headers: spec.headers ?? { 'content-type': 'application/xml' },
    });
    // `Response.url` is read-only and empty for constructed responses; the HTTP
    // wrapper falls back to the requested URL, but relative-link resolution in
    // discovery depends on it, so make it explicit.
    Object.defineProperty(response, 'url', { value: spec.url ?? url });

    return Promise.resolve(response);
  };

  vi.stubGlobal('fetch', vi.fn(impl));

  return { requests, restore: () => vi.unstubAllGlobals() };
}
