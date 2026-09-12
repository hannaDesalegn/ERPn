/**
 * Creating a sales order draft.
 *
 * A draft and nothing else. Contract section 12.2 makes confirmation the irreversible moment
 * that validates, authorizes, applies side effects, allocates a number, writes an audit record
 * and commits, all in one transaction or none of it. None of that is here: a draft is editable
 * and has no side effects, nothing is reserved, nothing is owed, nothing is posted.
 *
 * THE ONE THING THIS FILE IS REALLY ABOUT is that nothing the caller sends becomes a stored
 * figure. Section 3.3 is explicit: the frontend is never trusted with prices, discounts, tax
 * rates or costs sent back from a form, and the server recomputes every monetary figure from its
 * own master data and the submitted quantities. So the input carries identifiers and quantities,
 * and there is no field on it for a price, a name, a tax rate or a total. A caller that sends one
 * anyway is rejected rather than ignored, per section 14.2.
 *
 * WHAT COMES FROM WHERE:
 *
 *   tenant, company        the scope, which came from the session
 *   currency               the company's base currency
 *   unit price             the product record
 *   product sku and name   the product record, snapshotted per section 3.4
 *   tax rate               the single resolver in `tax/tax-rate.ts`, snapshotted the same way
 *   quantity, discount     the caller, and only these
 *
 * ONE TRANSACTION. Every validating read and every write happen inside a single unit of work, so
 * a product that disappears between the check and the insert cannot produce a half-written
 * order, and a failure on the fourth line leaves no header behind.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { actorScope, UnitOfWork } from '../database/index.js';
import type {
  CompanyRecord,
  NewSalesOrderLine,
  ProductRecord,
  SalesOrderLineRecord,
  SalesOrderRecord,
} from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import type { SalesOrderPageQuery, ScopedRepositories } from '../database/index.js';
import {
  add,
  compare,
  multiply,
  parseDecimal,
  round,
  subtract,
  toFixed,
  zero,
  type Decimal,
} from '../shared/decimal.js';
import { resolveTaxRate } from '../tax/tax-rate.js';
import { statusOf } from './sales-order-status.js';

/** The scales the schema declares. Amounts at four, everything else at six. */
const AMOUNT_SCALE = 4;
const RATE_SCALE = 6;

const ONE_HUNDRED = parseDecimal('100');

export interface DraftLineInput {
  productId: string;
  /** A decimal string. The only quantity in the system the caller chooses. */
  quantity: string;
  /** A percentage the caller may negotiate. Zero when absent. */
  discountPercent?: string;
}

export interface CreateDraftInput {
  customerId: string;
  warehouseId: string;
  /** ISO date. The day the order was agreed, which is the caller's to state. */
  orderDate: string;
  expectedDeliveryDate?: string | null;
  salesRepUserId?: string | null;
  lines: DraftLineInput[];
}

/**
 * A draft as it should now be.
 *
 * The same fields creating one accepts, plus the identifier and the version the caller read.
 * Section 10.1 requires that version; everything else a document eventually shows is the
 * server s and has nowhere here to be supplied.
 */
export interface UpdateDraftInput extends CreateDraftInput {
  salesOrderId: string;
  expectedVersion: number;
}

export interface SalesOrderDraft {
  order: SalesOrderRecord;
  lines: SalesOrderLineRecord[];
}

/**
 * Why a draft was refused.
 *
 * `not_found` covers a record that is missing, archived, in another company or in another
 * tenant, and it covers them with one value on purpose. Section 6.1: a failure at the tenant or
 * company dimension is indistinguishable from the record not existing, so that identifiers
 * cannot be probed to learn what another company holds.
 */
export type DraftRejection =
  | 'no_lines'
  | 'order_not_found'
  | 'not_a_draft'
  | 'customer_not_found'
  | 'warehouse_not_found'
  | 'product_not_found'
  | 'invalid_quantity'
  | 'invalid_discount'
  | 'currency_mismatch';

export class SalesOrderDraftError extends Error {
  readonly reason: DraftRejection;
  readonly subject: string | undefined;

  constructor(reason: DraftRejection, message: string, subject?: string) {
    super(message);
    this.name = 'SalesOrderDraftError';
    this.reason = reason;
    this.subject = subject;
  }
}


