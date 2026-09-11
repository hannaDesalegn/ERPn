/**
 * The sales order transition table.
 *
 * Section 12.1 requires the legal transitions to be declared explicitly and enforced server
 * side. The test that matters is the exhaustive one: every ordered pair of states is checked,
 * and exactly one is legal. Testing only the pairs somebody thought of is how a table ends up
 * permitting a move nobody declared.
 */

import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
  IllegalSalesOrderTransitionError,
  isSalesOrderStatus,
  SALES_ORDER_STATUSES,
  SALES_ORDER_TRANSITIONS,
  statusOf,
  type SalesOrderStatus,
} from './sales-order-status.js';

/** Every ordered pair, including a state with itself. */
const ALL_PAIRS: [SalesOrderStatus, SalesOrderStatus][] = SALES_ORDER_STATUSES.flatMap((from) =>
  SALES_ORDER_STATUSES.map((to): [SalesOrderStatus, SalesOrderStatus] => [from, to]),
);

/** The only move the contract describes today. Section 12.2's confirming transaction. */
const LEGAL: [SalesOrderStatus, SalesOrderStatus][] = [['draft', 'confirmed']];

const isLegal = (from: SalesOrderStatus, to: SalesOrderStatus) =>
  LEGAL.some(([a, b]) => a === from && b === to);

describe('the transition table', () => {
  it('declares a destination list for every state, so none is undefined', () => {
    // A missing key would make `canTransition` throw on a real status rather than answer it.
    expect(Object.keys(SALES_ORDER_TRANSITIONS).sort()).toEqual([...SALES_ORDER_STATUSES].sort());
  });

  it.each(ALL_PAIRS)('decides %s to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(isLegal(from, to));
  });

  it('permits exactly one move in total', () => {
    const declared = Object.values(SALES_ORDER_TRANSITIONS).flat();

    expect(declared).toHaveLength(LEGAL.length);
  });

  it('never names a destination outside the status union', () => {
    for (const destinations of Object.values(SALES_ORDER_TRANSITIONS)) {
      for (const destination of destinations) {
        expect(SALES_ORDER_STATUSES).toContain(destination);
      }
    }
  });

  it('refuses every state moving to itself', () => {
    // Not a move. A confirmation arriving twice is an idempotency question, per section 11, and
    // answering it by quietly permitting a repeat would hide the second attempt.
    for (const status of SALES_ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('lets a draft be confirmed, which is what section 12.2 describes', () => {
    expect(canTransition('draft', 'confirmed')).toBe(true);
  });

  it('does not yet permit cancelling anything', () => {
    // Section 12.3 requires cancellation rules to be explicit per document type, including
    // whether cancelling releases reserved stock. No such rule is written for a sales order and
    // reserved stock does not exist, so this stays refused rather than half specified.
    for (const status of SALES_ORDER_STATUSES) {
      expect(canTransition(status, 'cancelled')).toBe(false);
    }
  });

  it('does not permit the transitions other documents will eventually drive', () => {
    // An order becomes delivered because a delivery was posted against it. Until deliveries
    // exist, declaring the move would be declaring something nothing can perform.
    expect(canTransition('confirmed', 'partially_delivered')).toBe(false);
    expect(canTransition('confirmed', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'invoiced')).toBe(false);
  });

  it('does not let a confirmed order go back to a draft', () => {
    // Section 12.3: confirming is irreversible and correction is a new document, never an edit
    // returning the old one to an editable state.
    expect(canTransition('confirmed', 'draft')).toBe(false);
  });
});

describe('refusing a transition', () => {
  it('names both states, per section 12.1', () => {
    const error = (() => {
      try {
        assertTransition('confirmed', 'draft');
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(IllegalSalesOrderTransitionError);
    expect((error as IllegalSalesOrderTransitionError).from).toBe('confirmed');
    expect((error as IllegalSalesOrderTransitionError).to).toBe('draft');
    // A caller reading only the message still learns which rule stopped them.
    expect((error as Error).message).toBe('A sales order cannot move from confirmed to draft');
  });

  it('says nothing when the move is legal', () => {
    expect(() => assertTransition('draft', 'confirmed')).not.toThrow();
  });
});

describe('reading a stored status', () => {
  it.each([...SALES_ORDER_STATUSES])('accepts %s', (status) => {
    expect(statusOf(status)).toBe(status);
  });

  it.each(['', 'DRAFT', 'posted', 'shipped', 'confirmed '])(
    'refuses %s rather than reasoning about it',
    (value) => {
      // Only reachable if a migration widened the constraint without this file following. A
      // status the code has no rules for must not be treated as one it does.
      expect(() => statusOf(value)).toThrow(/does not define/);
      expect(isSalesOrderStatus(value)).toBe(false);
    },
  );
});
