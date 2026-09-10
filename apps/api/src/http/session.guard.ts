/**
 * Turns a cookie into an authenticated principal, or refuses.
 *
 * WHAT THIS IS NOT. It is not authorization. It answers "is there a live session, and whose",
 * and stops there. It reads no role, evaluates no permission, and never decides that a
 * particular person may perform a particular operation. Contract section 5.4 keeps those
 * questions apart, and the deny-by-default permission guard that section 6.2 requires is a
 * separate thing in a separate increment.
 *
 * It is also applied per controller rather than globally, deliberately. A global guard with an
 * opt-out decorator is the shape deny-by-default takes, and building half of that now would mean
 * the next increment either inherits a half-made mechanism or replaces one that already looks
 * finished. Until then, every route this project has is listed in one of two controllers and
 * both of them carry the guard.
 */

import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AuthenticationService } from '../auth/authentication.service.js';
import type { AuthenticatedPrincipal } from '../identity/identity.service.js';
import { readSessionToken } from './session-cookie.js';

/**
 * Where the principal is attached for the controller to read.
 *
 * A symbol rather than a string key, so nothing can arrive on the request already carrying it.
 * A client cannot send a header or a body field that lands here, because there is no string
 * anywhere in the wire format that names it.
 */
export const PRINCIPAL = Symbol('PRINCIPAL');

interface WithPrincipal {
  [PRINCIPAL]?: AuthenticatedPrincipal;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authentication: AuthenticationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & WithPrincipal>();

    const token = readSessionToken(request);
    if (!token) throw new UnauthorizedException('Not signed in');

    // Every check that matters happens here: the token is hashed and looked up, revocation and
    // both expiry windows are evaluated against the current time, and the idle window slides.
    // Section 5.3 requires that on every request rather than trusting a cookie attribute.
    const session = await this.authentication.validate(token);
    if (session.outcome !== 'valid') throw new UnauthorizedException('Not signed in');

    request[PRINCIPAL] = {
      sessionId: session.sessionId,
      userId: session.userId,
      // Reported by the session, not yet trusted as context. The identity service checks it
      // against a live membership before anything is served from that company.
      activeCompanyId: session.activeCompanyId,
    };

    return true;
  }
}

/**
 * Reads the principal the guard attached.
 *
 * Throws rather than returning undefined. A controller reaching this without the guard having
 * run is a wiring mistake, and the safe failure for a wiring mistake is a loud one rather than
 * an anonymous request quietly proceeding.
 */
export function principalOf(request: FastifyRequest): AuthenticatedPrincipal {
  const principal = (request as FastifyRequest & WithPrincipal)[PRINCIPAL];

  if (!principal) {
    throw new UnauthorizedException('Not signed in');
  }

  return principal;
}
