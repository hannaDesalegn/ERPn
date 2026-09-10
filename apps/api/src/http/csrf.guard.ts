/**
 * The cross site request forgery boundary.
 *
 * One global guard rather than a check per controller, for the reason section 6.2 gives about
 * the authorization guard and section 6.3 gives about scoped queries: a control you have to
 * remember to apply is one that will be forgotten, and the shape worth having is the one where
 * forgetting produces a refusal.
 *
 * IT AUTHENTICATES NOTHING AND AUTHORIZES NOTHING. It never looks a session up, never reads a
 * role, and never decides who anyone is. It answers one question: did this request come from our
 * own page rather than from someone else's. A request that passes here is still refused by the
 * access guard if there is no live session, and still refused again if the session lacks the
 * capability. Three guards, three questions, and none of them standing in for another.
 *
 * IT RUNS FIRST. Registered before the access guard so a forged request is turned away before
 * anything touches the database. A forgery that gets as far as a session lookup has already cost
 * a connection and a query.
 */

import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../config/env.schema.js';
import {
  checkOrigin,
  csrfTokenFor,
  isMutating,
  randomCsrfToken,
  readCsrfCookie,
  readCsrfHeader,
  setCsrfCookie,
  tokensMatch,
} from './csrf.js';
import { readSessionToken, type CookiePolicy } from './session-cookie.js';
import { hashSessionToken } from '../auth/session-token.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly cookiePolicy: CookiePolicy;
  private readonly trustedOrigins: readonly string[];

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.cookiePolicy = { secure: config.get('COOKIE_SECURE', { infer: true }) };
    this.trustedOrigins = config.get('TRUSTED_ORIGINS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    if (!isMutating(request.method)) {
      // A safe request is also where the page picks up the token it will need later, so this is
      // the one place the cookie is issued outside sign in. Issuing it on a read is safe: the
      // value grants nothing, and a page that never mutates simply never uses it.
      this.issueIfMissing(request, reply);
      return true;
    }

    // Layer three. Independent of the token, and the only layer that still works if one leaks.
    const origin = checkOrigin(request, this.trustedOrigins);
    if (origin === 'foreign') throw refused();

    // Layer two. A cross origin form cannot set this header at all, and a cross origin fetch
    // that tries triggers a preflight this server does not answer.
    const presented = readCsrfHeader(request);
    const cookie = readCsrfCookie(request);
    if (!tokensMatch(presented, cookie)) throw refused();

    const sessionToken = readSessionToken(request);
    if (!sessionToken) {
      // No session to bind to, which is sign in and nothing else. Plain double submit, plus the
      // origin check above and SameSite underneath. The strongest check below cannot apply
      // because there is nothing yet to derive from.
      return true;
    }

    // The binding, and the reason this is not a plain double submit. Someone who can write a
    // cookie for this site, on a sibling subdomain or over plain HTTP, can plant a matching pair
    // and satisfy the check above. They cannot make that pair equal the value this session's
    // token derives to.
    const expected = csrfTokenFor(hashSessionToken(sessionToken));
    if (!tokensMatch(cookie, expected)) throw refused();

    return true;
  }

  private issueIfMissing(request: FastifyRequest, reply: FastifyReply): void {
    // Issuing is a convenience on a safe request; enforcing on a mutation is not, and the
    // enforcement path never touches this. A reply without cookie support means the cookie
    // plugin is not registered, which is a wiring problem worth failing loudly somewhere it
    // matters. Here it must not be, because "here" includes the container health probe, and a
    // probe that answers 500 gets the process killed.
    if (typeof reply.setCookie !== 'function') return;

    const sessionToken = readSessionToken(request);
    const expected = sessionToken
      ? csrfTokenFor(hashSessionToken(sessionToken))
      : readCsrfCookie(request) ?? randomCsrfToken();

    // Rewritten rather than left alone when it disagrees. A session's token is deterministic, so
    // a cookie that does not match it is stale, from another session on this machine, or
    // planted, and none of those should be allowed to persist.
    if (readCsrfCookie(request) !== expected) {
      setCsrfCookie(reply, expected, this.cookiePolicy);
    }
  }
}

/**
 * One refusal for every reason.
 *
 * Missing header, wrong header, foreign origin and unbound token all produce this. Telling a
 * caller which check failed is telling an attacker which one to work on, and none of the four is
 * a state a legitimate page reaches.
 */
function refused(): ForbiddenException {
  return new ForbiddenException('Request rejected');
}
