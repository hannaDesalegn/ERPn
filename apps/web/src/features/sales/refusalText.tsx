/**
 * What to show when the server refuses.
 *
 * ONE INTERPRETATION, SHARED. Confirming and creating both refuse in the same vocabulary, because
 * they are the same API answering. A second copy of this would drift, and two screens explaining
 * the same 403 differently is how a user learns not to trust either.
 *
 * The server's own words are used wherever it chose to explain: how much stock there actually
 * was, which two states a transition was between, or which referenced record was not usable. Where
 * it deliberately says little, because saying more would describe a record the caller may not see,
 * this supplies a sentence that is useful without adding anything the server did not.
 *
 * NO BUSINESS RULE IS DECIDED HERE. Every branch is about wording. The refusal already happened.
 */

import { ApiError } from '@/services/client';

export function refusalText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The server could not be reached. Check your connection and try again.';
  }

  if (error.status === 403) {
    return 'You do not have permission to do that in this company.';
  }

  if (error.status === 404) {
    return 'That record is no longer available.';
  }

  if (error.status >= 500) {
    return 'The server could not complete the request. Nothing was changed.';
  }

  return error.message;
}

/**
 * A key for one submission intent.
 *
 * Section 11 is explicit that a key belongs to a user intent rather than a network attempt:
 * pressing the button once produces one key however many times the request is transmitted. Both
 * mutating screens make one when the intent begins and reuse it for every retry, so this lives
 * beside them rather than being written twice.
 *
 * `crypto.randomUUID` where the browser has it, which is every browser this application supports
 * over HTTPS, and a random fallback where it does not. The value only has to be unique per intent;
 * it authenticates nothing and is never a secret.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
