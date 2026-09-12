/**
 * What a person may do inside the company they are working in.
 *
 * THREE QUESTIONS, THREE LAYERS. Authentication answers who this is. Company context answers
 * which company they are operating in. This answers what they may do there, and nothing else. It
 * never resolves a session, never chooses a company, and never accepts either as an argument it
 * has not been handed by the layer that owns it.
 *
 * Contract section 6.1 orders the four dimensions, and the order matters. Company scope is
 * evaluated first and is not a permission a role can grant, so nothing in this file can widen
 * the boundary. It receives a `CompanyContext` that was already verified against a live
 * membership, and every read it performs runs inside that context.
 *
 * NOTHING IS CACHED, AND THAT IS THE DESIGN. Section 6.6 requires a role or permission change to
 * either invalidate the affected sessions or re-derive them, and requires the choice to be
 * stated rather than left ambiguous. This re-derives: permissions are read from the database on
 * every request that needs them. A revoked role stops authorizing on the very next request, with
 * no cache to expire and no session to hunt down. The cost is a query per protected request,
 * which is the right trade for a control whose failure mode is continuing to grant access that
 * has been taken away.
 */

import { Injectable } from '@nestjs/common';

import { actorScope, UnitOfWork } from '../database/index.js';
import type { ScopedRepositories } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { isPermission, type Permission } from './permissions.js';

export interface Grants {
  /** Roles held in this company. Reported for display; they authorize nothing on their own. */
  roles: { key: string; name: string }[];
  /** The union of what those roles permit, as catalogue strings. */
  permissions: Permission[];
}

export const NO_GRANTS: Grants = { roles: [], permissions: [] };

/**
 * What one membership grants, read inside the caller's transaction.
 *
 * Takes repositories rather than a unit of work so that an operation which has to authorize and
 * then write, such as confirming a sales order, can do both under one transaction. Section 12.2
 * makes authorization step two of six that happen together or not at all, and a permission read
 * on a connection of its own would be a decision made outside the transaction it governs.
 *
 * Roles and permissions come back together, from one scope, because they are two views of the
 * same fact and reading them separately invites a state where the reported roles and the
 * enforced permissions describe different moments.
 */
export async function grantsIn(
  repositories: Pick<ScopedRepositories, 'roles'>,
  membershipId: string,
): Promise<Grants> {
  const roles = await repositories.roles.listForMembership(membershipId);
  const stored = await repositories.roles.listPermissionsForMembership(membershipId);

  return {
    roles: roles.map((role) => ({ key: role.key, name: role.name })),
    // The second half of the two checks in section 2.7. A stored string the current release no
    // longer defines is dropped here rather than handed to a comparison that would never match
    // anything. The startup check is what makes it loud; this makes it safe in the meantime, and
    // it fails closed because an unknown string grants nothing.
    permissions: stored.filter(isPermission),
  };
}

@Injectable()
export class AuthorizationService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Everything one membership grants in one company.
   *
   * Roles and permissions come back together, from one transaction under one scope, because
   * they are two views of the same fact and reading them separately invites a state where the
   * reported roles and the enforced permissions describe different moments.
   */
  async grantsFor(context: CompanyContext, userId: string): Promise<Grants> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId,
      }),
      (repos) => grantsIn(repos, context.membershipId),
    );
  }

  /**
   * Whether a membership carries one capability in one company.
   *
   * The company is part of the question rather than context around it. A role held in company A
   * is read under company A's scope and cannot be found under company B's, which is what makes
   * section 2.7's "roles do not travel between companies" a property of the query rather than a
   * rule someone has to remember.
   */
  async can(
    context: CompanyContext,
    userId: string,
    permission: Permission,
  ): Promise<boolean> {
    const grants = await this.grantsFor(context, userId);

    return grants.permissions.includes(permission);
  }
}
