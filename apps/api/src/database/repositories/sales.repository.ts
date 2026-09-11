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
 * WHAT IS DELIBERATELY ABSENT. No number allocation, no confirmation, no total recalculation, no
 * state transition, no reservation. Section 12.2 makes confirming one transaction that does six
 * things, and five of them are not data access. Putting any of them here would be the moment
 * this layer stopped being a data layer.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  documentNumberSequences,
  salesOrderLines,
  salesOrders,
} from '../schema/sales.js';
import type { Scope } from '../scope.js';
import { actingUserId, companyIdOf, tenantIdOf } from '../scope.js';
import type {
  DocumentNumberSequenceRecord,
  DocumentNumberSequenceRepository,
  NewDocumentNumberSequence,
  NewSalesOrder,
  NewSalesOrderLine,
  SalesOrderLineRecord,
  SalesOrderLineRepository,
  SalesOrderRecord,
  SalesOrderRepository,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * The tenant and company a scope acts within, or a refusal.
 *
 * Every table in this file is company partitioned, so both halves are required and neither has a
 * meaningful default. A scope missing either has a bug rather than an empty database, and saying
 * so here is better than returning nothing and letting a caller conclude the company is empty.
 */
function requireScope(scope: Scope): { tenantId: string; companyId: string } {
  const tenantId = tenantIdOf(scope);
  const companyId = companyIdOf(scope);

  if (!tenantId || !companyId) {
    throw new Error(
      `A company-partitioned sales repository was used under a ${scope.kind} scope naming ${
        tenantId ? 'no company' : 'no tenant'
      }. Sales documents belong to exactly one company.`,
    );
  }

  return { tenantId, companyId };
}

// ---------------------------------------------------------------------------------------
// Sales orders.
// ---------------------------------------------------------------------------------------

export class DrizzleSalesOrderRepository implements SalesOrderRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<SalesOrderRecord | null> {
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
}

// ---------------------------------------------------------------------------------------
// Sales order lines.
// ---------------------------------------------------------------------------------------

export class DrizzleSalesOrderLineRepository implements SalesOrderLineRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async listForOrder(salesOrderId: string): Promise<SalesOrderLineRecord[]> {
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
    const { tenantId, companyId } = requireScope(this.scope);

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
