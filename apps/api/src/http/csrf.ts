/**
 * Cross site request forgery: the token, the cookie, and the origin check.
 *
 * Contract section 14.4, which is specific about the model and worth quoting: "Because
 * authentication uses cookies, every mutating request additionally requires a custom header that
 * a cross origin form cannot set, and the origin is checked server side. `SameSite` alone is
 * defence in depth, not the whole control."
 *
 * So there are three layers here and each fails differently.
 *
 *   1. `SameSite=Strict` on the session cookie. The browser does not attach it to a cross site
 *      request at all, so a forged request arrives unauthenticated. Already in place, unchanged,
 *      and deliberately not treated as sufficient: it is a browser behaviour, and a browser that
 *      does not implement it, or a future relaxation to `Lax` for a link-sharing requirement,
 *      would silently remove the whole control.
 *   2. The custom header. A cross origin HTML form cannot set one at all, and a cross origin
 *      `fetch` that sets one triggers a preflight this server never approves. This is the layer
 *      section 14.4 names.
 *   3. The origin check. Cheap, independent of the other two, and the only one that still works
 *      if a token ever leaks.
 *
 * WHY THE TOKEN IS DERIVED FROM THE SESSION RATHER THAN STORED.
 *
 * A plain double submit cookie, where the server only checks that the header equals the cookie,
 * has a known weakness: anyone who can write a cookie for the site, such as an attacker on a
 * sibling subdomain or on plain HTTP, can plant both halves and satisfy the check. Binding the
 * value to the session closes that, because a planted pair does not match what this session's
 * token must be.
 *
 * It is derived rather than stored because the alternative is a column on `sessions`, and the
 * session store is not this increment's to change. HMAC keyed by the stored token hash gives a
 * value that is deterministic for one session, different for every other, and unguessable
 * without the raw token. An attacker who has the raw token does not need forgery; they have the
 * session.
 *
 * THE CSRF COOKIE IS DELIBERATELY READABLE BY SCRIPT. That is what makes the header possible,
 * and it is not a weakening: the CSRF token authenticates nothing on its own, and cross origin
 * script cannot read it any more than it can read the session cookie. The session cookie stays
 * `HttpOnly` and this file never touches it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { CookiePolicy } from './session-cookie.js';

/** Readable by script, unlike the session cookie beside it. */
export const CSRF_COOKIE = 'erp_csrf';

/**
 * The header a cross origin form cannot set.
 *
 * Lower case because that is how Fastify normalises incoming header names. The name is not a
 * secret and does not need to be: what a form cannot do is set any custom header at all.
 */
export const CSRF_HEADER = 'x-csrf-token';

/** Methods that change state, and therefore the ones section 14.4 covers. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

/**
 * The token this session must present.
 *
 * Keyed by the stored session hash, over a fixed label. Not the raw token, which the server
 * never keeps, and not a bare hash of it, so that read access to the sessions table does not
 * hand out working tokens.
 */
export function csrfTokenFor(sessionTokenHash: string): string {
  return createHmac('sha256', sessionTokenHash).update('csrf-token-v1').digest('hex');
}

/**
 * A token for a caller with no session yet.
 *
 * Sign in is a mutating request made before any session exists, so there is nothing to bind to.
 * This is the plain double submit case, which is the weaker one, and it is used only where the
 * stronger one cannot apply. The origin check and `SameSite` still cover it, and the worst a
 * successful forgery achieves here is signing a victim into an account the attacker controls.
 */
export function randomCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function readCsrfCookie(request: FastifyRequest): string | null {
  const value = request.cookies?.[CSRF_COOKIE];
  return value && value.length > 0 ? value : null;
}

export function readCsrfHeader(request: FastifyRequest): string | null {
  const raw = request.headers[CSRF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : null;
}

export function setCsrfCookie(reply: FastifyReply, token: string, policy: CookiePolicy): void {
  reply.setCookie(CSRF_COOKIE, token, {
    // NOT HttpOnly, and this is the one cookie in the system where that is correct. The page has
    // to read it to put it in a header. It grants nothing on its own.
    httpOnly: false,
    secure: policy.secure,
    sameSite: 'strict',
    path: '/',
  });
}

export function clearCsrfCookie(reply: FastifyReply, policy: CookiePolicy): void {
  reply.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: policy.secure,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Constant time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a signal, so lengths are
 * checked first and a mismatch is simply a no.
 */
export function tokensMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

/**
 * Whether the request came from somewhere this deployment serves.
 *
 * A browser sets `Origin` on every cross origin request and on same origin mutations, and a page
 * cannot forge it. `Referer` is the fallback for the few cases where `Origin` is absent.
 *
 * An absent origin is NOT treated as a pass on its own. It is common for non browser clients,
 * which is exactly the class of caller that does not carry a victim's cookies, so the token check
 * is what covers that case and this returns "unknown" rather than deciding.
 */
export type OriginVerdict = 'same-origin' | 'trusted' | 'foreign' | 'unknown';

export function checkOrigin(request: FastifyRequest, trusted: readonly string[]): OriginVerdict {
  const stated = originOf(request);
  if (!stated) return 'unknown';

  if (trusted.includes(stated)) return 'trusted';

  // Compared against the host the request was addressed to. In a forgery the browser sets the
  // origin to the attacker's site and the host to ours, so the two disagree; nothing the
  // attacker's page can do makes them agree.
  const host = request.headers.host;
  if (host && hostOf(stated) === host) return 'same-origin';

  return 'foreign';
}

function originOf(request: FastifyRequest): string | null {
  const origin = headerValue(request, 'origin');
  if (origin && origin !== 'null') return origin;

  const referer = headerValue(request, 'referer');
  if (!referer) return null;

  try {
    return new URL(referer).origin;
  } catch {
    // A malformed referer is not an origin. Treated as absent rather than as a match.
    return null;
  }
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : null;
}
