/**
 * Business partners: customers and suppliers.
 *
 * ERP CONCEPT — "party":
 * Many ERPs (Odoo especially) model customers and suppliers as ONE entity
 * (`res.partner`) with flags, because the same company can be both: you sell to
 * them and you also buy from them. We keep them as separate types here for
 * clarity, but both extend a common `PartyBase`, so merging them later is cheap.
 */

import type { Address, ID, ISODate, Money, PartyType, Stamps } from './primitives';

export interface PartyBase extends Stamps {
  id: ID;
  /** Human code used on documents, e.g. 'CUST-0012'. */
  code: string;
  name: string;
  type: PartyType;
  email?: string;
  phone?: string;
  address?: Address;
  /** Tax registration number (VAT/TIN). Needed on legally valid invoices. */
  taxId?: string;
  active: boolean;
}

/**
 * PAYMENT TERMS.
 *
 * "Net 30" means the invoice is due 30 days after its invoice date. This single
 * number drives receivables aging, cash-flow forecasting, and overdue alerts.
 * It is why an ERP can tell you "who owes us money and how late they are"
 * rather than just "total unpaid".
 */
export interface PaymentTerms {
  code: 'immediate' | 'net_15' | 'net_30' | 'net_45' | 'net_60';
  label: string;
  daysUntilDue: number;
}

export interface Customer extends PartyBase {
  type: 'customer';
  paymentTerms: PaymentTerms;
  /**
   * Maximum unpaid balance we allow this customer to carry.
   * A real ERP blocks or warns when confirming an order would exceed it.
   * That rule must be enforced by the BACKEND; the UI only surfaces it.
   */
  creditLimit: Money;
  /**
   * DERIVED, never stored as a source of truth.
   * Sum of posted customer invoices minus payments applied to them.
   * The backend computes this; the frontend treats it as read-only.
   */
  balance: Money;
  salesRepId?: ID;
}

export interface Supplier extends PartyBase {
  type: 'supplier';
  paymentTerms: PaymentTerms;
  /** DERIVED: what we owe this supplier (posted bills minus payments made). */
  balance: Money;
  /** Typical lead time in days, used to suggest reorder timing. */
  leadTimeDays: number;
}

export type Party = Customer | Supplier;

/**
 * AGING BUCKET.
 *
 * ERP CONCEPT — "aging": receivables and payables are grouped by how overdue they
 * are. A customer owing $10,000 that is 90 days late is a very different business
 * situation from $10,000 not yet due, even though both are "$10,000 outstanding".
 * Aging is the standard way finance teams read credit risk.
 */
export type AgingBucket = 'current' | '1_30' | '31_60' | '61_90' | '90_plus';

export interface AgingSummary {
  partyId: ID;
  partyName: string;
  current: Money;
  d1_30: Money;
  d31_60: Money;
  d61_90: Money;
  d90_plus: Money;
  total: Money;
  oldestDueDate?: ISODate;
}
