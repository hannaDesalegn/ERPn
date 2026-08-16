/**
 * Invoices and payments, for both directions of trade.
 *
 * TERMINOLOGY
 *   Customer Invoice  we are owed money.  Creates an Account Receivable (AR).
 *   Supplier Bill     we owe money.       Creates an Account Payable (AP).
 * Odoo calls both `account.move`; QuickBooks calls them Invoice and Bill. The
 * important thing is that they are mirror images, not different concepts.
 *
 * ERP CONCEPT — POSTING
 * ---------------------
 * A `draft` invoice is a working document: editable, reversible, invisible to
 * the accounts. POSTING it is an irreversible commitment that:
 *   - fixes the document (it can no longer be edited, only credited/reversed)
 *   - makes the amount legally claimable
 *   - generates a JOURNAL ENTRY (see ./accounting.ts)
 *
 * This is why the UI must show posting as a deliberate action with consequences,
 * not as a checkbox. Once posted, the correction path is a CREDIT NOTE — a new
 * document that reverses the first — never a silent edit. Auditors need to see
 * both the mistake and the correction.
 */

import type {
  DocType,
  DocumentBase,
  ID,
  ISODate,
  Money,
  PartyRef,
  Quantity,
} from './primitives';
import type { MatchStatus } from './purchasing';

export type InvoiceStatus =
  | 'draft'
  | 'posted' // committed to the ledger, payment expected
  | 'partially_paid'
  | 'paid'
  | 'overdue' // posted, past due date, not fully paid
  | 'cancelled';

export interface InvoiceLine {
  id: ID;
  productId?: ID;
  productSku?: string;
  description: string;
  quantity: Quantity;
  unitPrice: Money;
  discountPercent: number;
  taxRatePercent: number;
  lineSubtotal: Money;
  lineTax: Money;
  lineTotal: Money;
  /**
   * Which ledger account this line's revenue (or expense) lands in.
   * Present so the accounting module can be switched on later without
   * restructuring invoices. See ./accounting.ts.
   */
  accountCode?: string;
}

interface InvoiceBase extends DocumentBase {
  status: InvoiceStatus;
  party: PartyRef;
  invoiceDate: ISODate;
  /** invoiceDate + payment terms. Drives aging and the overdue alert. */
  dueDate: ISODate;
  lines: InvoiceLine[];
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  /** Sum of payments applied. */
  paidAmount: Money;
  /** total - paidAmount. The number that appears in AR/AP aging. */
  balanceDue: Money;
  currency: Money['currency'];
  postedAt?: string;
  postedBy?: { id: ID; name: string };
  /** The journal entry this invoice generated when posted, if any. */
  journalEntryId?: ID;
  journalEntryNumber?: string;
}

export interface CustomerInvoice extends InvoiceBase {
  docType: Extract<DocType, 'customer_invoice'>;
  /** Sales orders being billed. Plural: one invoice can cover several orders. */
  salesOrderIds: ID[];
  salesOrderNumbers: string[];
}

export interface SupplierBill extends InvoiceBase {
  docType: Extract<DocType, 'supplier_bill'>;
  purchaseOrderIds: ID[];
  purchaseOrderNumbers: string[];
  /** The supplier's own invoice number, which we must record for reconciliation. */
  supplierReference?: string;
  /** Three-way match result. See ./purchasing.ts. */
  matchStatus: MatchStatus;
}

export type Invoice = CustomerInvoice | SupplierBill;

export type PaymentMethod = 'bank_transfer' | 'cash' | 'cheque' | 'card' | 'mobile_money';
export type PaymentStatus = 'draft' | 'posted' | 'reconciled' | 'cancelled';

/**
 * PAYMENT ALLOCATION.
 *
 * ERP CONCEPT: a payment is not attached to one invoice. A customer wires
 * $5,000 covering three invoices, or makes a part payment against one. So a
 * payment holds a list of ALLOCATIONS saying how much of the money settles which
 * invoice. Unallocated cash sits as a credit on the customer's account.
 *
 * Modelling payment as `invoiceId + amount` is a very common early mistake and
 * it breaks the first time a customer pays a round number.
 */
export interface PaymentAllocation {
  invoiceId: ID;
  invoiceNumber: string;
  amountApplied: Money;
}

export interface Payment extends DocumentBase {
  docType: Extract<DocType, 'customer_payment' | 'supplier_payment'>;
  status: PaymentStatus;
  direction: 'inbound' | 'outbound';
  party: PartyRef;
  paymentDate: ISODate;
  method: PaymentMethod;
  amount: Money;
  currency: Money['currency'];
  /** Which of our cash/bank accounts the money moved through. */
  cashAccountId: ID;
  cashAccountName: string;
  reference?: string;
  allocations: PaymentAllocation[];
  /** amount minus the sum of allocations. Money received but not yet applied. */
  unallocatedAmount: Money;
  journalEntryId?: ID;
  journalEntryNumber?: string;
}