/**
 * A sales order as a screen needs it: the document, its lines, and the names it points at.
 *
 * EXACTLY WHAT THE DATABASE HOLDS, AND NOTHING ELSE. Three things the current detail screen shows
 * have no source here and are deliberately absent rather than invented. The invoiced total needs
 * an invoices table that does not exist. The related documents need the link table section 12.4
 * describes, which also does not exist and which that section is explicit must not be a stored
 * array. Notes are not modelled on a sales order at all. Section 16.1 removes the fixture layer
 * per module as endpoints land, and those three belong to modules whose endpoints have not.
 *
 * FIGURES ARE DECIMAL STRINGS, as section 4.3 requires. Converting them to whatever a client
 * renders is the client's boundary, not this one.
 */
export interface SalesOrderView {
  id: string;
  /** Null while the order is a draft. Allocated at confirmation, per section 10.4. */
  docNumber: string | null;
  status: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  currency: string;
  customer: { id: string; name: string };
  warehouse: { id: string; name: string };
  /** Null when nobody was recorded, which the column permits. */
  salesRep: { id: string; name: string } | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Section 10.1's optimistic locking token, so a later edit can carry what it read. */
  version: number;
  lines: SalesOrderLineView[];
}

export interface SalesOrderLineView {
  id: string;
  lineNumber: number;
  productId: string;
  productSku: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
  deliveredQuantity: string;
  invoicedQuantity: string;
}


/**
 * One page of the sales order list.
 *
 * The envelope is the one the rest of this application's collection reads already use: the rows,
 * the count and the aggregate over everything the filter matched rather than over the page. A
 * caller summing the visible rows would get a different and wrong answer the moment a second page
 * existed, which is the mistake a finance screen cannot afford.
 */
export interface SalesOrderPageView {
  rows: SalesOrderRowView[];
  total: number;
  page: number;
  pageSize: number;
  /** The value of every order the filter matched, not of this page. */
  totalValue: string;
}

export interface SalesOrderRowView {
  id: string;
  docNumber: string | null;
  status: string;
  orderDate: string;
  currency: string;
  total: string;
  customer: { name: string };
  warehouse: { name: string };
  salesRep: { name: string } | null;
  /** What the screen shows instead of the lines: a count and the two quantities. */
  lineCount: number;
  orderedQuantity: string;
  deliveredQuantity: string;
}

/** What creating a draft needs from a transaction already in progress. */
export type DraftRepositories = Pick<
  ScopedRepositories,
  'companies' | 'customers' | 'warehouses' | 'products' | 'salesOrders' | 'salesOrderLines'
>;

/** What reading one needs. */
export type ReadRepositories = Pick<
  ScopedRepositories,
  'salesOrders' | 'salesOrderLines' | 'customers' | 'warehouses' | 'users'
>;

