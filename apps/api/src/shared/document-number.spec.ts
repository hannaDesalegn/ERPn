import { describe, expect, it } from 'vitest';

import { formatDocumentNumber } from './document-number.js';

describe('formatting a document number', () => {
  it('pads a small value to the width the rest of the system prints', () => {
    expect(formatDocumentNumber('SO-', 1n)).toBe('SO-0001');
    expect(formatDocumentNumber('SO-', 42n)).toBe('SO-0042');
  });

  it('leaves a value already at the width alone', () => {
    expect(formatDocumentNumber('SO-', 9999n)).toBe('SO-9999');
  });

  it('grows rather than truncating or wrapping', () => {
    // The alternative to growing is reissuing a number that is already on a document, which is
    // the one outcome the whole mechanism exists to prevent.
    expect(formatDocumentNumber('SO-', 10000n)).toBe('SO-10000');
    expect(formatDocumentNumber('SO-', 1234567n)).toBe('SO-1234567');
  });

  it('accepts an empty prefix, which is a plain counter', () => {
    expect(formatDocumentNumber('', 7n)).toBe('0007');
  });

  it('keeps a prefix that carries a year', () => {
    expect(formatDocumentNumber('SO-2026-', 3n)).toBe('SO-2026-0003');
  });

  it('holds a value past what a double counts exactly', () => {
    // A bigint throughout. As a number this would already be rounding.
    expect(formatDocumentNumber('SO-', 9007199254740993n)).toBe('SO-9007199254740993');
  });

  it.each([0n, -1n])('refuses %s, which no allocation produces', (value) => {
    expect(() => formatDocumentNumber('SO-', value)).toThrow(/must be positive/);
  });
});
