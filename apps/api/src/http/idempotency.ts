/**
 * The idempotency boundary of section 11.
 *
 * WHAT THE CONTRACT ASKS FOR, clause by clause, because the whole of this file is those clauses:
 *
 *   every state changing endpoint accepts an `Idempotency-Key` header
 *   the server stores the key, a fingerprint of the request, and the response
 *   scoped by company, user and endpoint
 *   a replay with the same key returns the stored response without re-performing the operation
 *   a replay with the same key but a different request body is rejected as a conflict
 *   records live in PostgreSQL with a bounded retention window
 *
 * THE RECORD AND THE WORK SHARE ONE TRANSACTION, which is the part that is easy to get wrong.
 * Claiming the key outside the operation's transaction would leave a record describing work that
 * never committed, and every retry afterwards would replay a success that never happened. So this
 * runs inside the caller's unit of work: the claim, the operation and the stored response commit
 * together or not at all. A rolled back confirmation leaves no key claimed, and the retry that
 * follows does the work for real.
 *
 * CONCURRENCY IS THE UNIQUE INDEX AND NOTHING ELSE. Two requests carrying one key both try to
 * claim it. PostgreSQL makes the second wait for the first transaction to finish rather than
 * letting it proceed, so one of exactly two things happens: the first commits and the second
 * finds the stored response, or the first rolls back and the second does the work itself. There
 * is no window in which both run, and no second lock to order against the ones the operation
 * already takes.
 *
 * THE STATE MACHINE IS STILL THE GUARD. Section 11 is explicit that a transition is additionally
 * guarded by its own current state, so that an already confirmed order fails on the transition
 * table even when the idempotency record has expired. Nothing here replaces that, and the
 * confirmation operation checks it whether or not a key was supplied.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ScopedRepositories, StoredResponse } from '../database/index.js';

/** The repositories this needs from a transaction already in progress. */
export type IdempotencyRepositories = Pick<ScopedRepositories, 'idempotency'>;

/**
 * How long a record is worth keeping.
 *
 * Section 11 requires a bounded window and leaves its length open. A day is long enough to cover
 * a client retrying after a timeout, an outage, or a person coming back after lunch, and short
 * enough that the table does not become a log. The expiring job is not written yet.
 */
export const RETENTION_HOURS = 24;

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`The idempotency key ${key} was already used for a different request`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Whether a response came from doing the work or from replaying a record. */
export interface IdempotentOutcome {
  response: StoredResponse;
  replayed: boolean;
}

/**
 * A stable digest of what the caller asked for.
 *
 * Section 11 rejects a replay whose request differs, which needs a comparison that does not
 * depend on key order or whitespace in the body. Only the digest is stored: keeping the request
 * itself would retain whatever the caller sent, which this table has no business holding.
 */
export function fingerprintOf(request: unknown): string {
  return createHash('sha256').update(canonical(request)).digest('hex');
}

/**
 * Runs an operation at most once per key, inside the caller's transaction.
 *
 * The operation is invoked only when this transaction owns the key. A replay never calls it,
 * which is what section 11 means by returning the stored response without re-performing the
 * operation.
 */
export async function runIdempotently(
  repositories: IdempotencyRepositories,
  request: {
    endpoint: string;
    key: string;
    fingerprint: string;
  },
  operation: () => Promise<StoredResponse>,
): Promise<IdempotentOutcome> {
  const expiresAt = new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000);

  const claimed = await repositories.idempotency.claim({
    id: randomUUID(),
    endpoint: request.endpoint,
    key: request.key,
    fingerprint: request.fingerprint,
    expiresAt,
  });

  if (!claimed) {
    // Somebody else holds the key and has committed. Either this is the same intent arriving
    // twice, which replays, or the same key attached to a different one, which is a conflict.
    const existing = await repositories.idempotency.find(request.endpoint, request.key);

    if (!existing) {
      // Unreachable: the claim only declines when a row is there to conflict with, and this
      // read runs after that row's transaction committed. Loud rather than silent, because the
      // alternative is performing an operation the caller may already have had done.
      throw new Error('An idempotency key was claimed by nobody');
    }

    if (existing.fingerprint !== request.fingerprint) {
      throw new IdempotencyConflictError(request.key);
    }

    if (!existing.response) {
      // Also unreachable, for the same reason: a record is completed before its transaction
      // commits, so a visible record always carries its response.
      throw new Error('An idempotency record committed without its response');
    }

    return { response: existing.response, replayed: true };
  }

  // This transaction owns the key, so the work happens exactly once. A failure from here throws,
  // and the claim rolls back with it, leaving the key free for the retry.
  const response = await operation();
  await repositories.idempotency.complete(claimed.id, response);

  return { response, replayed: false };
}

/** A deterministic rendering, so two equal requests digest equally whatever their key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);

  return `{${entries.join(',')}}`;
}
