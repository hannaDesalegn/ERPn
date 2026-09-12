/**
 * Expiring idempotency records, per section 11.
 *
 * Section 11 makes the retention window bounded and says a scheduled job closes it. This is that
 * job. Without it the table only grows, and a store that is never swept stops being a bounded
 * window and becomes a log of every request the system has ever answered.
 *
 * WHY IT SWEEPS COMPANY BY COMPANY RATHER THAN ISSUING ONE DELETE. The table is under row level
 * security keyed on the tenant and the company, so a statement with neither set matches nothing
 * at all: section 2.4 makes every policy deny on an empty context, and that is the behaviour
 * working rather than an obstacle to route around. Section 6.3 then requires a background job to
 * use an explicitly named system context, which is greppable and reviewable. So the sweep walks
 * the tenants and their companies under `scheduled-maintenance`, exactly as the catalogue
 * integrity check already does, and never asks for a way past the scoping.
 *
 * ONE INSTANT FOR THE WHOLE SWEEP. The cutoff is taken once and passed down, so a record does not
 * survive one pass merely because the clock moved while an earlier company was being cleared. The
 * database applies its own `now()` as well through the restrictive policy in migration 0011, so
 * the two agree on anything that matters and the policy is the stricter of them.
 *
 * IT REPORTS RATHER THAN LOGS. The counts come back to the caller, who decides whether they are
 * worth a line. That is partly so a scheduler can record them the way it records everything else,
 * and partly because this file sits beside the ones that handle session tokens and forgery
 * tokens, where `secret-handling.spec.ts` forbids a logger outright. A count is harmless, but an
 * exception carved into that control for a harmless case is how the control stops holding.
 *
 * NO SCHEDULER, AND THAT IS DELIBERATE. The repository carries no scheduling dependency and the
 * contract names none. Adding one would be building deployment infrastructure inside a business
 * increment. What exists here is an operation with a single clear entry point, callable by a
 * deployment's scheduler, by an operator, or by a test. What remains is wiring it to whatever
 * runs it in production.
 */

import { Injectable } from '@nestjs/common';

import { systemScope, UnitOfWork } from '../database/index.js';

export interface ExpirySweep {
  /** The moment every company was compared against. */
  cutoff: Date;
  companiesVisited: number;
  recordsRemoved: number;
}

@Injectable()
export class IdempotencyExpiryService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Removes every idempotency record whose window has closed.
   *
   * Safe to run at any time, as often as wanted, and against a database with nothing to remove.
   * Each company is its own transaction: a sweep is not one atomic act, and holding a transaction
   * open across every company in the deployment to make it one would be a far worse trade than
   * the thing it would buy, which is nothing. A failure part way through leaves the companies
   * already swept swept, and the next run finishes the rest.
   */
  async sweep(now = new Date()): Promise<ExpirySweep> {
    const tenants = await this.uow.inSystemScope(systemScope('scheduled-maintenance'), (repos) =>
      repos.tenants.listAll(),
    );

    let companiesVisited = 0;
    let recordsRemoved = 0;

    for (const tenant of tenants) {
      const companies = await this.uow.inSystemScope(
        systemScope('scheduled-maintenance', { tenantId: tenant.id }),
        (repos) => repos.companies.listForTenant(),
      );

      for (const company of companies) {
        const removed = await this.uow.inSystemScope(
          systemScope('scheduled-maintenance', { tenantId: tenant.id, companyId: company.id }),
          (repos) => repos.idempotency.deleteExpired(now),
        );

        companiesVisited += 1;
        recordsRemoved += removed;
      }
    }

    return { cutoff: now, companiesVisited, recordsRemoved };
  }
}
