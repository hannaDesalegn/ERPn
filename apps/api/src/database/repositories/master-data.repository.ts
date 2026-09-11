/**
 * Master data access. INTERNAL, like every other repository implementation.
 *
 * Nothing here is re-exported from the data layer's public entry point. These classes are
 * constructed only by `UnitOfWork`, inside a transaction whose tenant and company context is
 * already set. Contract section 6.3: constructing an unscoped query must not be possible through
 * the public interface of the data layer.
 *
 * THE SAME TWO RULES AS EVERY OTHER REPOSITORY HERE:
 *
 *   1. The scope predicate is in the query, not applied afterwards. A customer belonging to
 *      another company is not among the rows the query can return, rather than being fetched and
 *      then rejected. Section 6.3 rejects fetch-then-check because it is correct only if every
 *      caller remembers.
 *   2. Writes stamp `tenant_id` and `company_id` from the scope, never from the input. The input
 *      types carry no field to supply them, which is the first line of defence, this is the
 *      second, and row level security is the third.
 *
 * NO DELETE, ANYWHERE. Section 4.5: business records are archived, never hard deleted, and the
 * application role holds no `DELETE` grant on these tables. `archive` is what replaces it, and
 * it is the only update this layer offers: the rest of master data editing arrives with the
 * administration increment that needs it.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { customers, warehouses } from '../schema/master-data.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import {
  ConcurrencyConflictError,
  RecordNotFoundError,
  type ArchiveRequest,
  type CustomerRecord,
  type CustomerRepository,
  type NewCustomer,
  type NewWarehouse,
  type WarehouseRecord,
  type WarehouseRepository,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

const CUSTOMERS = 'Customers';
const WAREHOUSES = 'Warehouses';

// ---------------------------------------------------------------------------------------
// Customers.
// ---------------------------------------------------------------------------------------

export class DrizzleCustomerRepository implements CustomerRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<CustomerRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, CUSTOMERS);

    const rows = await this.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, id),
          eq(customers.tenantId, tenantId),
          eq(customers.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toCustomer(rows[0]) : null;
  }

  /**
   * Lookup by the code humans use.
   *
   * Scoped like every other read, which is what makes the code safe to look up at all: it is
   * unique within a company and not globally, so an unscoped query would match several rows
   * across tenants and return whichever came first.
   */
  async findByCode(code: string): Promise<CustomerRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, CUSTOMERS);

    const rows = await this.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.code, code),
          eq(customers.tenantId, tenantId),
          eq(customers.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async listForCompany(): Promise<CustomerRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, CUSTOMERS);

    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.companyId, companyId)))
      .orderBy(asc(customers.name));

    return rows.map(toCustomer);
  }

  async create(input: NewCustomer): Promise<CustomerRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, CUSTOMERS);

    const rows = await this.db
      .insert(customers)
      .values({
        id: input.id,
        // From the scope. `NewCustomer` has no field with which to claim another company.
        tenantId,
        companyId,
        code: input.code,
        name: input.name,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toCustomer(row);
  }

  async archive(input: ArchiveRequest): Promise<CustomerRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, CUSTOMERS);

    // The version is part of the WHERE clause, so a stale write updates nothing rather than
    // overwriting someone else's edit. Section 10.1.
    const rows = await this.db
      .update(customers)
      .set({
        status: 'archived',
        version: sql`${customers.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(customers.id, input.id),
          eq(customers.tenantId, tenantId),
          eq(customers.companyId, companyId),
          eq(customers.version, input.expectedVersion),
        ),
      )
      .returning();

    const row = rows[0];
    if (row) return toCustomer(row);

    // Nothing updated. Distinguish gone-or-not-yours from someone-got-there-first, without
    // leaking which: both look identical to a caller in another company.
    const current = await this.findById(input.id);
    if (!current) throw new RecordNotFoundError('Customer', input.id);
    throw new ConcurrencyConflictError('Customer', input.id);
  }
}

// ---------------------------------------------------------------------------------------
// Warehouses.
// ---------------------------------------------------------------------------------------

export class DrizzleWarehouseRepository implements WarehouseRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<WarehouseRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, WAREHOUSES);

    const rows = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.id, id),
          eq(warehouses.tenantId, tenantId),
          eq(warehouses.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toWarehouse(rows[0]) : null;
  }

  async findByCode(code: string): Promise<WarehouseRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, WAREHOUSES);

    const rows = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.code, code),
          eq(warehouses.tenantId, tenantId),
          eq(warehouses.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toWarehouse(rows[0]) : null;
  }

  /**
   * The company's default warehouse, or null when it has not chosen one.
   *
   * At most one row can match, which is a partial unique index rather than a rule this query
   * has to trust. Null is a real answer: a company with no default is a company whose orders
   * must name a warehouse explicitly.
   */
  async findDefault(): Promise<WarehouseRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, WAREHOUSES);

    const rows = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.isDefault, true),
          eq(warehouses.tenantId, tenantId),
          eq(warehouses.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toWarehouse(rows[0]) : null;
  }

  async listForCompany(): Promise<WarehouseRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, WAREHOUSES);

    const rows = await this.db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.companyId, companyId)))
      .orderBy(asc(warehouses.code));

    return rows.map(toWarehouse);
  }

  async create(input: NewWarehouse): Promise<WarehouseRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, WAREHOUSES);

    const rows = await this.db
      .insert(warehouses)
      .values({
        id: input.id,
        tenantId,
        companyId,
        code: input.code,
        name: input.name,
        isDefault: input.isDefault ?? false,
        // Section 8.5 defaults to deny, and so does this. A warehouse that permits negative
        // stock is a deliberate choice rather than something a missing field produces.
        allowNegativeStock: input.allowNegativeStock ?? false,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toWarehouse(row);
  }

  async archive(input: ArchiveRequest): Promise<WarehouseRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, WAREHOUSES);

    const rows = await this.db
      .update(warehouses)
      .set({
        status: 'archived',
        version: sql`${warehouses.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(warehouses.id, input.id),
          eq(warehouses.tenantId, tenantId),
          eq(warehouses.companyId, companyId),
          eq(warehouses.version, input.expectedVersion),
        ),
      )
      .returning();

    const row = rows[0];
    if (row) return toWarehouse(row);

    const current = await this.findById(input.id);
    if (!current) throw new RecordNotFoundError('Warehouse', input.id);
    throw new ConcurrencyConflictError('Warehouse', input.id);
  }
}

// ---------------------------------------------------------------------------------------
// Row mapping and small helpers.
// ---------------------------------------------------------------------------------------

type CustomerRow = typeof customers.$inferSelect;
type WarehouseRow = typeof warehouses.$inferSelect;

function toCustomer(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
  };
}

function toWarehouse(row: WarehouseRow): WarehouseRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    status: row.status,
    isDefault: row.isDefault,
    allowNegativeStock: row.allowNegativeStock,
    version: row.version,
  };
}
