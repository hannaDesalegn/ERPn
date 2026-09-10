/**
 * `/me` and the company switch.
 *
 * Criterion 6 and section 2.5. The whole security argument for these two routes is in what they
 * do not read.
 *
 * `GET /me` takes no input at all. Not a company parameter, not a tenant parameter, not a user
 * parameter. Everything it reports is derived from the session the guard resolved, so there is
 * nothing in the request for a caller to change and no version of this handler that could serve
 * one person another's answer.
 *
 * `POST /me/company` takes exactly one field, and it is a selection rather than an authority.
 * The identity service matches it against the memberships that person already holds and refuses
 * anything else with the same answer it gives for a company that does not exist. A tenant
 * identifier is not accepted here in any form, because the tenant is derived from the membership
 * and accepting one would create a second, client controlled answer to a question the server
 * already knows.
 */

import { Body, Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { principalOf, SessionGuard } from '../http/session.guard.js';
import { IdentityService, type MeView } from './identity.service.js';

const switchBody = z.object({
  companyId: z.string().min(1).max(64),
});

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private readonly identity: IdentityService) {}

  @Get()
  me(@Req() request: FastifyRequest): Promise<MeView> {
    return this.identity.describe(principalOf(request));
  }

  /**
   * Enters one of the caller's companies.
   *
   * Answers with the same view `/me` returns, so a client never has to guess what changed or
   * hold its own idea of the active company. The view is recomputed from the session after the
   * switch rather than assembled from what was just requested.
   */
  @Post('company')
  async switchCompany(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<MeView> {
    const parsed = switchBody.safeParse(body);
    // A malformed body is a company that cannot be found, not a validation report. The three
    // refusals this endpoint can make must be indistinguishable, per criterion 15, and a
    // validation error would be a fourth shape that says the identifier was at least well formed.
    if (!parsed.success) throw companyNotFound();

    const principal = principalOf(request);
    const result = await this.identity.switchCompany({
      principal,
      companyId: parsed.data.companyId,
    });

    if (result.outcome !== 'switched') throw companyNotFound();

    return this.identity.describe({ ...principal, activeCompanyId: result.context.companyId });
  }
}

/**
 * Not a member, another tenant, and does not exist, all answered identically.
 *
 * Built in one place so the three cannot drift apart later. Section 6.1: a failure at the tenant
 * dimension is indistinguishable from the record not existing.
 */
function companyNotFound(): NotFoundException {
  return new NotFoundException('Company not found');
}
