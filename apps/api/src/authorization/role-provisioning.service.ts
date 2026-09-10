/**
 * Creating a company's roles, and changing who holds them.
 *
 * Contract section 2.7: default role templates are seeded into a company when it is created,
 * and from that moment they are that company's own. Editing one affects nobody else, which is
 * the whole reason roles are data and the catalogue is code.
 *
 * Section 6.6 governs the changes: a user may never assign a role whose permission set exceeds
 * their own, every change writes an audit record, and the effect on existing sessions must be
 * stated rather than left ambiguous. It is stated here and in the authorization service: nothing
 * is cached, permissions are re-derived on every request that needs them, so a change takes
 * effect on the next request without touching a single session row.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { AuthorizationService } from './authorization.service.js';
import { ROLE_TEMPLATE_LIST, type Permission, type RoleKey } from './permissions.js';

export interface SeededRole {
  id: string;
  key: RoleKey;
}

export type RoleChangeResult =
  /** The role was assigned, or was already held. Either way the end state is the same. */
  | { outcome: 'applied' }
  /** No such role in this company. Same answer as a role in another company, per section 6.1. */
  | { outcome: 'not_found' }
  /**
   * Refused because the acting user does not hold everything the role grants.
   *
   * Distinguished from `not_found` deliberately, and only here. The acting user has already
   * proved membership and `admin:users` in this company, so telling them the role exists and
   * that they may not grant it discloses nothing they could not discover by reading the role
   * list they are entitled to. Section 6.6 makes this refusal a rule worth explaining.
   */
  | { outcome: 'would_escalate'; missing: Permission[] };

@Injectable()
export class RoleProvisioningService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * Copies the default templates into a company.
   *
   * Runs as a named system scope rather than as an actor, because it happens when a company is
   * created and there is nobody inside it yet to act. Everything, including the audit record,
   * is one transaction: a company with half its roles is worse than one with none, because the
   * missing half looks like a deliberate configuration choice.
   */
  async seedDefaultRoles(target: {
    tenantId: string;
    companyId: string;
  }): Promise<SeededRole[]> {
    return this.uow.inSystemScope(
      systemScope('tenant-provisioning', target),
      async (repos) => {
        const seeded: SeededRole[] = [];

        for (const template of ROLE_TEMPLATE_LIST) {
          const id = randomUUID();
          await repos.roles.create({
            id,
            key: template.key,
            name: template.name,
            description: template.description,
          });
          // Validated against the catalogue inside the repository. A template that named a
          // capability the release no longer defines would fail the seed rather than create a
          // company whose administrator role is quietly missing something.
          await repos.roles.grantPermissions({
            roleId: id,
            permissions: template.permissions,
          });
          seeded.push({ id, key: template.key });
        }

        await repos.audit.append({
          action: 'roles_seeded',
          entityType: 'company',
          entityId: target.companyId,
          summary: `Seeded ${seeded.length} default roles`,
          changes: { roles: seeded.map((role) => role.key) },
        });

        return seeded;
      },
    );
  }

  /**
   * Grants a role to a membership.
   *
   * The role is named by its key rather than its identifier, so a caller cannot reach a role in
   * another company by knowing its id: the key is resolved inside the acting company, and a key
   * that names nothing there is simply not found.
   */
  async assignRole(input: {
    context: CompanyContext;
    actorUserId: string;
    membershipId: string;
    roleKey: string;
  }): Promise<RoleChangeResult> {
    const { context, actorUserId } = input;

    // Section 6.6, evaluated before the write and from the database rather than from anything
    // the request carried. The acting user's own grants are read under the same company.
    const actorGrants = await this.authorization.grantsFor(context, actorUserId);

    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      async (repos) => {
        const roles = await repos.roles.listForCompany();
        const role = roles.find((candidate) => candidate.key === input.roleKey);
        if (!role) return { outcome: 'not_found' };

        const membership = await repos.memberships.findById(input.membershipId);
        if (!membership) return { outcome: 'not_found' };

        const granted = await repos.roles.listPermissionsForRole(role.id);
        const held = new Set(actorGrants.permissions);
        const missing = granted.filter((permission) => !held.has(permission as Permission));

        if (missing.length > 0) {
          // The escalation rule. Without it, an administrator of one company could mint
          // authority they do not hold by assigning a role that carries it, which is the
          // classic way a role model becomes a way around itself.
          return { outcome: 'would_escalate', missing: missing as Permission[] };
        }

        await repos.roles.assignToMembership({
          membershipId: input.membershipId,
          roleId: role.id,
        });

        await repos.audit.append({
          action: 'role_assigned',
          entityType: 'membership',
          entityId: input.membershipId,
          summary: `Assigned the ${role.name} role`,
          changes: { role: { key: role.key, permissions: granted } },
        });

        return { outcome: 'applied' };
      },
    );
  }

  /**
   * Takes a role away from a membership.
   *
   * No escalation check, because removing authority cannot create any. It is audited for the
   * same reason the grant is: section 6.6 requires every role change to leave a record, and a
   * removal is the half that matters when someone asks why access stopped.
   */
  async removeRole(input: {
    context: CompanyContext;
    actorUserId: string;
    membershipId: string;
    roleKey: string;
  }): Promise<RoleChangeResult> {
    const { context, actorUserId } = input;

    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      async (repos) => {
        const roles = await repos.roles.listForCompany();
        const role = roles.find((candidate) => candidate.key === input.roleKey);
        if (!role) return { outcome: 'not_found' };

        const membership = await repos.memberships.findById(input.membershipId);
        if (!membership) return { outcome: 'not_found' };

        await repos.roles.removeFromMembership({
          membershipId: input.membershipId,
          roleId: role.id,
        });

        await repos.audit.append({
          action: 'role_removed',
          entityType: 'membership',
          entityId: input.membershipId,
          summary: `Removed the ${role.name} role`,
          changes: { role: { key: role.key } },
        });

        return { outcome: 'applied' };
      },
    );
  }
}
