/**
 * Where the authenticated principal lives on a request, and how it gets there.
 *
 * Attachment is the only thing here. Deciding whether a request may proceed belongs to the
 * access guard, and answering "who is this" belongs to the authentication service. This is the
 * seam between them, kept small on purpose.
 */

import { UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedPrincipal } from '../identity/identity.service.js';

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

/** Attaches a resolved principal. Called by the access guard and by nothing else. */
export function attachPrincipal(
  request: FastifyRequest,
  principal: AuthenticatedPrincipal,
): void {
  (request as FastifyRequest & WithPrincipal)[PRINCIPAL] = principal;
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
