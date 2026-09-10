/**
 * What the transport puts on the wire.
 *
 * The forgery header is added here and nowhere else, so this is where to prove it is added to
 * the requests that need it and to no others. These are unit tests over `fetch`, and they are
 * not the proof that forgery protection works: that lives in the API's own suite, against a real
 * server, because the server is what refuses. What is proved here is the other half, that a
 * legitimate page sends what the server asks for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, request } from './client';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: string | undefined;
}

let calls: Recorded[] = [];

function stubFetch(status = 200, body: unknown = { ok: true }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        credentials: init?.credentials,
      });

      if (status === 204) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

/** Sets the cookie the server would have issued. */
function issueCsrfCookie(value: string): void {
  document.cookie = `erp_csrf=${value}; path=/`;
}

function clearCookies(): void {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

beforeEach(() => {
  calls = [];
  clearCookies();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCookies();
});

describe('the forgery header', () => {
  it('is sent on a POST, carrying the value the server set', async () => {
    issueCsrfCookie('token-from-the-server');
    stubFetch();

    await request('/me/company', { method: 'POST', body: '{}' });

    expect(calls[0]?.headers['X-CSRF-Token']).toBe('token-from-the-server');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('is sent on a %s', async (method) => {
    issueCsrfCookie('token-from-the-server');
    stubFetch();

    await request('/anything', { method });

    expect(calls[0]?.headers['X-CSRF-Token']).toBe('token-from-the-server');
  });

  it('is not sent on a read, because a read changes nothing', async () => {
    issueCsrfCookie('token-from-the-server');
    stubFetch();

    await request('/me');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('is omitted rather than invented when the server has issued no cookie', async () => {
    // A page that has not read anything yet has no token. Sending a made-up value would be
    // refused anyway, and would look in a log like a token that failed rather than one that was
    // never issued.
    stubFetch();

    await request('/me/company', { method: 'POST', body: '{}' });

    expect(calls[0]?.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('reads only the forgery cookie, never a session', async () => {
    // The session cookie is HttpOnly so it is not in document.cookie at all, and this asserts
    // that nothing here would pick up a similarly named value if it were.
    document.cookie = 'erp_sid=a-session-token; path=/';
    issueCsrfCookie('token-from-the-server');
    stubFetch();

    await request('/me/company', { method: 'POST', body: '{}' });

    expect(JSON.stringify(calls[0]?.headers)).not.toContain('a-session-token');
  });
});

describe('the transport itself', () => {
  it('sends cookies with every request', async () => {
    stubFetch();

    await request('/me');

    expect(calls[0]?.credentials).toBe('include');
  });

  it('reports the status on a refusal, so 401 and 403 can be told apart', async () => {
    stubFetch(403, { message: 'Request rejected' });

    // 403 is a real answer about this caller. 401 means no session. Collapsing them would sign
    // a person out because a single request was forbidden.
    await expect(request('/members')).rejects.toBeInstanceOf(ApiError);
    await expect(request('/members')).rejects.toMatchObject({ status: 403 });
  });

  it('returns nothing for a 204 rather than failing to parse an empty body', async () => {
    stubFetch(204);

    await expect(request('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
