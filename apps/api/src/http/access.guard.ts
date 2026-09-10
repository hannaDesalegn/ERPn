/**
 * The single gate every request passes through.
 *
 * Contract section 6.2: deny by default. Registered globally rather than per controller, because
 * a guard you have to remember to apply is a guard that will be forgotten on the two hundredth
 * route, and section 6.3 makes the same argument about scoped queries: the safe shape is the one
 * where forgetting produces a refusal rather than an opening.
 *
 * THE ORDER IS THE FOUR DIMENSIONS OF SECTION 6.1, IN THE ORDER THAT SECTION FIXES.
 *
 *   0. What does this route declare? Nothing declared is a refusal, not a default.
 *   1. Is there a live session? No session, no request. This is dimension zero, identity.
 *   2. Is the caller inside a company at all? That is dimension 1, and it is not a permission a
 *      role can grant. No company entered means nothing to be authorized against.
 *   3. Do they hold the capability in that company? Dimension 3, the operation level.
 *
 * Dimensions 2 and 4, row and field, are enforced in the query and at serialisation
 * respectively, per sections 6.3 and 6.4. They are not this guard's job and are not silently
 * skipped by it.
 *
 * NOTHING IS READ FROM THE REQUEST. Not a role, not a permission, not a company, not a tenant.
 * The session comes from a cookie the browser will not hand to script; the company comes from
 * that session and is checked against a live membership; the permissions are read from the
 * database under that company. A request carrying `x-role: administrator` is a request carrying
 * a header nothing reads.
 */

import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { AuthenticationService } from '../auth/authentication.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ROUTE_ACCESS, type RouteAccess } from '../authorization/route-access.js';
import { IdentityService } from '../identity/identity.service.js';
import { attachPrincipal } from './principal.js';
import { readSessionToken } from './session-cookie.js';

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authentication: AuthenticationService,
    private readonly identity: IdentityService,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!access) {
      // The startup audit refuses to boot with a route in this state, so reaching here means
      // something registered a handler after startup. Refuse it rather than guess, and say
      // nothing about why: an undeclared route is a defect, not a hint to give a caller.
      throw new ForbiddenException('Forbidden');
    }

    if (access.kind === 'public') return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const token = readSessionToken(request);
    if (!token) throw notSignedIn();

    // Every session check that matters happens here: the token is hashed and looked up,
    // revocation and both expiry windows are evaluated against the current time, and the idle
    // window slides. Section 5.3 requires that on every request.
    const session = await this.authentication.validate(token);
    if (session.outcome !== 'valid') throw notSignedIn();

    const principal = {
      sessionId: session.sessionId,
      userId: session.userId,
      activeCompanyId: session.activeCompanyId,
    };
    attachPrincipal(request, principal);

    if (access.kind === 'authenticated') return true;

    // Dimension 1. Re-derived from a live membership rather than trusted from the session, so a
    // membership ended a moment ago takes the company with it on this very request.
    const companyContext = await this.identity.currentContext(principal);
    if (!companyContext) throw forbidden();

    const allowed = await this.authorization.can(
      companyContext,
      principal.userId,
      access.permission,
    );
    if (!allowed) throw forbidden();

    return true;
  }
}

/**
 * One message for every refusal of each kind, built in one place.
 *
 * The 401 and the 403 are genuinely different and the distinction is safe to make: a caller
 * already knows whether they sent a cookie. What is not safe is varying the message within a
 * kind, which would let a caller learn which of several conditions failed.
 */
function notSignedIn(): UnauthorizedException {
  return new UnauthorizedException('Not signed in');
}

function forbidden(): ForbiddenException {
  return new ForbiddenException('Forbidden');
}
