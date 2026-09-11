/**
 * Turning an allocated counter value into the number printed on a document.
 *
 * Separate from the allocation itself because the two fail differently. Allocation is a lock, a
 * transaction and a race; this is a string. Keeping them apart means the part that can be tested
 * exhaustively is tested exhaustively, and the part that needs a real database is not carrying
 * string formatting into every concurrency test.
 *
 * PADDING IS A MINIMUM, NOT A WIDTH. `SO-0001` reads as a document number and `SO-1` reads as a
 * mistake, so small values are padded. The padding never truncates and never wraps: the ten
 * thousandth order is `SO-10000`, one character wider than its predecessor. A fixed width would
 * eventually have to either refuse a number or reissue one, and both are worse than a number
 * that grows.
 *
 * The width is not configurable. Section 10.4 makes the prefix and the gapless choice per
 * sequence settings and says nothing about padding, and a setting the contract does not ask for
 * would need a column in the sequence table to live in. If a tenant ever needs it, that is a
 * migration and an amendment, not a constant quietly changed here.
 */

/** Matches the width the rest of the system already prints, for example `SO-0001`. */
export const MINIMUM_DIGITS = 4;

/**
 * Formats a counter value as a document number.
 *
 * The prefix is stored per sequence and may legitimately be empty, which gives a plain counter.
 */
export function formatDocumentNumber(prefix: string, value: bigint): string {
  if (value < 1n) {
    // A counter starts at one and only ever rises. Reaching here means the caller computed the
    // value rather than receiving it from an allocation.
    throw new Error(`A document number must be positive, not ${value}`);
  }

  return `${prefix}${value.toString().padStart(MINIMUM_DIGITS, '0')}`;
}
