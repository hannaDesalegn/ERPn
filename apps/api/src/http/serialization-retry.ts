/**
 * Retrying a transaction the database refused for a concurrency reason.
 *
 * Architecture section 10.3: serialization failures are retried at the API boundary with bounded
 * backoff, and it says why that is safe here and nowhere else, "only because of idempotency per
 * section 11". A retried request re-claims the same key in a fresh transaction, so the work
 * happens once however many attempts it took.
 *
 * THIS IS THE SECOND LINE, NOT THE FIRST. Section 10.2 requires deadlocks to be designed out
 * rather than retried around, and `inventory/lock-order.ts` is where that is done. A retry that
 * papered over an inconsistent lock order would turn a design fault into an intermittent slowdown
 * nobody could find. What is left after the ordering is right is the class of failure ordering
 * cannot remove: a lock timeout, a serialization failure under a stricter isolation level, and a
 * deadlock against an operation that does not exist yet and gets its ordering wrong.
 *
 * WHY THE BOUNDARY. The whole transaction has to be retried, not a statement inside it: a failed
 * transaction has rolled back entirely, including the idempotency claim, so the retry starts from
 * nothing. That means the retry has to sit outside the unit of work, which is the controller.
 *
 * WHAT IS NEVER RETRIED. Only the two SQLSTATEs below. A refusal, a validation failure, a version
 * conflict and an idempotency conflict are all answers rather than accidents, and retrying any of
 * them would either repeat work the caller was told not to do or turn one honest refusal into
 * three. The test for this is that a domain error passes through on the first attempt.
 */

/** Serialization failure. A transaction could not be serialised against a concurrent one. */
const SERIALIZATION_FAILURE = '40001';

/** Deadlock detected. PostgreSQL broke a cycle by aborting this transaction. */
const DEADLOCK_DETECTED = '40P01';

/**
 * How many times the work is attempted in total, first try included.
 *
 * Three, and bounded for the reason section 10.3 gives by implication: an unbounded retry turns
 * a contended row into a queue with no end, and the caller waiting on it learns nothing. Two
 * retries clear a transient cycle; a third failure is a signal rather than noise.
 */
export const MAX_ATTEMPTS = 3;

/** Base backoff in milliseconds, doubled per attempt and jittered. */
const BASE_DELAY_MS = 20;

export interface RetryOptions {
  /** Injected by tests so the bounded wait does not become a bounded sleep in the suite. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Whether the database refused this for a reason another attempt could resolve.
 *
 * Walks the cause chain, because the query layer wraps driver errors and the SQLSTATE is never
 * on the outermost error. Asserting on the message instead would match an error whose text
 * happened to contain the word.
 */
export function isRetryable(error: unknown): boolean {
  for (let current: unknown = error; current !== null && current !== undefined; ) {
    const code = (current as { code?: unknown }).code;
    if (code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED) return true;

    if (!(current instanceof Error)) break;
    current = current.cause;
  }

  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs the work, retrying only a concurrency refusal, at most `MAX_ATTEMPTS` times.
 *
 * The last failure is rethrown as it arrived, so a caller that exhausts the attempts sees the
 * database's own error rather than one this invented. Anything not retryable is rethrown on the
 * first attempt, unchanged and without waiting.
 */
export async function withSerializationRetry<T>(
  work: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const wait = options.wait ?? sleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;

      // Exponential, with jitter, so two transactions that deadlocked against each other do not
      // wake together and do it again.
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      await wait(Math.round(backoff * (0.5 + Math.random())));
    }
  }
}
