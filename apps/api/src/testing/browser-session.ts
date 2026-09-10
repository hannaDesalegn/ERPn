/**
 * A signed-in browser, for tests that speak HTTP.
 *
 * Every mutating request now needs three things together: the session cookie, the forgery cookie
 * and the header echoing it. Assembling those by hand in each test was how the first version of
 * this went, and the result was tests that passed because they forgot the same thing the code
 * forgot. This builds them the way the real page does, once.
 *
 * NOT PRODUCTION CODE. Excluded from the build, and it goes through the public HTTP surface
 * exactly as a browser would: it signs in with a password, reads what the server set, and sends
 * back what the server issued. It knows no secret and derives no token.
 */

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { CSRF_COOKIE, CSRF_HEADER } from '../http/csrf.js';
import { SESSION_COOKIE } from '../http/session-cookie.js';

export interface BrowserSession {
  /** Both cookies, ready for a `cookie` header. */
  cookie: string;
  /** The value the page puts in the custom header. */
  csrf: string;
  /** The raw session token, for tests that assert on what was stored. */
  token: string;
}

/** Splits a `set-cookie` response header into name and value pairs. */
export function cookiesFrom(raw: string | string[] | undefined): Record<string, string> {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const parsed: Record<string, string> = {};

  for (const header of list) {
    const [pair] = header.split(';');
    const [name, ...rest] = (pair ?? '').split('=');
    if (name) parsed[name.trim()] = rest.join('=');
  }

  return parsed;
}

/**
 * Signs in and returns everything a later request needs.
 *
 * The forgery cookie is collected from a read first, because that is what a page does: it loads,
 * asks who it is, and only then posts a form. A sign in with no cookie at all is refused, which
 * is the control working.
 */
export async function signIn(
  app: NestFastifyApplication,
  credentials: { email: string; password: string },
): Promise<BrowserSession> {
  const visit = await app.inject({ method: 'GET', url: '/api/me' });
  const initial = cookiesFrom(visit.headers['set-cookie'])[CSRF_COOKIE] ?? '';

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { cookie: `${CSRF_COOKIE}=${initial}`, [CSRF_HEADER]: initial },
    payload: credentials,
  });

  if (response.statusCode !== 204) {
    throw new Error(`Sign in failed: ${response.statusCode} ${response.body}`);
  }

  const issued = cookiesFrom(response.headers['set-cookie']);
  const token = issued[SESSION_COOKIE] ?? '';
  const csrf = issued[CSRF_COOKIE] ?? '';

  return { cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrf}`, csrf, token };
}

/** Headers for a mutating request from a signed-in page. */
export function mutating(
  session: BrowserSession,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie: session.cookie, [CSRF_HEADER]: session.csrf, ...extra };
}
