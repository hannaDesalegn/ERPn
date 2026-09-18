/**
 * The customer invoice transition table, which is a pure decision and needs no database.
 *
 * Section 12.1 requires the legal moves declared in an explicit table and an illegal one refused
 * with both states named. What the table contains is a design decision this file pins, so that
 * widening it is a visible change rather than a line somebody adds while doing something else.
 *
 * The union the database will actually store is checked against this one in
 * `customer-invoice-status.int.spec.ts`, because a table of states the column does not permit is
 * a table reasoning about a system that does not exist.
 */

import {
  assertTransition,
  canTransition,
  CUSTOMER_INVOICE_STATUSES,
  CUSTOMER_INVOICE_TRANSITIONS,
  IllegalCustomerInvoiceTransitionError,
  isCustomerInvoiceStatus,
  statusOf,
} from './customer-invoice-status.js';

describe('the customer invoice status union', () => {
  it('holds the two states a document actually moves between, and no derived ones', () => {
    // `paid`, `partially_paid` and `overdue` are conclusions drawn from payment allocations and
    // the clock, not states somebody moves an invoice into, and section 9.2 refuses a stored
    // figure that duplicates a derivable one. `cancelled` is absent because no cancellation rule
    // exists for the invoice under section 12.3.
    expect([...CUSTOMER_INVOICE_STATUSES]).toEqual(['draft', 'posted']);
  });

  it.each(['paid', 'partially_paid', 'overdue', 'cancelled', 'void', 'Draft', ''])(
    'refuses %s, which this release does not define',
    (value) => {
      expect(isCustomerInvoiceStatus(value)).toBe(false);
    },
  );

  it('starts an invoice as a draft, which is the state the table transitions out of', () => {
    expect(CUSTOMER_INVOICE_STATUSES[0]).toBe('draft');
  });

  it('refuses to read a stored status it has no rules for', () => {
    // A row could only carry one if a migration widened the constraint without this file being
    // updated. Refusing is the safe answer: the alternative is code reasoning about a state it
    // has no rules for.
    expect(() => statusOf('paid')).toThrow(/does not define/);
    expect(statusOf('draft')).toBe('draft');
  });
});

describe('the transition table', () => {
  it('declares posting, the transition section 12.2 describes', () => {
    expect(CUSTOMER_INVOICE_TRANSITIONS.draft).toEqual(['posted']);
    expect(canTransition('draft', 'posted')).toBe(true);
  });

  it('lets a posted invoice go nowhere, because correction is a credit note', () => {
    // Section 12.3: a posted document is immutable and is corrected by a new document that
    // reverses it. An empty list is a real answer rather than an unfinished one.
    expect(CUSTOMER_INVOICE_TRANSITIONS.posted).toEqual([]);
    expect(canTransition('posted', 'draft')).toBe(false);
  });

  it('refuses a move from a state to itself, because staying put is not a move', () => {
    for (const status of CUSTOMER_INVOICE_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('declares a row for every state, so no state is missing its rules', () => {
    expect(Object.keys(CUSTOMER_INVOICE_TRANSITIONS).sort()).toEqual(
      [...CUSTOMER_INVOICE_STATUSES].sort(),
    );
  });

  it('names only states the union defines, on both sides of every move', () => {
    for (const targets of Object.values(CUSTOMER_INVOICE_TRANSITIONS)) {
      for (const target of targets) {
        expect(isCustomerInvoiceStatus(target)).toBe(true);
      }
    }
  });

  it('is data rather than behaviour, so it can be read without being run', () => {
    // Section 12.1 asks for a declared table. Every value in it is a plain array of strings, and
    // a function hiding in one would be a rule nobody can see by reading the table.
    for (const targets of Object.values(CUSTOMER_INVOICE_TRANSITIONS)) {
      expect(Array.isArray(targets)).toBe(true);
      for (const target of targets) expect(typeof target).toBe('string');
    }
  });
});

describe('refusing an illegal transition', () => {
  it('names the current state and the attempted one, per section 12.1', () => {
    // A caller told only that something failed cannot tell a stale screen from a genuine rule.
    expect(() => assertTransition('posted', 'draft')).toThrow(
      /cannot move from posted to draft/,
    );
  });

  it('throws an error a caller can branch on, carrying both states', () => {
    try {
      assertTransition('posted', 'draft');
      throw new Error('the transition was permitted');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalCustomerInvoiceTransitionError);
      expect({
        from: (error as IllegalCustomerInvoiceTransitionError).from,
        to: (error as IllegalCustomerInvoiceTransitionError).to,
      }).toEqual({ from: 'posted', to: 'draft' });
    }
  });

  it('permits the one move the table declares', () => {
    expect(() => assertTransition('draft', 'posted')).not.toThrow();
  });
});
