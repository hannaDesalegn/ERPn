/**
 * The guard every company-partitioned repository starts with.
 *
 * Contract section 6.3 requires every repository method to take an actor context and makes an
 * unscoped query impossible to construct through the public interface. This is where that
 * becomes a refusal rather than a convention, for the tables a company owns outright.
 *
 * WHY IT THROWS RATHER THAN RETURNING NOTHING. A scope missing its tenant or its company is a
 * caller with a bug, not a company with no rows. Returning an empty list would let that bug read
 * as "this company has no customers", which is a sentence someone will believe.
 *
 * WHY BOTH HALVES. These tables are partitioned by company, not merely scoped by tenant. Unlike
 * `companies` and `memberships`, which company switching has to read across, a customer, a
 * product, a warehouse and a sales document each belong to exactly one company, so a tenant
 * alone is not a scope for them.
 *
 * The identity repositories in `implementations.ts` keep their own guards, because several of
 * them are legitimately tenant-only and need the two halves separately.
 */

import type { Scope } from '../scope.js';
import { companyIdOf, tenantIdOf } from '../scope.js';

export interface CompanyScope {
  tenantId: string;
  companyId: string;
}

export function requireCompanyScope(scope: Scope, subject: string): CompanyScope {
  const tenantId = tenantIdOf(scope);
  const companyId = companyIdOf(scope);

  if (!tenantId || !companyId) {
    throw new Error(
      `A company-partitioned repository was used under a ${scope.kind} scope naming ${
        tenantId ? 'no company' : 'no tenant'
      }. ${subject} belong to exactly one company.`,
    );
  }

  return { tenantId, companyId };
}
