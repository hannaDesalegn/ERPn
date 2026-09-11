/**
 * The only entry point to the data layer.
 *
 * This is what makes tenant scope mandatory rather than merely conventional. Repositories are
 * never exported as constructible classes and never handed a raw database handle by a caller.
 * The only way to obtain one is to be given it inside a callback that this class has already
 * wrapped in a transaction with the tenant context set. Contract section 6.3.
 *
 * WHY A TRANSACTION IS NOT OPTIONAL. Contract section 2.4 rules that context reaches the
 * database as transaction local settings. `SET LOCAL` outside a transaction does nothing, the
 * setting stays empty, and every policy comparison against an empty setting is false. The
 * result would be a silent, total denial rather than a leak, which is the safe direction, but it
 * would also mean the application simply does not work. Either way there is no path here that
 * runs a scoped query outside a transaction.
 *
 * WHY A DEDICATED CONNECTION. Section 2.4 also requires that a connection is never shared
 * between requests mid-transaction, so context cannot leak from one actor to the next. Each unit
 * of work checks out its own client, sets context on it, and returns it to the pool only after
 * the transaction ends. The pool is used per transaction, not per process.
 */

import { Inject, Injectable } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { DATABASE_POOL } from './tokens.js';
import { DrizzleAuthThrottleRepository } from './repositories/auth-throttle.repository.js';
import {
  DrizzleCustomerRepository,
  DrizzleProductRepository,
  DrizzleWarehouseRepository,
} from './repositories/master-data.repository.js';
import { DrizzleStockLedgerRepository } from './repositories/inventory.repository.js';
import {
  DrizzleDocumentNumberSequenceRepository,
  DrizzleSalesOrderLineRepository,
  DrizzleSalesOrderRepository,
} from './repositories/sales.repository.js';
import {
  DrizzleAuditRepository,
  DrizzleCompanyRepository,
  DrizzleMembershipRepository,
  DrizzleRoleRepository,
  DrizzleSessionRepository,
  DrizzleTenantRepository,
  DrizzleUserRepository,
} from './repositories/implementations.js';
import type {
  PrincipalRepositories,
  ScopedRepositories,
  SystemRepositories,
} from './repositories/types.js';
import { companyIdOf, tenantIdOf, userIdOf } from './scope.js';
import type { ActorScope, PrincipalScope, Scope, SystemScope } from './scope.js';

@Injectable()
export class UnitOfWork {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Runs work as a real person inside one company.
   *
   * The scope comes from the server side session, per contract section 2.5. It is never built
   * from anything the client sent.
   */
  async inActorScope<T>(
    scope: ActorScope,
    work: (repositories: ScopedRepositories) => Promise<T>,
  ): Promise<T> {
    return this.run(scope, work);
  }

  /**
   * Runs work for an authenticated person who has not entered a company.
   *
   * The narrowest scope there is. It reaches the global tables and the reader's own membership
   * rows, which is exactly what resolving company context needs and nothing more. Contract
   * section 2.5: the answer to "which companies may I enter" is computed here, from membership
   * rows, and never taken from the request.
   */
  async inPrincipalScope<T>(
    scope: PrincipalScope,
    work: (repositories: PrincipalRepositories) => Promise<T>,
  ): Promise<T> {
    return this.run(scope, work);
  }

  /**
   * Runs work that belongs to no single actor: provisioning, maintenance, tests.
   *
   * Not an escape hatch. With no tenant named, row level security denies every tenant-scoped
   * row, so the reach is the global tables only. Naming a tenant widens it to that tenant and
   * no further, and the reason is a closed union so every use is greppable.
   */
  async inSystemScope<T>(
    scope: SystemScope,
    work: (repositories: SystemRepositories) => Promise<T>,
  ): Promise<T> {
    return this.run(scope, work);
  }

  private async run<T, R extends ScopedRepositories | PrincipalRepositories | SystemRepositories>(
    scope: Scope,
    work: (repositories: R) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // `set_config(name, value, true)` is SET LOCAL: it lives for this transaction and is
      // discarded on commit or rollback, so nothing survives onto the pooled connection.
      //
      // Parameterised, not interpolated. Contract section 14.2 permits no SQL assembled by
      // string concatenation, and a context value spliced into a statement would be the one
      // place an injection could rewrite the tenant boundary itself.
      await client.query('SELECT set_config($1, $2, true)', [
        'app.tenant_id',
        tenantIdOf(scope) ?? '',
      ]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.company_id',
        companyIdOf(scope) ?? '',
      ]);
      // The third context setting, added by migration 0004. Empty for a system scope, which has
      // no person behind it, and empty is a denial rather than a wildcard.
      await client.query('SELECT set_config($1, $2, true)', [
        'app.user_id',
        userIdOf(scope) ?? '',
      ]);

      const db = drizzle(client) as NodePgDatabase<Record<string, never>>;
      const repositories = buildRepositories(db, scope) as R;

      const result = await work(repositories);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      // Returns the connection to the pool. The transaction local settings are already gone.
      client.release();
    }
  }
}

function buildRepositories(
  db: NodePgDatabase<Record<string, never>>,
  scope: Scope,
): ScopedRepositories & PrincipalRepositories & SystemRepositories {
  return {
    companies: new DrizzleCompanyRepository(db, scope),
    memberships: new DrizzleMembershipRepository(db, scope),
    roles: new DrizzleRoleRepository(db, scope),
    sessions: new DrizzleSessionRepository(db, scope),
    tenants: new DrizzleTenantRepository(db, scope),
    users: new DrizzleUserRepository(db, scope),
    audit: new DrizzleAuditRepository(db, scope),
    authThrottle: new DrizzleAuthThrottleRepository(db),
    customers: new DrizzleCustomerRepository(db, scope),
    products: new DrizzleProductRepository(db, scope),
    warehouses: new DrizzleWarehouseRepository(db, scope),
    salesOrders: new DrizzleSalesOrderRepository(db, scope),
    salesOrderLines: new DrizzleSalesOrderLineRepository(db, scope),
    documentNumberSequences: new DrizzleDocumentNumberSequenceRepository(db, scope),
    stockLedger: new DrizzleStockLedgerRepository(db, scope),
  };
}


/**
 * A rollback that itself fails must not mask the error that caused it.
 *
 * This happens for real: a connection dropped mid-transaction makes ROLLBACK throw, and the
 * original error is the one worth seeing.
 */
async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Intentionally swallowed. The caller receives the original failure.
  }
}