@Injectable()
export class SalesOrderService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Creates a draft order with its lines.
   *
   * Returns the rows as written, not as computed, so a caller sees what the database holds
   * rather than what this function believed it was about to store.
   */
  async createDraft(
    context: CompanyContext,
    actorUserId: string,
    input: CreateDraftInput,
  ): Promise<SalesOrderDraft> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      (repos) => this.createDraftIn(repos, context.companyId, input),
    );
  }

  /**
   * The same creation, inside a transaction the caller already opened.
   *
   * Split out for the reason `allocateSalesOrderNumber` and `reserveForOrderLine` are: an
   * endpoint has to claim its idempotency key, do the work and store the response in one
   * transaction, per section 11, and a method that opens its own cannot take part in that. The
   * wrapper above keeps the standalone call working unchanged.
   */
  /**
   * Rewrites a draft, inside a transaction the caller already opened.
   *
   * WHAT SECTION 12.2 ACTUALLY PERMITS. A draft is editable and has no side effects: nothing is
   * reserved, owed or posted, so there is nothing to unwind and no compensating anything. That is
   * what makes an edit a rewrite rather than a reconciliation.
   *
   * A REPLACEMENT, NOT A PATCH. The caller sends the draft as it should now be, and every line is
   * priced from master data and the submitted quantity exactly as creation prices it. The contract
   * does not specify a request shape; this one is chosen because pricing already recomputes each
   * line from scratch, so a replacement and a patch would run the same code with the patch adding
   * a per line vocabulary the contract never describes.
   *
   * THE VERSION IS THE WHOLE CONCURRENCY STORY, per section 10.1. The header write carries the
   * version the caller read, so two people editing one draft resolve to one winner and the loser
   * is told the order moved rather than silently overwriting. The lines are rewritten after that
   * write, inside the same transaction, so a loser removes nothing: its update matched no row, it
   * threw, and the transaction that would have deleted the lines never committed.
   *
   * NO AUDIT RECORD, AND THAT IS A RULING RATHER THAN AN OVERSIGHT. Section 7.1 says a change
   * cannot exist without its audit record, and section 12.2 says a draft has no side effects. Read
   * together, and as the project lead settled on 2026-09-13, document audit begins at confirmation:
   * creating and editing a draft are pre-confirmation mutations of something that has promised
   * nobody anything, and confirmation is the lifecycle boundary where the trail starts. Creation
   * already ships unaudited and stays that way; this matches it rather than introducing a trail
   * that records edits to a document with no record of existing.
   */
  async updateDraftIn(
    repos: DraftRepositories,
    companyId: string,
    input: UpdateDraftInput,
  ): Promise<SalesOrderDraft> {
    if (input.lines.length === 0) {
      throw new SalesOrderDraftError('no_lines', 'A sales order needs at least one line');
    }

    const company = await repos.companies.findById(companyId);
    if (!company) {
      throw new Error('The acting company disappeared inside its own transaction');
    }

    // Scoped, so an order in another company is not found rather than refused, per section 6.1.
    const existing = await repos.salesOrders.findById(input.salesOrderId);
    if (!existing) {
      throw notFound('order_not_found', 'Sales order', input.salesOrderId);
    }

    // NOT A TRANSITION, AND SO NOT THE TRANSITION TABLE. Editing leaves the order exactly where
    // it was, and section 12.1's table governs moves between states: it refuses draft to draft,
    // because staying put is not a move. What section 12.2 actually says is that a draft is
    // editable, which is a question about the current state and is asked as one.
    //
    // The same question is asked again by the header write, for the case where somebody confirms
    // the order between this line and that one.
    const status = statusOf(existing.status);
    if (status !== 'draft') {
      throw new SalesOrderDraftError(
        'not_a_draft',
        `A ${status} sales order cannot be edited. Only a draft can.`,
      );
    }

    const customer = await repos.customers.findById(input.customerId);
    if (!customer || customer.status !== 'active') {
      throw notFound('customer_not_found', 'Customer', input.customerId);
    }

    const warehouse = await repos.warehouses.findById(input.warehouseId);
    if (!warehouse || warehouse.status !== 'active') {
      throw notFound('warehouse_not_found', 'Warehouse', input.warehouseId);
    }

    // Every line priced before anything is written, so a line that cannot be priced leaves the
    // existing draft untouched rather than half rewritten. The transaction would roll it back
    // anyway; this makes the common case fail before it has written at all.
    const priced = [];
    for (const line of input.lines) {
      priced.push(await this.price(repos, company, line));
    }

    // The header first, because its version is the lock. Everything after this point belongs to
    // a transaction that has already won the race.
    const header = await repos.salesOrders.updateDraft({
      id: existing.id,
      expectedVersion: input.expectedVersion,
      customerId: customer.id,
      warehouseId: warehouse.id,
      orderDate: input.orderDate,
      expectedDeliveryDate: input.expectedDeliveryDate ?? null,
      salesRepUserId: input.salesRepUserId ?? null,
    });

    // Out with the old lines and in with the new. The grant to delete a sales order line exists
    // for exactly this, and migration 0005 says so: a draft is editable under section 12.2 and
    // removing a line from one is ordinary editing rather than deleting a document.
    for (const line of await repos.salesOrderLines.listForOrder(existing.id)) {
      await repos.salesOrderLines.remove(line.id);
    }

    const lines: SalesOrderLineRecord[] = [];
    for (const [index, line] of priced.entries()) {
      lines.push(
        await repos.salesOrderLines.create({
          ...line,
          id: randomUUID(),
          salesOrderId: existing.id,
          // Renumbered from one, so removing the second line of three does not leave a gap.
          lineNumber: index + 1,
          // Still the company's, never the caller's. An edit cannot change what an order trades
          // in any more than creation could.
          currency: company.baseCurrency,
        }),
      );
    }

    // Summed from the rows as written, as creation does. `setTotals` does not touch the version,
    // so the edit leaves it exactly one higher than the caller read.
    return { order: await this.total(repos, header, lines), lines };
  }

  async createDraftIn(
    repos: DraftRepositories,
    companyId: string,
    input: CreateDraftInput,
  ): Promise<SalesOrderDraft> {
    if (input.lines.length === 0) {
      // An order that promises nothing is not a draft of anything. Refused here rather than
      // written as a header with no lines, which nothing downstream knows how to price.
      throw new SalesOrderDraftError('no_lines', 'A sales order needs at least one line');
    }

    return (async () => {
        // The company is the authority for two things the caller does not supply: the currency
        // the order trades in, and the tax rate every line carries.
        const company = await repos.companies.findById(companyId);
        if (!company) {
          // Unreachable through a real session, which resolved this company from a membership
          // moments ago. Loud rather than silent, because the alternative is a null currency.
          throw new Error('The acting company disappeared inside its own transaction');
        }

        // Section 12.2 step one: validate against current master data. Archived counts as
        // invalid, because archiving is how a record stops being usable while staying
        // referenced by the history that already names it.
        const customer = await repos.customers.findById(input.customerId);
        if (!customer || customer.status !== 'active') {
          throw notFound('customer_not_found', 'Customer', input.customerId);
        }

        const warehouse = await repos.warehouses.findById(input.warehouseId);
        if (!warehouse || warehouse.status !== 'active') {
          throw notFound('warehouse_not_found', 'Warehouse', input.warehouseId);
        }

        // Every product first, before anything is written. A line that cannot be priced must
        // not leave a header behind, and the transaction would roll one back anyway; this makes
        // the common case fail before it has written anything at all.
        //
        // One at a time rather than in parallel. A unit of work is one connection, so parallel
        // reads would be pipelined onto it, and the driver deprecates that. Sequential also
        // makes the reported line deterministic: the first bad one, not whichever lost a race.
        const priced = [];
        for (const line of input.lines) {
          priced.push(await this.price(repos, company, line));
        }

        const orderId = randomUUID();
        const order = await repos.salesOrders.create({
          id: orderId,
          customerId: customer.id,
          warehouseId: warehouse.id,
          salesRepUserId: input.salesRepUserId ?? null,
          orderDate: input.orderDate,
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          // From the company, never from the caller. A caller-chosen currency would be a
          // caller-chosen exchange rate one increment later.
          currency: company.baseCurrency,
        });

        const lines: SalesOrderLineRecord[] = [];
        for (const [index, line] of priced.entries()) {
          lines.push(
            await repos.salesOrderLines.create({
              ...line,
              id: randomUUID(),
              salesOrderId: orderId,
              // Assigned here, so two lines cannot collide and a caller cannot choose the order
              // in which its own lines are numbered.
              lineNumber: index + 1,
              currency: company.baseCurrency,
            }),
          );
        }

        // The document totals are the sum of what was actually written, read back from the
        // rows. Summing what this function computed would agree with itself even if the write
        // had rounded differently.
      return { order: await this.total(repos, order, lines), lines };
    })();
  }

  /**
   * One page of this company's sales orders.
   *
   * Thin on purpose. The query is the repository's and the scope is the unit of work's; what is
   * here is the shape a screen reads. Bounds on the page size belong at the HTTP boundary, where
   * the untrusted number arrives.
   */
  async list(
    context: CompanyContext,
    actorUserId: string,
    query: SalesOrderPageQuery,
  ): Promise<SalesOrderPageView> {
    const page = await this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      (repos) => repos.salesOrders.listPage(query),
    );

    return {
      rows: page.rows.map((row) => ({
        id: row.id,
        docNumber: row.docNumber,
        status: row.status,
        orderDate: row.orderDate,
        currency: row.currency,
        total: row.total,
        customer: { name: row.customerName },
        warehouse: { name: row.warehouseName },
        salesRep: row.salesRepName ? { name: row.salesRepName } : null,
        lineCount: row.lineCount,
        orderedQuantity: row.orderedQuantity,
        deliveredQuantity: row.deliveredQuantity,
      })),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
      totalValue: page.totalValue,
    };
  }

  /**
   * Reads one sales order with everything a detail screen shows.
   *
   * ONE TRANSACTION, AND EVERY READ INSIDE IT IS SCOPED. The order, its lines, the customer, the
   * warehouse and the sales rep are read under one actor scope, so an order belonging to another
   * company is not refused here; it is not among the rows any of these queries can return.
   * Section 6.3 calls that the shape to have, because a check performed after the rows come back
   * is only correct while every caller remembers to perform it.
   *
   * NULL RATHER THAN NOT FOUND, per section 6.1. A missing order, another company's order and
   * another tenant's order are one answer, so knowing a UUID reveals nothing about what exists
   * elsewhere.
   *
   * THE NAMES ARE READ, NOT SNAPSHOTTED. A customer's current name is what a screen should show,
   * unlike the product name on a line, which section 3.4 snapshots because it is part of what was
   * agreed. The line carries its own copy for that reason and this does not second guess it.
   */
  async getById(
    context: CompanyContext,
    actorUserId: string,
    salesOrderId: string,
  ): Promise<SalesOrderView | null> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        // The acting user, as every other operation here takes it. The membership beside it in
        // the context identifies the grant, not the person.
        userId: actorUserId,
      }),
      (repos) => this.readIn(repos, salesOrderId),
    );
  }

  /**
   * The same read, inside a transaction the caller already opened.
   *
   * Exists so that creating a draft can answer with exactly what the detail endpoint would say,
   * from inside the transaction that created it, without a second copy of the mapping below.
   */
  async readIn(repos: ReadRepositories, salesOrderId: string): Promise<SalesOrderView | null> {
    return (async () => {
        const order = await repos.salesOrders.findById(salesOrderId);
        if (!order) return null;

        // One at a time. A unit of work is one connection, so parallel reads would be pipelined
        // onto it and the driver deprecates that.
        const lines = await repos.salesOrderLines.listForOrder(order.id);
        const customer = await repos.customers.findById(order.customerId);
        const warehouse = await repos.warehouses.findById(order.warehouseId);
        const salesRep = order.salesRepUserId
          ? await repos.users.findById(order.salesRepUserId)
          : null;

        return {
          id: order.id,
          docNumber: order.docNumber,
          status: order.status,
          orderDate: order.orderDate,
          expectedDeliveryDate: order.expectedDeliveryDate,
          currency: order.currency,
          // A composite foreign key pins both to this company, so a missing row here would mean
          // the key was dropped rather than that the reference was wrong.
          customer: { id: order.customerId, name: customer?.name ?? '' },
          warehouse: { id: order.warehouseId, name: warehouse?.name ?? '' },
          salesRep: salesRep ? { id: salesRep.id, name: salesRep.name } : null,
          subtotal: order.subtotal,
          taxTotal: order.taxTotal,
          total: order.total,
          version: order.version,
          lines: lines.map((line) => ({
            id: line.id,
            lineNumber: line.lineNumber,
            productId: line.productId,
            productSku: line.productSku,
            productName: line.productName,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountPercent: line.discountPercent,
            taxRatePercent: line.taxRatePercent,
            lineSubtotal: line.lineSubtotal,
            lineTax: line.lineTax,
            lineTotal: line.lineTotal,
            deliveredQuantity: line.deliveredQuantity,
            invoicedQuantity: line.invoicedQuantity,
          })),
        };
    })();
  }

  /**
   * Turns one requested line into the figures that will be stored.
   *
   * Every value here except the quantity and the discount comes from the product record or the
   * company. Section 3.3 recomputes from master data and the submitted quantities, and this is
   * the sentence in code.
   */
  private async price(
    repos: { products: { findById(id: string): Promise<ProductRecord | null> } },
    company: CompanyRecord,
    line: DraftLineInput,
  ): Promise<Omit<NewSalesOrderLine, 'id' | 'salesOrderId' | 'lineNumber' | 'currency'>> {
    const quantity = decimalOr(line.quantity, 'invalid_quantity', 'quantity');
    if (compare(quantity, zero(0)) <= 0) {
      // The schema refuses this too. Refusing it here names the line rather than surfacing a
      // constraint violation the caller has to decode.
      throw new SalesOrderDraftError(
        'invalid_quantity',
        'A line quantity must be greater than zero',
        line.productId,
      );
    }

    const discount = line.discountPercent
      ? decimalOr(line.discountPercent, 'invalid_discount', 'discount')
      : zero(RATE_SCALE);
    if (compare(discount, zero(0)) < 0 || compare(discount, ONE_HUNDRED) > 0) {
      throw new SalesOrderDraftError(
        'invalid_discount',
        'A line discount must be between nought and a hundred per cent',
        line.productId,
      );
    }

    const product = await repos.products.findById(line.productId);
    if (!product || product.status !== 'active') {
      throw notFound('product_not_found', 'Product', line.productId);
    }

    if (product.salesPriceCurrency !== company.baseCurrency) {
      // No exchange rate exists on a sales order, and inventing one would be the guess the
      // domain model refuses when it says cross-currency arithmetic throws rather than guesses.
      throw new SalesOrderDraftError(
        'currency_mismatch',
        `Product ${product.sku} is priced in ${product.salesPriceCurrency}, and this company trades in ${company.baseCurrency}`,
        line.productId,
      );
    }

    const unitPrice = parseDecimal(product.salesPrice);
    const taxRate = parseDecimal(resolveTaxRate(company));

    // Gross of discount, then discounted, then rounded once to the amount scale. Rounding at
    // the end rather than at each step is what section 4.3 means by applying it at defined
    // points only.
    const gross = multiply(quantity, unitPrice);
    const keptFraction = subtract(ONE_HUNDRED, discount);
    const discounted = divideByHundred(multiply(gross, keptFraction));
    const lineSubtotal = round(discounted, AMOUNT_SCALE);

    // Tax is computed on the rounded subtotal, which is the figure that appears on the
    // document. Computing it on the unrounded one would produce a tax that does not follow from
    // the numbers a customer can see.
    const lineTax = round(divideByHundred(multiply(lineSubtotal, taxRate)), AMOUNT_SCALE);
    const lineTotal = add(lineSubtotal, lineTax);

    return {
      productId: product.id,
      // Snapshotted from master data, per section 3.4: a document is an immutable record of a
      // past agreement, and a caller-supplied name would be a caller-supplied document.
      productSku: product.sku,
      productName: product.name,
      quantity: toFixed(quantity, RATE_SCALE),
      unitPrice: toFixed(unitPrice, RATE_SCALE),
      discountPercent: toFixed(discount, RATE_SCALE),
      taxRatePercent: toFixed(taxRate, RATE_SCALE),
      lineSubtotal: toFixed(lineSubtotal, AMOUNT_SCALE),
      lineTax: toFixed(lineTax, AMOUNT_SCALE),
      lineTotal: toFixed(lineTotal, AMOUNT_SCALE),
    };
  }

  /**
   * Writes the document totals, summed from the stored lines.
   *
   * A separate write because the header is created before its lines exist. There is no rounding
   * here: each line was already rounded to the amount scale, so the sum is exact and no
   * difference arises for section 4.3 to allocate.
   */
  private async total(
    repos: {
      salesOrders: { setTotals(input: { id: string; subtotal: string; taxTotal: string; total: string }): Promise<SalesOrderRecord> };
    },
    order: SalesOrderRecord,
    lines: SalesOrderLineRecord[],
  ): Promise<SalesOrderRecord> {
    let subtotal: Decimal = zero(AMOUNT_SCALE);
    let taxTotal: Decimal = zero(AMOUNT_SCALE);

    for (const line of lines) {
      subtotal = add(subtotal, parseDecimal(line.lineSubtotal, AMOUNT_SCALE));
      taxTotal = add(taxTotal, parseDecimal(line.lineTax, AMOUNT_SCALE));
    }

    return repos.salesOrders.setTotals({
      id: order.id,
      subtotal: toFixed(subtotal, AMOUNT_SCALE),
      taxTotal: toFixed(taxTotal, AMOUNT_SCALE),
      total: toFixed(add(subtotal, taxTotal), AMOUNT_SCALE),
    });
  }
}

/** Percentages are applied by dividing once, exactly, at the end of a multiplication. */
function divideByHundred(value: Decimal): Decimal {
  return { units: value.units, scale: value.scale + 2 };
}

function decimalOr(value: string, reason: DraftRejection, field: string): Decimal {
  try {
    return parseDecimal(value, RATE_SCALE);
  } catch (error) {
    // The parse failure carries the useful detail; the domain error carries the reason a caller
    // can branch on. Section 14.2: rejected rather than coerced into something plausible.
    throw new SalesOrderDraftError(
      reason,
      `A line ${field} must be a decimal with at most ${RATE_SCALE} places: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function notFound(reason: DraftRejection, subject: string, id: string): SalesOrderDraftError {
  // One message whether the record is missing, archived, another company's or another tenant's.
  return new SalesOrderDraftError(reason, `${subject} not found`, id);
}
