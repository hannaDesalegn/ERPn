/**
 * Sales document data access. INTERNAL, like every other repository implementation.
 *
 * Nothing here is re-exported from the data layer's public entry point. These classes are
 * constructed only by `UnitOfWork`, inside a transaction whose tenant and company context is
 * already set. Contract section 6.3: constructing an unscoped query must not be possible through
 * the public interface of the data layer.
 *
 * THE TWO RULES EVERY METHOD FOLLOWS, and which a reviewer should check for:
 *
 *   1. The scope predicate is in the query, not applied afterwards. A sales order belonging to
 *      another company does not fail an ownership check here; it is not among the rows the query
 *      can return. Section 6.3 is explicit that fetch-then-check is the wrong shape, because it
 *      is correct only if every caller remembers.
 *   2. Writes stamp `tenant_id` and `company_id` from the scope, never from the input. The input
 *      types carry no field to supply them, which is the first line of defence, and this is the
 *      second. Row level security is the third.
 *
 * WHAT IS DELIBERATELY ABSENT. No confirmation and no reservation. Section 12.2 makes confirming
 * one transaction that does six things, and most of them are not data access. Putting any of
 * them here would be the moment this layer stopped being a data layer. `applyTransition` writes
 * a status the caller has already decided is legal; it does not decide.
 *
 * THE ONE EXCEPTION IS NUMBER ALLOCATION, at the bottom of this file. It is step four of that
 * same transaction and it lives here because it is a row lock and an increment, which is data
 * access and nothing else. What surrounds it, deciding that an order may be confirmed at all,
 * is not here.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  documentNumberSequences,
  salesOrderLines,
  salesOrders,
} from '../schema/sales.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { formatDocumentNumber } from '../../shared/document-number.js';
import { requireCompanyScope } from './company-scope.js';
import {
  ConcurrencyConflictError,
  DocumentNumberSequenceMissingError,
  RecordNotFoundError,
} from './types.js';
import type {
  AllocatedDocumentNumber,
  DocumentNumberSequenceRecord,
  DocumentNumberSequenceRepository,
  NewDocumentNumberSequence,
  NewSalesOrder,
  NewSalesOrderLine,
  SalesOrderLineRecord,
  SalesOrderLineRepository,
  SalesOrderRecord,
  SalesOrderRepository,
  SalesOrderTotals,
  SalesOrderTransition,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

// ---------------------------------------------------------------------------------------
// Sales orders.
// ---------------------------------------------------------------------------------------

export class DrizzleSalesOrderRepository implements SalesOrderRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<SalesOrderRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .select()
      .from(salesOrders)
      .where(
        and(
          eq(salesOrders.id, id),
          eq(salesOrders.tenantId, tenantId),
          eq(salesOrders.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toSalesOrder(rows[0]) : null;
  }

  async listForCompany(): Promise<SalesOrderRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.companyId, companyId)))
      .orderBy(desc(salesOrders.orderDate), desc(salesOrders.createdAt));

    return rows.map(toSalesOrder);
  }

  /**
   * Creates a draft.
   *
   * There is nothing else to create. The table refuses any other status without a document
   * number, and numbers are allocated by the confirming transaction, so `status` and
   * `docNumber` are not parameters: they are what the schema already says a new order is.
   */
  async create(input: NewSalesOrder): Promise<SalesOrderRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .insert(salesOrders)
      .values({
        id: input.id,
        // From the scope. `NewSalesOrder` has no field with which to claim another company.
        tenantId,
        companyId,
        customerId: input.customerId,
        warehouseId: input.warehouseId,
        salesRepUserId: input.salesRepUserId ?? null,
        orderDate: input.orderDate,
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        currency: input.currency,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toSalesOrder(row);
  }

  /**
   * Writes a status change and the document number together.
   *
   * The version and the expected status are both in the predicate. Under section 10.1 that is
   * what makes two concurrent confirmations resolve to one: both read a draft at the same
   * version, both do the work, and the second matches no row and is told the order moved under
   * it. Section 10.2 does not list sales order rows among those needing a pessimistic lock, so
   * this is the optimistic mechanism the contract actually asks for here.
   */
  async applyTransition(input: SalesOrderTransition): Promise<SalesOrderRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .update(salesOrders)
      .set({
        status: input.status,
        docNumber: input.docNumber,
        version: sql`${salesOrders.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(salesOrders.id, input.id),
          eq(salesOrders.tenantId, tenantId),
          eq(salesOrders.companyId, companyId),
          eq(salesOrders.version, input.expectedVersion),
          eq(salesOrders.status, input.expectedStatus),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) throw new ConcurrencyConflictError('Sales order', input.id);
    return toSalesOrder(row);
  }

  async setTotals(input: SalesOrderTotals): Promise<SalesOrderRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .update(salesOrders)
      .set({
        subtotal: input.subtotal,
        taxTotal: input.taxTotal,
        total: input.total,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(salesOrders.id, input.id),
          eq(salesOrders.tenantId, tenantId),
          eq(salesOrders.companyId, companyId),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) throw new RecordNotFoundError('Sales order', input.id);
    return toSalesOrder(row);
  }
}

// ---------------------------------------------------------------------------------------
// Sales order lines.
// ---------------------------------------------------------------------------------------

export class DrizzleSalesOrderLineRepository implements SalesOrderLineRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<SalesOrderLineRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .select()
      .from(salesOrderLines)
      .where(
        and(
          eq(salesOrderLines.id, id),
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrderLines.companyId, companyId),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? toSalesOrderLine(row) : null;
  }

  async listForOrder(salesOrderId: string): Promise<SalesOrderLineRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    // Scoped as well as filtered by order. An order identifier from another company matches no
    // line rather than returning that company's lines, which is the shape section 6.3 asks for
    // rather than a check performed after the rows come back.
    const rows = await this.db
      .select()
      .from(salesOrderLines)
      .where(
        and(
          eq(salesOrderLines.salesOrderId, salesOrderId),
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrderLines.companyId, companyId),
        ),
      )
      .orderBy(asc(salesOrderLines.lineNumber));

    return rows.map(toSalesOrderLine);
  }

  async create(input: NewSalesOrderLine): Promise<SalesOrderLineRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .insert(salesOrderLines)
      .values({
        id: input.id,
        tenantId,
        companyId,
        salesOrderId: input.salesOrderId,
        lineNumber: input.lineNumber,
        productId: input.productId,
        productSku: input.productSku,
        productName: input.productName,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        discountPercent: input.discountPercent ?? '0',
        taxRatePercent: input.taxRatePercent ?? '0',
        currency: input.currency,
        lineSubtotal: input.lineSubtotal ?? '0',
        lineTax: input.lineTax ?? '0',
        lineTotal: input.lineTotal ?? '0',
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toSalesOrderLine(row);
  }

  async remove(id: string): Promise<void> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    await this.db
      .delete(salesOrderLines)
      .where(
        and(
          eq(salesOrderLines.id, id),
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrderLines.companyId, companyId),
        ),
      );
  }
}

// ---------------------------------------------------------------------------------------
// Document number sequences.
// ---------------------------------------------------------------------------------------

export class DrizzleDocumentNumberSequenceRepository
  implements DocumentNumberSequenceRepository
{
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findForDocType(docType: string): Promise<DocumentNumberSequenceRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    // A plain read, with no lock. Allocation takes the lock inside the transaction that creates
    // the document, and that is not this increment. A reader that took the lock here would
    // serialise every caller that only wanted to know the prefix.
    const rows = await this.db
      .select()
      .from(documentNumberSequences)
      .where(
        and(
          eq(documentNumberSequences.docType, docType),
          eq(documentNumberSequences.tenantId, tenantId),
          eq(documentNumberSequences.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toSequence(rows[0]) : null;
  }

  async listForCompany(): Promise<DocumentNumberSequenceRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .select()
      .from(documentNumberSequences)
      .where(
        and(
          eq(documentNumberSequences.tenantId, tenantId),
          eq(documentNumberSequences.companyId, companyId),
        ),
      )
      .orderBy(asc(documentNumberSequences.docType));

    return rows.map(toSequence);
  }

  async create(input: NewDocumentNumberSequence): Promise<DocumentNumberSequenceRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    const rows = await this.db
      .insert(documentNumberSequences)
      .values({
        id: input.id,
        tenantId,
        companyId,
        docType: input.docType,
        prefix: input.prefix ?? '',
        gapless: input.gapless ?? true,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toSequence(row);
  }

  /**
   * Takes the next number, under an explicit row lock.
   *
   * TWO STATEMENTS, DELIBERATELY.
   *
   * The first is `SELECT ... FOR UPDATE`, which is the lock section 10.4 describes. A second
   * transaction reaching this line for the same sequence blocks here until this one commits or
   * rolls back, so two transactions cannot read the same counter value. An `UPDATE` alone would
   * take the same lock, but it would take it as a side effect of a write, and the thing this
   * mechanism is for deserves to be visible rather than implied.
   *
   * The second increments. The new value is computed by the database from the locked row
   * (`next_value + 1`), never from the value this process read, so even a stale read cannot
   * produce a repeat. The allocated number is the value before the increment, which is what
   * `RETURNING` lets us recover without a third statement.
   *
   * WHAT MAKES IT GAPLESS. Nothing here commits. Both statements belong to the caller's
   * transaction, so if the document write that follows fails, the increment is rolled back with
   * it and the number is still unissued. That is the whole reason section 10.4 accepts the
   * serialisation cost of a locked row over a database sequence, which would have committed the
   * increment independently and left a hole.
   *
   * THE `gapless` FLAG IS NOT READ. One mechanism serves both settings: a gapless sequence is a
   * stricter promise than a gap tolerant one, so a sequence marked gap tolerant is simply
   * getting more than it asked for. The flag stays because section 10.4 makes the choice a per
   * sequence setting, and the faster lock free path for sequences that do not need gaplessness
   * is an optimisation to make when one is measurably too slow, not before.
   */
  async allocate(docType: string): Promise<AllocatedDocumentNumber> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Sales documents');

    // The scope is in the predicate, not checked afterwards, so this cannot lock or advance
    // another company's counter: those rows are not among the ones the query can return. Row
    // level security refuses them a second time.
    const belongsHere = and(
      eq(documentNumberSequences.docType, docType),
      eq(documentNumberSequences.tenantId, tenantId),
      eq(documentNumberSequences.companyId, companyId),
    );

    const locked = await this.db
      .select()
      .from(documentNumberSequences)
      .where(belongsHere)
      .limit(1)
      .for('update');

    const sequence = locked[0];
    if (!sequence) throw new DocumentNumberSequenceMissingError(docType);

    const updated = await this.db
      .update(documentNumberSequences)
      .set({
        nextValue: sql`${documentNumberSequences.nextValue} + 1`,
        // `version`, `updated_at` and `updated_by` are untouched on purpose. They record who
        // last configured this sequence, per section 10.1's optimistic locking on edits, and
        // allocation is not a configuration change. Bumping the version would make every
        // allocation collide with an administrator's open edit of the prefix.
      })
      .where(and(eq(documentNumberSequences.id, sequence.id), belongsHere))
      .returning();

    const row = updated[0];
    if (!row) throw new Error('The locked sequence row vanished before it could be incremented');

    // The value now in the row is the next one to issue, so the one just allocated is one less.
    const value = row.nextValue - 1n;

    return { docType, value, formatted: formatDocumentNumber(row.prefix, value) };
  }
}

// ---------------------------------------------------------------------------------------
// Row mapping. Persistence rows are not the shape the application passes around.
// ---------------------------------------------------------------------------------------

type SalesOrderRow = typeof salesOrders.$inferSelect;
type SalesOrderLineRow = typeof salesOrderLines.$inferSelect;
type SequenceRow = typeof documentNumberSequences.$inferSelect;

function toSalesOrder(row: SalesOrderRow): SalesOrderRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    docNumber: row.docNumber,
    status: row.status,
    customerId: row.customerId,
    warehouseId: row.warehouseId,
    salesRepUserId: row.salesRepUserId,
    orderDate: row.orderDate,
    expectedDeliveryDate: row.expectedDeliveryDate,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    version: row.version,
  };
}

function toSalesOrderLine(row: SalesOrderLineRow): SalesOrderLineRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    salesOrderId: row.salesOrderId,
    lineNumber: row.lineNumber,
    productId: row.productId,
    productSku: row.productSku,
    productName: row.productName,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    discountPercent: row.discountPercent,
    taxRatePercent: row.taxRatePercent,
    currency: row.currency,
    lineSubtotal: row.lineSubtotal,
    lineTax: row.lineTax,
    lineTotal: row.lineTotal,
    deliveredQuantity: row.deliveredQuantity,
    invoicedQuantity: row.invoicedQuantity,
    version: row.version,
  };
}

function toSequence(row: SequenceRow): DocumentNumberSequenceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    docType: row.docType,
    prefix: row.prefix,
    gapless: row.gapless,
    nextValue: row.nextValue,
    version: row.version,
  };
}
