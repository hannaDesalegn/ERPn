/**
 * The arithmetic every monetary figure in the system goes through.
 *
 * These are the tests that matter most in this increment, because a wrong answer here is wrong
 * on an invoice and nobody notices until a customer does. The cases below are chosen for where
 * floating point actually breaks rather than for coverage: values that have no binary
 * representation, rounding exactly on the half, and the fraction-of-a-cent price section 4.3
 * names as the concrete reason for six decimal places.
 */

import { describe, expect, it } from 'vitest';

import {
  add,
  compare,
  DecimalParseError,
  isNegative,
  isZero,
  multiply,
  parseDecimal,
  subtract,
  toFixed,
  zero,
} from './decimal.js';

const d = (value: string) => parseDecimal(value);

describe('parsing', () => {
  it('reads a plain decimal exactly', () => {
    expect(parseDecimal('12.3456')).toEqual({ units: 123456n, scale: 4 });
  });

  it('reads a whole number as scale zero', () => {
    expect(parseDecimal('7')).toEqual({ units: 7n, scale: 0 });
  });

  it('reads a negative', () => {
    expect(parseDecimal('-0.5')).toEqual({ units: -5n, scale: 1 });
  });

  it('keeps a value a double cannot hold', () => {
    // 0.1 has no exact binary representation. This is the difference the whole module exists for.
    expect(toFixed(add(d('0.1'), d('0.2')), 4)).toBe('0.3000');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('keeps a price of four ten-thousandths of a cent', () => {
    // Section 4.3's own example: cable ties sold at a fraction of a cent per unit inside a pack
    // of a thousand. Two decimal places loses money on the first real price list.
    expect(toFixed(d('0.004250'), 6)).toBe('0.004250');
  });

  it.each([
    ['', 'empty'],
    ['abc', 'letters'],
    ['1.2.3', 'two points'],
    ['1e5', 'exponent form'],
    ['+1', 'leading plus'],
    [' 1 ', 'surrounding space'],
    ['1.', 'empty fraction'],
    ['.5', 'no whole part'],
    ['1,5', 'comma'],
    ['Infinity', 'a word a number parser would take'],
    ['NaN', 'the other one'],
  ])('refuses %s, because it is %s', (value) => {
    // Every one of these is something `Number()` either accepts or turns into NaN. Section 14.2
    // rejects rather than ignores, and a malformed figure must not arrive as a plausible one.
    expect(() => parseDecimal(value)).toThrow(DecimalParseError);
  });

  it('refuses more decimal places than the column can hold', () => {
    // Silently dropping the seventh place would be the caller's value quietly changed.
    expect(() => parseDecimal('1.1234567')).toThrow(/more than 6 decimal places/);
  });

  it('accepts exactly the scale it is given', () => {
    expect(() => parseDecimal('1.1234', 4)).not.toThrow();
    expect(() => parseDecimal('1.12345', 4)).toThrow();
  });
});

describe('rounding, half away from zero', () => {
  it.each([
    ['2.5', 0, '3'],
    ['3.5', 0, '4'],
    ['2.4', 0, '2'],
    ['-2.5', 0, '-3'],
    ['-2.4', 0, '-2'],
    ['0.005', 2, '0.01'],
    ['0.004', 2, '0.00'],
    ['1.23455', 4, '1.2346'],
    ['1.23445', 4, '1.2345'],
  ])('rounds %s at scale %i to %s', (value, scale, expected) => {
    // Stated rather than inherited: section 4.3 requires the rule to be explicit. Banker's
    // rounding would answer 2 for the first case, which is a different and also defensible
    // convention, and the point is that the codebase picks one and says so.
    expect(toFixed(d(value), scale)).toBe(expected);
  });

  it('widens without rounding', () => {
    expect(toFixed(d('1.5'), 4)).toBe('1.5000');
  });

  it('does not round inside a multiplication', () => {
    // The result carries the full scale. Rounding here is how a document total stops equalling
    // the sum of its lines.
    const product = multiply(d('0.001'), d('0.001'));

    expect(product.scale).toBe(6);
    expect(toFixed(product, 6)).toBe('0.000001');
  });
});

describe('arithmetic', () => {
  it('adds across different scales', () => {
    expect(toFixed(add(d('1.5'), d('2.25')), 4)).toBe('3.7500');
  });

  it('subtracts across different scales', () => {
    expect(toFixed(subtract(d('100'), d('0.0001')), 4)).toBe('99.9999');
  });

  it('multiplies exactly', () => {
    expect(toFixed(multiply(d('2.5'), d('4')), 4)).toBe('10.0000');
  });

  it('handles a quantity and a price at six places each', () => {
    // The real shape: quantity(19,6) times unitPrice(19,6) lands at scale twelve before it is
    // rounded to an amount at scale four.
    const line = multiply(d('2.500000'), d('1.250000'));

    expect(line.scale).toBe(12);
    expect(toFixed(line, 4)).toBe('3.1250');
  });

  it('stays exact over a large quantity of a tiny price', () => {
    // A thousand cable ties at four ten-thousandths of a cent. A double would already be wrong.
    expect(toFixed(multiply(d('1000'), d('0.004250')), 4)).toBe('4.2500');
  });

  it('compares without converting to a number', () => {
    expect(compare(d('1.10'), d('1.1'))).toBe(0);
    expect(compare(d('1.11'), d('1.1'))).toBe(1);
    expect(compare(d('-1'), d('0'))).toBe(-1);
  });

  it('knows zero and negative', () => {
    expect(isZero(zero(4))).toBe(true);
    expect(isZero(d('0.0000'))).toBe(true);
    expect(isNegative(d('-0.0001'))).toBe(true);
    expect(isNegative(d('0'))).toBe(false);
  });
});

describe('rendering', () => {
  it('pads to the column scale', () => {
    // A NUMERIC(19,4) column returns its values fully padded, and a value written back in a
    // shorter form would compare unequal to what came out of it.
    expect(toFixed(d('12.3'), 4)).toBe('12.3000');
    expect(toFixed(d('0'), 6)).toBe('0.000000');
  });

  it('renders a value smaller than one with its leading zero', () => {
    expect(toFixed(d('0.5'), 2)).toBe('0.50');
  });

  it('renders at scale zero without a point', () => {
    expect(toFixed(d('42'), 0)).toBe('42');
  });

  it('renders a negative', () => {
    expect(toFixed(d('-1.5'), 4)).toBe('-1.5000');
  });

  it('survives a value far past what a double holds exactly', () => {
    // Beyond 2^53 a double starts skipping integers. NUMERIC(19,4) goes further than that, so
    // the boundary has to as well.
    expect(toFixed(d('9007199254740993'), 0)).toBe('9007199254740993');
  });
});
