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
 * ONE TRANSACTION, AND WHY ALL OF IT AT ONCE. Section 2.7 requires the default role
 * templates to be seeded when a company is created. Section 2.9 holds the numbering series as
 * company configuration. Neither is optional, and a company missing either is not a company
 * anyone can use: without roles nobody can be given authority in it, and without the sequence
 * the first confirmation fails. So all three writes share one transaction, and a failure in any
 * of them leaves nothing behind to be puzzled over later.
 *
 * ORDER MATTERS ONLY IN ONE RESPECT. The company row is written first because both of the others
 * name it by foreign key. Between roles and the sequence there is no dependency either way.
 */

import { Injectable } from '@nestjs/common';

import { seedDefaultRolesIn } from '../authorization/role-provisioning.service.js';
import type { SeededRole } from '../authorization/role-provisioning.service.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import type { CompanyRecord, DocumentNumberSequenceRecord } from '../database/index.js';
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
}

export interface ProvisionedCompany {
  company: CompanyRecord;
  /** The company's own copies of the default templates, per section 2.7. */
  roles: SeededRole[];
  salesOrderSequence: DocumentNumberSequenceRecord;
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

        // Both after the company, because each names it by foreign key, and both inside this
        // transaction, so a failure in either takes the company with it.
        const roles = await seedDefaultRolesIn(repositories, company.id);
        const salesOrderSequence = await provisionSalesOrderSequence(repositories);

        return { company, roles, salesOrderSequence };
      },
    );
  }
}
