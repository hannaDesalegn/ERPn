/**
 * The one order balance rows are locked in.
 *
 * Section 10.2 asks for an acquisition order that is documented and followed. A comparator is
 * the documentation, and what is worth testing about it is that it is total and that it depends
 * on nothing but the key: a comparator that leaves two distinct rows equal, or that answers
 * differently depending on the order it was handed, is not an order at all.
 */

import { describe, expect, it } from 'vitest';

import { byBalanceKey, inLockOrder } from './lock-order.js';

const key = (productId: string, warehouseId = 'w1') => ({ productId, warehouseId });

describe('the balance key order', () => {
  it('sorts by product first', () => {
    expect(byBalanceKey(key('a'), key('b'))).toBeLessThan(0);
    expect(byBalanceKey(key('b'), key('a'))).toBeGreaterThan(0);
  });

  it('sorts by warehouse when the product is the same', () => {
    expect(byBalanceKey(key('a', 'w1'), key('a', 'w2'))).toBeLessThan(0);
  });

  it('separates every distinct row, so nothing is left to the sort to decide', () => {
    // A comparator returning zero for two different rows leaves their relative order to the
    // stability of the sort, which is the same as having stated no order for them.
    expect(byBalanceKey(key('a', 'w1'), key('a', 'w1'))).toBe(0);
    expect(byBalanceKey(key('a', 'w1'), key('a', 'w2'))).not.toBe(0);
    expect(byBalanceKey(key('a', 'w1'), key('b', 'w1'))).not.toBe(0);
  });

  it('gives the same sequence whatever order it was handed', () => {
    // The property the whole thing rests on. Two transactions holding the same keys in
    // different orders must still lock them in the same sequence, or they deadlock.
    const one = inLockOrder([key('c'), key('a'), key('b')]).map((k) => k.productId);
    const other = inLockOrder([key('b'), key('c'), key('a')]).map((k) => k.productId);

    expect(one).toEqual(['a', 'b', 'c']);
    expect(other).toEqual(one);
  });

  it('leaves the caller’s list alone', () => {
    // The lines of a document mean their line numbers. Sorting the caller's array in place
    // would quietly reorder something that means something else.
    const lines = [key('c'), key('a')];

    inLockOrder(lines);

    expect(lines.map((k) => k.productId)).toEqual(['c', 'a']);
  });

  it('keeps the fields the caller carried', () => {
    const sorted = inLockOrder([
      { productId: 'b', warehouseId: 'w1', lineNumber: 1 },
      { productId: 'a', warehouseId: 'w1', lineNumber: 2 },
    ]);

    expect(sorted.map((line) => line.lineNumber)).toEqual([2, 1]);
  });
});
