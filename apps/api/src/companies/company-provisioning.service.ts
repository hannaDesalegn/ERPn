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
 * ONE TRANSACTION. The company row and its sequence are written together or not at all. A
 * company that exists without its sequence is the exact state this service is here to prevent,
 * and it is worse than no company, because nothing about it looks wrong until someone confirms
 * an order.
 *
 * WHAT IS NOT HERE YET. Default roles are still seeded by a separate call into
 * `RoleProvisioningService`, in a transaction of its own. That split predates this file and
 * unifying it would mean rewriting role provisioning, which belongs in its own increment rather
 * than smuggled into this one. It is recorded rather than hidden.
 */

import { Injectable } from '@nestjs/common';

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

        // After the company, because the sequence's foreign key names it. Inside the same
        // transaction, so a failure here takes the company with it.
        const salesOrderSequence = await provisionSalesOrderSequence(repositories);

        return { company, salesOrderSequence };
      },
    );
  }
}
