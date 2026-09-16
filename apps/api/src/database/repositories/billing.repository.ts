/**
 * Customer invoices and their lines. INTERNAL, like every other repository implementation.
 *
 * Nothing here is re-exported from the data layer's public entry point. These classes are
 * constructed only by `UnitOfWork`, inside a transaction whose tenant and company context is
 * already set. Contract section 6.3: constructing an unscoped query must not be possible through
 * the public interface of the data layer.
 *
 * THE SAME TWO RULES AS EVERY OTHER REPOSITORY HERE:
 *
 *   1. The scope predicate is in the query, not applied afterwards. An invoice belonging to
 *      another company is not among the rows a query can return, rather than being fetched and
 *      then rejected.
 *   2. Writes stamp `tenant_id` and `company_id` from the scope, never from the input.
 *
 * NO STATUS WRITE AND NO NUMBER WRITE. There is no method here that moves an invoice out of
 * `draft` or sets a document number, because the transaction that does both is section 12.2's
 * posting and it is the next increment. The check constraint in 0015 refuses a numbered draft, so
 * this is not the only thing standing in the way of one.
 *
 * NO DELETE ON THE INVOICE. Section 4.5, and the grant refuses one anyway. The lines are
 * deletable because editing a draft replaces them.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { customerInvoiceLines, customerInvoices } from '../schema/billing.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import {
  ConcurrencyConflictError,
  RecordNotFoundError,
  type CustomerInvoiceDraftUpdate,
  type CustomerInvoiceLineRecord,
  type CustomerInvoiceLineRepository,
  type CustomerInvoiceRecord,
  type CustomerInvoiceRepository,
  type CustomerInvoiceTransition,
  type NewCustomerInvoice,
  type NewCustomerInvoiceLine,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

const INVOICES = 'Customer invoices';

export class DrizzleCustomerInvoiceRepository implements CustomerInvoiceRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<CustomerInvoiceRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .select()
      .from(customerInvoices)
      .where(
        and(
          eq(customerInvoices.id, id),
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toInvoice(rows[0]) : null;
  }

  async listForCompany(): Promise<CustomerInvoiceRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .select()
      .from(customerInvoices)
      .where(
        and(
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.companyId, companyId),
        ),
      )
      .orderBy(asc(customerInvoices.invoiceDate), asc(customerInvoices.id));

    return rows.map(toInvoice);
  }

  async create(input: NewCustomerInvoice): Promise<CustomerInvoiceRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .insert(customerInvoices)
      .values({
        id: input.id,
        // From the scope. `NewCustomerInvoice` has no field with which to claim another company.
        tenantId,
        companyId,
        customerId: input.customerId,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        currency: input.currency,
        // `status` takes the column default and `doc_number` stays null. Neither is a caller's,
        // and the constraint in 0015 refuses the pairing that would let a draft carry a number.
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toInvoice(row);
  }

  /**
   * Rewrites the header of a draft, under section 10.1's optimistic locking.
   *
   * The version is in the WHERE clause rather than checked before it, so a stale write updates
   * nothing rather than overwriting someone else's edit. The status is in the predicate too: an
   * invoice posted between the caller's read and this write is not a draft any more, and the
   * write must fail rather than edit a posted document.
   */
  async updateDraft(input: CustomerInvoiceDraftUpdate): Promise<CustomerInvoiceRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .update(customerInvoices)
      .set({
        customerId: input.customerId,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
        version: sql`${customerInvoices.version} + 1`,
      })
      .where(
        and(
          eq(customerInvoices.id, input.id),
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.companyId, companyId),
          eq(customerInvoices.version, input.expectedVersion),
          eq(customerInvoices.status, 'draft'),
        ),
      )
      .returning();

    const row = rows[0];
    if (row) return toInvoice(row);

    // Nothing was updated. Either the invoice is not in this company, which answers as not found
    // per section 6.1, or the version moved, or it is no longer a draft. The last two are both
    // conflicts: the document the caller read is not the document that is there now.
    const current = await this.findById(input.id);
    if (!current) throw new RecordNotFoundError(INVOICES, input.id);
    throw new ConcurrencyConflictError(INVOICES, input.id);
  }

  /**
   * Writes the totals summed from the stored lines.
   *
   * `version` is untouched on purpose, exactly as it is on a sales order: the totals follow from
   * the lines this transaction has just written, so bumping the version would make every
   * creation collide with an edit somebody else was making.
   */
  async setTotals(input: {
    id: string;
    subtotal: string;
    taxTotal: string;
    total: string;
  }): Promise<CustomerInvoiceRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .update(customerInvoices)
      .set({ subtotal: input.subtotal, taxTotal: input.taxTotal, total: input.total })
      .where(
        and(
          eq(customerInvoices.id, input.id),
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.companyId, companyId),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) throw new RecordNotFoundError(INVOICES, input.id);
    return toInvoice(row);
  }

  /**
   * Moves the invoice to a new status and stamps its number, guarded by what the caller read.
   *
   * The version and the status are both in the predicate, as they are on a sales order: two
   * postings of one invoice both pass the transition check and only the first matches here. The
   * second issues no number, because the allocation it made rolls back with the transaction that
   * found no row.
   */
  async applyTransition(input: CustomerInvoiceTransition): Promise<CustomerInvoiceRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .update(customerInvoices)
      .set({
        status: input.status,
        docNumber: input.docNumber,
        version: sql`${customerInvoices.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(customerInvoices.id, input.id),
          eq(customerInvoices.tenantId, tenantId),
          eq(customerInvoices.companyId, companyId),
          eq(customerInvoices.version, input.expectedVersion),
          eq(customerInvoices.status, input.expectedStatus),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) throw new ConcurrencyConflictError(INVOICES, input.id);
    return toInvoice(row);
  }
}

export class DrizzleCustomerInvoiceLineRepository implements CustomerInvoiceLineRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async listForInvoice(customerInvoiceId: string): Promise<CustomerInvoiceLineRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .select()
      .from(customerInvoiceLines)
      .where(
        and(
          eq(customerInvoiceLines.customerInvoiceId, customerInvoiceId),
          eq(customerInvoiceLines.tenantId, tenantId),
          eq(customerInvoiceLines.companyId, companyId),
        ),
      )
      .orderBy(asc(customerInvoiceLines.lineNumber));

    return rows.map(toLine);
  }

  /**
   * Every invoice line billing any line of one sales order.
   *
   * What the draft operation reads to know how much of an order line is already on an invoice,
   * and what a later read uses to show which invoices cover an order. Both are the same question
   * asked of the lines, which is where the relationship is held.
   */
  async listForSourceOrder(salesOrderId: string): Promise<CustomerInvoiceLineRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .select()
      .from(customerInvoiceLines)
      .where(
        and(
          eq(customerInvoiceLines.sourceSalesOrderId, salesOrderId),
          eq(customerInvoiceLines.tenantId, tenantId),
          eq(customerInvoiceLines.companyId, companyId),
        ),
      )
      .orderBy(asc(customerInvoiceLines.customerInvoiceId), asc(customerInvoiceLines.lineNumber));

    return rows.map(toLine);
  }

  async create(input: NewCustomerInvoiceLine): Promise<CustomerInvoiceLineRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    const rows = await this.db
      .insert(customerInvoiceLines)
      .values({
        id: input.id,
        tenantId,
        companyId,
        customerInvoiceId: input.customerInvoiceId,
        lineNumber: input.lineNumber,
        sourceSalesOrderId: input.sourceSalesOrderId,
        sourceSalesOrderLineId: input.sourceSalesOrderLineId,
        productId: input.productId,
        productSku: input.productSku,
        productName: input.productName,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        currency: input.currency,
        ...(input.discountPercent === undefined ? {} : { discountPercent: input.discountPercent }),
        ...(input.taxRatePercent === undefined ? {} : { taxRatePercent: input.taxRatePercent }),
        ...(input.lineSubtotal === undefined ? {} : { lineSubtotal: input.lineSubtotal }),
        ...(input.lineTax === undefined ? {} : { lineTax: input.lineTax }),
        ...(input.lineTotal === undefined ? {} : { lineTotal: input.lineTotal }),
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toLine(row);
  }

  async remove(id: string): Promise<void> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, INVOICES);

    await this.db
      .delete(customerInvoiceLines)
      .where(
        and(
          eq(customerInvoiceLines.id, id),
          eq(customerInvoiceLines.tenantId, tenantId),
          eq(customerInvoiceLines.companyId, companyId),
        ),
      );
  }
}

type InvoiceRow = typeof customerInvoices.$inferSelect;
type LineRow = typeof customerInvoiceLines.$inferSelect;

function toInvoice(row: InvoiceRow): CustomerInvoiceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    docNumber: row.docNumber,
    status: row.status,
    customerId: row.customerId,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    version: row.version,
  };
}

function toLine(row: LineRow): CustomerInvoiceLineRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    customerInvoiceId: row.customerInvoiceId,
    lineNumber: row.lineNumber,
    sourceSalesOrderId: row.sourceSalesOrderId,
    sourceSalesOrderLineId: row.sourceSalesOrderLineId,
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
  };
}
