/**
 * Exact decimal arithmetic, held as scaled integers.
 *
 * Contract section 4.3: money is stored as exact numeric, never floating point, and never a
 * plain integer of minor units. A JavaScript number is an IEEE-754 double, so `0.1 + 0.2` is not
 * `0.3` and a unit price of four ten-thousandths of a cent has no exact representation at all.
 * Everything below is `bigint`, which has no rounding the code did not ask for.
 *
 * WHY NOT A LIBRARY. This needs four operations at fixed scales, and the alternative is a
 * dependency in the path of every monetary figure the system computes. The project has been
 * strict about what it carries, and the whole of what a library would do for us is here, tested
 * to the edges it actually meets. If the arithmetic ever grows past this, that judgement should
 * be revisited rather than defended.
 *
 * ROUNDING IS HALF AWAY FROM ZERO, AND STATED. Section 4.3 requires rounding to be explicit,
 * stated per operation, and applied at defined points only. Half away from zero is the ordinary
 * commercial convention: 2.5 rounds to 3 and -2.5 to -3. It is applied only where a caller asks
 * for a scale, never as a side effect of a multiplication.
 */

/** A number held as `units` at ten to the negative `scale`. `12.3456` is `123456` at scale 4. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

/** The largest scale any column in the schema uses, which bounds what a caller may supply. */
export const MAX_SCALE = 6;

export class DecimalParseError extends Error {
  constructor(value: string, reason: string) {
    super(`${JSON.stringify(value)} is not a usable decimal: ${reason}`);
    this.name = 'DecimalParseError';
  }
}

const PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal string, exactly.
 *
 * Strict on purpose. No exponent form, no leading plus, no spaces, no empty fraction, and
 * nothing that `Number()` would quietly accept and round. A malformed figure has to fail here
 * rather than arrive as a plausible wrong number, which is what section 14.2 means by rejecting
 * rather than ignoring.
 */
export function parseDecimal(value: string, maxScale = MAX_SCALE): Decimal {
  if (typeof value !== 'string') throw new DecimalParseError(String(value), 'not a string');

  const match = PATTERN.exec(value);
  if (!match) throw new DecimalParseError(value, 'expected digits with an optional single point');

  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > maxScale) {
    throw new DecimalParseError(value, `more than ${maxScale} decimal places`);
  }

  const units = BigInt(`${sign ?? ''}${whole}${fraction}`);

  return { units, scale: fraction.length };
}

/** Zero at a given scale, which is a real value rather than an absent one. */
export function zero(scale: number): Decimal {
  return { units: 0n, scale };
}

export function isNegative(value: Decimal): boolean {
  return value.units < 0n;
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

export function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = shift(a, scale).units;
  const right = shift(b, scale).units;

  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Multiplies. The result's scale is the sum of the inputs', which is exact and never rounds.
 *
 * Rounding happens only when a caller asks for a scale with `round`. Rounding inside a
 * multiplication is how a total stops equalling the sum of its parts.
 */
export function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);

  return { units: shift(a, scale).units + shift(b, scale).units, scale };
}

export function subtract(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);

  return { units: shift(a, scale).units - shift(b, scale).units, scale };
}

/**
 * Rounds to a scale, half away from zero.
 *
 * The only place in this module where information is discarded, which is why it is a call a
 * caller has to make rather than something that happens on the way through an operator.
 */
export function round(value: Decimal, scale: number): Decimal {
  if (scale >= value.scale) return shift(value, scale);

  const factor = tenTo(value.scale - scale);
  const quotient = value.units / factor;
  const remainder = value.units % factor;
  const twice = remainder < 0n ? -remainder * 2n : remainder * 2n;

  if (twice < factor) return { units: quotient, scale };

  return { units: quotient + (value.units < 0n ? -1n : 1n), scale };
}

/**
 * Renders at a scale, which is what the database column expects.
 *
 * Always the full scale, so `12.3` at scale 4 is `"12.3000"`. A column declared `NUMERIC(19,4)`
 * returns its values that way, and a value written back in a shorter form would compare unequal
 * to what came out of it.
 */
export function toFixed(value: Decimal, scale: number): string {
  const at = round(value, scale);
  const negative = at.units < 0n;
  const digits = (negative ? -at.units : at.units).toString().padStart(scale + 1, '0');

  const whole = digits.slice(0, digits.length - scale) || '0';
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';

  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Raises a decimal to a larger scale without rounding. Exact by construction. */
function shift(value: Decimal, scale: number): Decimal {
  if (scale === value.scale) return value;
  if (scale < value.scale) {
    throw new Error(`shift only widens: asked for ${scale} from ${value.scale}`);
  }

  return { units: value.units * tenTo(scale - value.scale), scale };
}

function tenTo(power: number): bigint {
  return 10n ** BigInt(power);
}
