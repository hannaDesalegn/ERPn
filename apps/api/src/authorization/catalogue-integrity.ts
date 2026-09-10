/**
 * The startup half of the two checks in contract section 2.7.
 *
 * There is no `permissions` table and therefore no foreign key. Section 2.7 replaces it with two
 * checks that catch different failures. The write-time check lives in the role repository and
 * stops configuration inventing a capability. This is the other one: at startup, every stored
 * permission is compared against the catalogue, and a mismatch fails loudly.
 *
 * WHAT IT ACTUALLY CATCHES. Not a bad write, which the first check already refuses. It catches a
 * capability that was removed or renamed in a release. Those rows are still in the database,
 * still look like grants on an administration screen, and now grant nothing at all. Failing the
 * boot turns that into a deployment that stops, which is the moment someone can still write the
 * migration that renames them.
 *
 * WHY IT COSTS A QUERY PER COMPANY. `role_permissions` is tenant and company partitioned, and
 * row level security answers only within one company's context, so there is no single query that
 * spans them. That is the isolation working rather than a limitation to design around, and it is
 * not worth weakening a policy to make a startup check cheaper. If the company count ever makes
 * this slow, the answer is to move the check to a migration or a scheduled job, not to give the
 * application a way to read across companies.
 */

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { systemScope, UnitOfWork } from '../database/index.js';
import { isPermission } from './permissions.js';

/** One company holding at least one permission the catalogue does not define. */
export interface CatalogueMismatch {
  tenantId: string;
  companyId: string;
  unknown: string[];
}

@Injectable()
export class CatalogueIntegrityCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogueIntegrityCheck.name);

  constructor(private readonly uow: UnitOfWork) {}

  async onApplicationBootstrap(): Promise<void> {
    const mismatches = await this.findMismatches();
    if (mismatches.length === 0) return;

    // Loudly, per section 2.7. Thrown rather than logged, so a supervisor treats it as a failed
    // start rather than a healthy process with a warning nobody reads.
    const detail = mismatches
      .map((m) => `company ${m.companyId}: ${m.unknown.join(', ')}`)
      .join('; ');

    this.logger.error(`Stored permissions are not in the catalogue. ${detail}`);
    throw new Error(
      `Stored permissions are not in the catalogue, so they grant nothing to whoever holds them. ${detail}`,
    );
  }

  /**
   * Every company holding a permission the catalogue does not define.
   *
   * Separated from the bootstrap hook so a test can assert what it finds rather than only that
   * something threw, and so an operator can be given the same answer without restarting.
   */
  async findMismatches(): Promise<CatalogueMismatch[]> {
    const mismatches: CatalogueMismatch[] = [];

    const tenants = await this.uow.inSystemScope(systemScope('scheduled-maintenance'), (repos) =>
      repos.tenants.listAll(),
    );

    for (const tenant of tenants) {
      const companies = await this.uow.inSystemScope(
        systemScope('scheduled-maintenance', { tenantId: tenant.id }),
        (repos) => repos.companies.listForTenant(),
      );

      for (const company of companies) {
        const stored = await this.uow.inSystemScope(
          systemScope('scheduled-maintenance', {
            tenantId: tenant.id,
            companyId: company.id,
          }),
          (repos) => repos.roles.listStoredPermissions(),
        );

        const unknown = stored.filter((permission) => !isPermission(permission));
        if (unknown.length > 0) {
          mismatches.push({ tenantId: tenant.id, companyId: company.id, unknown });
        }
      }
    }

    return mismatches;
  }
}
