/**
 * Session tokens.
 *
 * Contract section 5.1: the client receives an opaque session identifier in a cookie. Opaque
 * means it carries no information, so it cannot be decoded, tampered with, or reasoned about
 * by anyone holding it.
 *
 * WHY SHA-256 HERE AND ARGON2 FOR PASSWORDS. The two look inconsistent and are not. A password
 * is low entropy, chosen by a human, and guessable, so hashing it must be deliberately slow to
 * make offline guessing expensive. A session token is 256 bits from a cryptographic generator,
 * so there is nothing to guess: an attacker who steals the stored hash cannot work backwards,
 * and no amount of slowness would add to that. Argon2 here would only add tens of milliseconds
 * to every authenticated request, which is a real cost for no benefit.
 *
 * The token is hashed rather than stored for one reason: a leak of the sessions table must not
 * hand over usable sessions. Same argument as password hashes, different threat.
 *
 * NOTHING HERE LOGS. The raw token is a bearer credential for the length of a session.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes, 256 bits. Enough that guessing is not a threat model worth modelling. */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Goes to the client. Never stored, never logged. */
  token: string;
  /** Goes to the database. Never leaves the server. */
  tokenHash: string;
}

export function issueSessionToken(): IssuedToken {
  // base64url so the value is safe in a cookie without escaping, and so a copy-paste during
  // debugging cannot be mangled into a different valid-looking token.
  const token = randomBytes(TOKEN_BYTES).toString('base64url');

  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant time comparison of two token hashes.
 *
 * Session lookup goes through a unique index on the hash, so this is not on the hot path. It
 * exists for the places that compare a computed hash against a fetched one, where an early
 * exit would leak how many leading characters matched.
 */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on length mismatch, which would itself be a signal. Lengths are
  // fixed for real hashes, so a mismatch means malformed input and the answer is simply no.
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
