/**
 * Creating a company, with the configuration a company cannot function without.
 *
 * WHY THIS EXISTS AT ALL. Until now a company was created by calling `companies.create` on a
 * repository, which writes one row and stops. That was sufficient while a company was only an
 * identity boundary. It stopped being sufficient when sales order confirmation started needing a
 * document number: section 12.2 allocates one inside the confirming transaction, the allocation
 * refuses to invent a sequence it cannot find, and so a company created as a bare row fails the
 * first confirmation of its life. This is the operation that makes that impossible.
 *
 * THE BOUNDARY IS COMPANY CREATION, AND THE CONTRACT SAYS SO TWICE. Section 2.9 lists document
 * numbering series alongside roles and warehouses as configuration held per company. Section 2.7
 * then rules that role templates are seeded into a company when it is created, and from that
 * moment belong to it. A numbering series is the same shape of thing: seeded with a sensible
 * default at creation, owned and edited by the company afterwards. Allocation time is the wrong
 * boundary, and deliberately refuses to be used as one, because a counter invented on demand
 * would issue number one to a company that has been trading for a year.
 *
 * ONE TRANSACTION, AND WHY ALL OF IT AT ONCE. Section 2.7 requires the default role templates
 * to be seeded when a company is created. Section 2.9 holds the numbering series as company
 * configuration. Section 2.6 makes a membership the thing that links a person to a company, and
 * a company with no member is one nobody can act in. None of that is optional, and a company
 * missing any of it is not a company anyone can use, so every write shares one transaction and a
 * failure in any of them leaves nothing behind to be puzzled over later.
 *
 * ORDER FOLLOWS THE SCHEMA. The company row first, because everything else names it by foreign
 * key. The membership and its role assignment last, because the assignment needs both a
 * membership and a seeded role to point at. Between roles and the sequence there is no
 * dependency either way.
 *
 * WHO THE FIRST ADMINISTRATOR IS, THE CONTRACT DOES NOT SAY. It defines the mechanism completely
 * and the origin not at all: section 2.6 gives global accounts and memberships, 2.7 gives the
 * administrator template, and 17.2 says companies come into existence by seeding during this
 * work while putting invitations and the administration UI in a later one. So the account is an
 * argument here. Creating one would mean deciding how a person first gets a credential, which is
 * an authentication rule this increment has no business inventing.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { seedDefaultRolesIn } from '../authorization/role-provisioning.service.js';
import type { SeededRole } from '../authorization/role-provisioning.service.js';
import { ADMINISTRATOR_ROLE_KEY } from '../authorization/permissions.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import type {
  CompanyRecord,
  DocumentNumberSequenceRecord,
  MembershipRecord,
  SystemRepositories,
} from '../database/index.js';
import { provisionSalesOrderSequence } from '../sales/document-numbers.js';

export interface NewCompany {
  /**
   * The tenant the company belongs to, and the company's own identifier.
   *
   * Both are arguments rather than scope, because this is the operation that brings the company
   * into existence: there is no session inside it yet to have resolved them from.
   */
  tenantId: string;
  id: string;
  name: string;
  legalName?: string | null;
  baseCurrency: string;
  /**
   * The existing user account that becomes the company's first administrator.
   *
   * An existing account, never a new one. Section 2.6 makes accounts global to the deployment,
   * one person holding one credential and reaching every company they are a member of through
   * it, so the person who administers a new company either already has an account or is invited
   * to create one. Inventing an account here would be inventing an authentication rule, and
   * section 17.2 puts invitations and self service signup outside this work.
   *
   * Required rather than optional. A company nobody can act in is not usable, and making it
   * optional would make the unusable state representable again, which is the whole thing this
   * operation exists to prevent.
   */
  administratorUserId: string;
}

/** The company's first member, and the role that gives them authority in it. */
export interface FirstAdministrator {
  membership: MembershipRecord;
  roleId: string;
}

export interface ProvisionedCompany {
  company: CompanyRecord;
  /** The company's own copies of the default templates, per section 2.7. */
  roles: SeededRole[];
  salesOrderSequence: DocumentNumberSequenceRecord;
  administrator: FirstAdministrator;
}

@Injectable()
export class CompanyProvisioningService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Creates a company and the configuration it cannot trade without.
   *
   * Runs as a named system scope rather than as an actor, for the same reason role seeding does:
   * it happens when a company is created, and there is nobody inside it yet to act. The scope
   * names the tenant and the company, because the sequence table is partitioned by both and row
   * level security refuses a write that names neither.
   */
  async provision(input: NewCompany): Promise<ProvisionedCompany> {
    return this.uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: input.tenantId, companyId: input.id }),
      async (repositories) => {
        const company = await repositories.companies.create({
          id: input.id,
          name: input.name,
          legalName: input.legalName ?? null,
          baseCurrency: input.baseCurrency,
        });

        // All of these after the company, because each names it by foreign key, and all inside
        // this transaction, so a failure in any of them takes the company with it.
        const roles = await seedDefaultRolesIn(repositories, company.id);
        const salesOrderSequence = await provisionSalesOrderSequence(repositories);

        // Last, because the role assignment needs both a membership and a seeded role to point
        // at. The ordering is the schema's, not a preference.
        const administrator = await this.admit(repositories, roles, input.administratorUserId);

        return { company, roles, salesOrderSequence, administrator };
      },
    );
  }

  /**
   * Makes a user the company's first administrator.
   *
   * TWO RECORDS, AND BOTH ARE THE ORDINARY ONES. A membership, which section 2.6 makes the unit
   * linking a person to a company, and a row assigning them the administrator role that section
   * 2.7 has just seeded. There is no flag on the membership saying this one is special, and no
   * check anywhere asking whether a user is the founder. Authority arrives the same way it will
   * for the second administrator this person appoints next week, which is what keeps section
   * 6.1's dimensions the only thing deciding access.
   *
   * The role is found by key among the templates just seeded, so it is this company's own copy.
   * A role identifier from anywhere else would be another company's row.
   */
  private async admit(
    repositories: Pick<SystemRepositories, 'memberships' | 'roles'>,
    seeded: SeededRole[],
    userId: string,
  ): Promise<FirstAdministrator> {
    const administratorRole = seeded.find((role) => role.key === ADMINISTRATOR_ROLE_KEY);
    if (!administratorRole) {
      // Unreachable while the catalogue defines the template, and loud rather than silent if it
      // ever stops: a company whose first member holds no role is one nobody can administer.
      throw new Error(
        `The ${ADMINISTRATOR_ROLE_KEY} template is missing, so a company cannot be given a first administrator`,
      );
    }

    const membership = await repositories.memberships.create({
      id: randomUUID(),
      // The only field this takes besides its own id. Tenant and company come from the scope,
      // so a membership cannot be created into a company this transaction is not provisioning.
      userId,
    });

    await repositories.roles.assignToMembership({
      membershipId: membership.id,
      roleId: administratorRole.id,
    });

    return { membership, roleId: administratorRole.id };
  }
}
