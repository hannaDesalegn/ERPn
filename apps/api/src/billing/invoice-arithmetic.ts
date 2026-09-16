/**
 * The money on an invoice line, computed once for everything that needs it.
 *
 * WHY IT IS A MODULE AND NOT A METHOD. Two things compute these figures: raising a draft, which
 * derives them from the source order line, and posting, which recomputes them to check that the
 * document it is about to make legally binding still says what follows from its own inputs. If
 * those were two implementations they would eventually round differently, and the difference
 * would surface as a journal entry that does not equal the invoice it came from. Section 4.3
 * requires rounding to be stated per operation and applied at defined points; this is that
 * statement, in one place.
 *
 * THE ORDER OF OPERATIONS IS THE SALES ORDER'S, line for line. Gross, then discounted, then
 * rounded once to the amount scale, then tax on the rounded subtotal. Anything else would make an
 * invoice for the whole of an order disagree with the order's own total by a rounding step, which
 * is the kind of penny a customer notices and nobody can explain.
 */

import {
  add,
  multiply,
  parseDecimal,
  round,
  subtract,
  toFixed,
  type Decimal,
} from '../shared/decimal.js';

/** The scales the schema declares. Amounts at four, everything else at six. */
export const AMOUNT_SCALE = 4;
export const RATE_SCALE = 6;

const ONE_HUNDRED = parseDecimal('100');

/** What a line is computed from. Every one of these is a persisted figure, never a caller's. */
export interface BillableAmounts {
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  taxRatePercent: Decimal;
}

/** What it comes to, at the schema's scales, as the decimal strings section 4.3 requires. */
export interface BilledAmounts {
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
}

export function billedAmounts(input: BillableAmounts): BilledAmounts {
  const gross = multiply(input.quantity, input.unitPrice);
  const keptFraction = subtract(ONE_HUNDRED, input.discountPercent);
  const discounted = divideByHundred(multiply(gross, keptFraction));
  const lineSubtotal = round(discounted, AMOUNT_SCALE);

  // Tax on the rounded subtotal, which is the figure that appears on the document. Computing it
  // on the unrounded one would produce a tax that does not follow from the numbers a customer can
  // see on the paper they were sent.
  const lineTax = round(divideByHundred(multiply(lineSubtotal, input.taxRatePercent)), AMOUNT_SCALE);

  return {
    lineSubtotal: toFixed(lineSubtotal, AMOUNT_SCALE),
    lineTax: toFixed(lineTax, AMOUNT_SCALE),
    lineTotal: toFixed(add(lineSubtotal, lineTax), AMOUNT_SCALE),
  };
}

/**
 * The document totals, summed from the lines as stored.
 *
 * No rounding: each line was already rounded to the amount scale, so the sum is exact and no
 * difference arises for section 4.3 to allocate to a line.
 */
export function documentTotals(
  lines: readonly { lineSubtotal: string; lineTax: string }[],
): { subtotal: string; taxTotal: string; total: string } {
  let subtotal = parseDecimal('0', AMOUNT_SCALE);
  let taxTotal = parseDecimal('0', AMOUNT_SCALE);

  for (const line of lines) {
    subtotal = add(subtotal, parseDecimal(line.lineSubtotal, AMOUNT_SCALE));
    taxTotal = add(taxTotal, parseDecimal(line.lineTax, AMOUNT_SCALE));
  }

  return {
    subtotal: toFixed(subtotal, AMOUNT_SCALE),
    taxTotal: toFixed(taxTotal, AMOUNT_SCALE),
    total: toFixed(add(subtotal, taxTotal), AMOUNT_SCALE),
  };
}

/** Percentages are applied by dividing once, exactly, at the end of a multiplication. */
function divideByHundred(value: Decimal): Decimal {
  return { units: value.units, scale: value.scale + 2 };
}
