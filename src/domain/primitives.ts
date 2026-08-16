/**
 * Primitive value objects shared by every document in the system.
 *
 * These are deliberately backend-agnostic. Nothing here assumes Django, Odoo,
 * ERPNext or a particular database. A future integration layer maps whatever
 * the backend returns onto these shapes.
 */

export type ID = string;

/** Calendar date, no time component. 'YYYY-MM-DD'. */
export type ISODate = string;

/** Full ISO-8601 instant, e.g. '2026-08-14T09:31:00.000Z'. */
export type ISODateTime = string;

export type CurrencyCode = 'USD' | 'EUR' | 'ETB';

/**
 * MONEY.
 *
 * `amount` is an INTEGER number of *minor units* (cents), never a decimal.
 *
 * Why: IEEE-754 floats cannot represent 0.1 exactly, so `0.1 + 0.2 === 0.30000000000000004`.
 * In an accounting system a one-cent drift means a journal entry no longer balances and
 * the trial balance breaks. Every serious financial system stores integers (or a decimal
 * type) and formats to a decimal only at the moment of display.
 *
 * Currency travels WITH the amount. You must never add two Money values of different
 * currencies without an explicit conversion at a stated exchange rate.
 */
export interface Money {
  /** Integer minor units. 1234 with currency 'USD' means $12.34. */
  amount: number;
  currency: CurrencyCode;
}

/** Convenience factory for seed data and tests: money(12.34) -> { amount: 1234 }. */
export function money(major: number, currency: CurrencyCode = 'USD'): Money {
  return { amount: Math.round(major * 100), currency };
}

/**
 * Quantities are decimals, unlike money. You can legitimately ship 2.5 kg.
 * The unit of measure is part of the product, not the quantity, in this simple model.
 */
export type Quantity = number;

/**
 * DOCUMENT TYPES.
 *
 * An ERP is a set of business documents that reference each other. Naming every
 * document type in one union is what allows a single generic "related documents"
 * component to render a link to anything.
 */
export type DocType =
  // Sales cycle
  | 'sales_order'
  | 'delivery'
  | 'customer_invoice'
  | 'customer_payment'
  // Purchase cycle
  | 'purchase_order'
  | 'goods_receipt'
  | 'supplier_bill'
  | 'supplier_payment'
  // Inventory
  | 'stock_transfer'
  | 'inventory_adjustment'
  // Accounting
  | 'journal_entry';

/**
 * A lightweight pointer to another document.
 *
 * Documents store refs rather than embedded copies so that the UI can render a
 * link without loading the whole related record. A real backend would expose the
 * same shape from a `/documents/{type}/{id}` style endpoint or an expandable field.
 */
export interface DocumentRef {
  id: ID;
  docType: DocType;
  docNumber: string;
}

export type PartyType = 'customer' | 'supplier';

/** Lightweight pointer to a business partner (customer or supplier). */
export interface PartyRef {
  id: ID;
  name: string;
  type: PartyType;
}

/** Lightweight pointer to a user, used on audit stamps. */
export interface UserRef {
  id: ID;
  name: string;
}

/**
 * Who created and last touched a record.
 *
 * Every persisted document carries these. They are the minimum an audit trail
 * needs, and they must be written by the BACKEND, never by the client — a client
 * that reports its own "createdBy" is trivially forgeable. The frontend only
 * displays them.
 */
export interface Stamps {
  createdAt: ISODateTime;
  createdBy: UserRef;
  updatedAt: ISODateTime;
  updatedBy: UserRef;
}

/** Fields every business document shares. */
export interface DocumentBase extends Stamps {
  id: ID;
  /**
   * Human-facing sequential identifier, e.g. 'SO-2026-0043'.
   * Distinct from `id`: users quote the docNumber on the phone, systems join on id.
   * Sequence generation belongs to the backend (it needs a transaction to avoid gaps/dupes).
   */
  docNumber: string;
  /** Documents this one was created from, or that were created from it. */
  links: DocumentRef[];
  notes?: string;
}

/** Generic address value object. */
export interface Address {
  line1: string;
  city: string;
  region?: string;
  country: string;
  postalCode?: string;
}
