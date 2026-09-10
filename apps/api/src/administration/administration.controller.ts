/**
 * Company administration reads and role changes.
 *
 * These are the first routes in the system that require a capability rather than merely a
 * session, and they exist for that reason as much as for their own. Section 6.2 requires deny by
 * default and criterion 8 requires a 403 for an authenticated caller without the permission;
 * neither is testable against a surface where every route is open to any signed-in user.
 *
 * They are also the operations criterion 11 needs: a user must not be able to assign a role
 * carrying permissions they do not hold, which cannot be proved without a way to assign one.
 *
 * TWO CAPABILITIES, NOT ONE. Membership and role administration needs `admin:users`, which only
 * the administrator template carries. Reading the company's trail needs `audit:view`, which the
 * manager and the accountant carry too. That difference is what makes the matrix test say
 * something: with a single permission across every route, every role would sort into "all" or
 * "nothing" and a bug that granted too much would look identical to correct behaviour.
 *
 * WHAT IS NOT HERE. No company administration screens, which section 17.2 puts outside slice 1,
 * and no user creation or invitation. This is the smallest surface that makes the authorization
 * layer real rather than theoretical.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { RequirePermission } from '../authorization/route-access.js';
import { RoleProvisioningService } from '../authorization/role-provisioning.service.js';
import { actorScope, UnitOfWork } from '../database/index.js';
import { principalOf } from '../http/principal.js';
import { IdentityService, type CompanyContext } from '../identity/identity.service.js';

const assignBody = z.object({
  /** A role key from this company, not an identifier and never a permission list. */
  roleKey: z.string().min(1).max(64),
});

const identifier = z.string().uuid();

export interface MemberView {
  id: string;
  userId: string;
  status: string;
}

export interface AuditEventView {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  actorUserId: string | null;
}

@Controller()
export class AdministrationController {
  constructor(
    private readonly identity: IdentityService,
    private readonly provisioning: RoleProvisioningService,
    private readonly uow: UnitOfWork,
  ) {}

  @RequirePermission('admin:users')
  @Get('members')
  async members(@Req() request: FastifyRequest): Promise<MemberView[]> {
    const { context, userId } = await this.contextOf(request);

    return this.uow.inActorScope(
      actorScope({ tenantId: context.tenantId, companyId: context.companyId, userId }),
      async (repos) => {
        const memberships = await repos.memberships.listForCompany();

        return memberships.map((membership) => ({
          id: membership.id,
          userId: membership.userId,
          status: membership.status,
        }));
      },
    );
  }

  @RequirePermission('admin:users')
  @Get('roles')
  async roles(@Req() request: FastifyRequest): Promise<{ key: string; name: string }[]> {
    const { context, userId } = await this.contextOf(request);

    return this.uow.inActorScope(
      actorScope({ tenantId: context.tenantId, companyId: context.companyId, userId }),
      async (repos) => {
        const roles = await repos.roles.listForCompany();
        return roles.map((role) => ({ key: role.key, name: role.name }));
      },
    );
  }

  @RequirePermission('admin:users')
  @Post('members/:membershipId/roles')
  async assignRole(
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ outcome: string }> {
    const parsed = assignBody.safeParse(body);
    if (!parsed.success || !identifier.safeParse(membershipId).success) {
      throw new NotFoundException('Not found');
    }

    const { context, userId } = await this.contextOf(request);

    const result = await this.provisioning.assignRole({
      context,
      actorUserId: userId,
      membershipId,
      roleKey: parsed.data.roleKey,
    });

    if (result.outcome === 'not_found') throw new NotFoundException('Not found');
    if (result.outcome === 'would_escalate') {
      // Section 6.6, surfaced rather than hidden. The caller has already proved membership and
      // `admin:users` in this company, so naming the rule tells them nothing they could not
      // learn from the role list they are entitled to read, and hiding it would leave an
      // administrator unable to tell a refusal from a bug.
      throw new ForbiddenException('That role grants permissions you do not hold');
    }

    return { outcome: result.outcome };
  }

  @RequirePermission('admin:users')
  @Delete('members/:membershipId/roles/:roleKey')
  async removeRole(
    @Param('membershipId') membershipId: string,
    @Param('roleKey') roleKey: string,
    @Req() request: FastifyRequest,
  ): Promise<{ outcome: string }> {
    if (!identifier.safeParse(membershipId).success) throw new NotFoundException('Not found');

    const { context, userId } = await this.contextOf(request);

    const result = await this.provisioning.removeRole({
      context,
      actorUserId: userId,
      membershipId,
      roleKey,
    });

    if (result.outcome !== 'applied') throw new NotFoundException('Not found');

    return { outcome: result.outcome };
  }

  @RequirePermission('audit:view')
  @Get('audit-events')
  async auditEvents(
    @Req() request: FastifyRequest,
    @Query('limit') limit?: string,
  ): Promise<AuditEventView[]> {
    const { context, userId } = await this.contextOf(request);
    const requested = Number.parseInt(limit ?? '50', 10);

    return this.uow.inActorScope(
      actorScope({ tenantId: context.tenantId, companyId: context.companyId, userId }),
      async (repos) => {
        const events = await repos.audit.listForCompany(
          Number.isFinite(requested) ? requested : 50,
        );

        // Deliberately not the whole row. `changes`, the request id, the address and the user
        // agent are not sent here: section 6.4 puts field level restriction at serialisation,
        // and the narrow shape is the safe default to widen from rather than the wide one to
        // remember to narrow.
        return events.map((event) => ({
          id: event.id,
          occurredAt: event.occurredAt.toISOString(),
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId ?? null,
          summary: event.summary,
          actorUserId: event.actorUserId,
        }));
      },
    );
  }

  /**
   * The company this request is operating in.
   *
   * The guard already resolved and verified it before allowing the request through, so this
   * cannot fail in practice. It is re-derived rather than passed along because a context handed
   * from a guard to a controller through the request object is a value someone will eventually
   * set from somewhere else, and the cost of asking again is one query.
   */
  private async contextOf(
    request: FastifyRequest,
  ): Promise<{ context: CompanyContext; userId: string }> {
    const principal = principalOf(request);
    const context = await this.identity.currentContext(principal);

    if (!context) throw new ForbiddenException('Forbidden');

    return { context, userId: principal.userId };
  }
}
