/**
 * The session cookie.
 *
 * Contract section 5.1: the client receives an opaque session identifier in a cookie. Criterion
 * 3 fixes the attributes: HttpOnly, Secure, SameSite. Everything about how that cookie is named,
 * written and cleared lives here, so there is one place to review and no second opinion
 * elsewhere in the codebase.
 *
 * WHAT IS NOT CONFIGURABLE, AND WHY. HttpOnly and SameSite are constants. There is no deployment
 * for which turning either off is correct, and a setting invites someone to try it during an
 * afternoon of debugging and leave it. Secure is configurable only because a browser refuses to
 * send a Secure cookie over plain HTTP, which would make local development need a certificate,
 * and the configuration refuses a false value in production.
 *
 * WHY SameSite=Strict. The browser does not attach the cookie to any cross site request,
 * including a plain form post or a top level navigation from another origin, so a forged request
 * arrives unauthenticated. Section 14.4 is explicit that this is defence in depth rather than
 * the whole control, and `csrf.ts` carries the rest: a custom header a cross origin form cannot
 * set, and a server side origin check. Strict also means a link from an external site lands the
 * user signed out until they navigate within the application, which is the cost being accepted.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Deliberately uninformative.
 *
 * A name like `erp_session_token` tells an attacker reading a proxy log what they are looking
 * at. The value is opaque; the name may as well be too.
 */
export const SESSION_COOKIE = 'erp_sid';

/** Applies to the whole API and nothing narrower, so one session serves every route. */
const COOKIE_PATH = '/';

export interface CookiePolicy {
  secure: boolean;
}

/**
 * Reads the presented token, or null.
 *
 * Returns null for an absent cookie and for an empty one alike. An empty string is not a token,
 * and letting it through would put an empty value into a hash lookup that would then compare
 * against every session with no token, which is none of them today and is not a property to
 * depend on.
 */
export function readSessionToken(request: FastifyRequest): string | null {
  const value = request.cookies?.[SESSION_COOKIE];
  return value && value.length > 0 ? value : null;
}

/**
 * Writes the session cookie.
 *
 * No Max-Age and no Expires, which makes it a session cookie the browser drops when it closes.
 * The server side expiry in section 5.3 is the one that matters, and a cookie lifetime written
 * beside it would be a second, client controlled answer to the same question. Section 5.3 is
 * explicit that expiry is checked on every request rather than trusted from a cookie attribute.
 */
export function setSessionCookie(reply: FastifyReply, token: string, policy: CookiePolicy): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}

/**
 * Clears the session cookie.
 *
 * Cosmetic, and worth being clear that it is. Logout already revoked the session server side,
 * which is what actually ends it per section 5.3. Clearing the cookie only stops the browser
 * sending a value that would now be refused anyway. A client that keeps it gains nothing.
 */
export function clearSessionCookie(reply: FastifyReply, policy: CookiePolicy): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}
