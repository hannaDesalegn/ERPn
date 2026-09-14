/**
 * Retrying only what section 10.3 says to retry.
 *
 * Two properties matter and they pull against each other. A concurrency refusal must be tried
 * again, because the contract requires it and because the transaction rolled back leaving
 * nothing behind. Everything else must not, because a refusal, a validation failure and a
 * version conflict are answers, and repeating the work behind one of them is how a retry turns
 * an honest refusal into three, or worse, into an operation the caller was told not to do.
 *
 * The wait is injected, so the bounded backoff does not become a bounded sleep in this suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { isRetryable, MAX_ATTEMPTS, withSerializationRetry } from './serialization-retry.js';

/** A driver error as `pg` raises one: the SQLSTATE is on `code`. */
const pgError = (code: string): Error => Object.assign(new Error(`database said ${code}`), { code });

/** The same error after the query layer wrapped it, which is how a caller actually sees it. */
const wrapped = (error: Error): Error =>
  new Error('Failed query: update stock_reservations', { cause: error });

const noWait = { wait: async () => {} };

describe('deciding what can be retried', () => {
  it.each(['40001', '40P01'])('retries SQLSTATE %s', (code) => {
    expect(isRetryable(pgError(code))).toBe(true);
  });

  it('finds the code through the wrapper the query layer adds', () => {
    // Drizzle wraps driver errors, so the SQLSTATE is never on the outermost error. A check
    // that only read the top would never fire in production.
    expect(isRetryable(wrapped(pgError('40P01')))).toBe(true);
    expect(isRetryable(new Error('outer', { cause: wrapped(pgError('40001')) }))).toBe(true);
  });

  it.each(['23505', '23503', '22P02', '42501', 'ECONNRESET'])(
    'does not retry %s, which is an answer rather than an accident',
    (code) => {
      // A unique violation, a foreign key, a bad input, a permission denial. Every one of these
      // will fail identically on the next attempt, and 42501 in particular is the grant model
      // working.
      expect(isRetryable(pgError(code))).toBe(false);
    },
  );

  it('does not retry an ordinary error with no code at all', () => {
    expect(isRetryable(new Error('Sales order not found'))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });

  it('does not match on the message, which could say anything', () => {
    expect(isRetryable(new Error('deadlock detected 40P01'))).toBe(false);
  });
});

describe('retrying the work', () => {
  it('returns the first answer when nothing goes wrong', async () => {
    const work = vi.fn(async () => 'done');

    expect(await withSerializationRetry(work, noWait)).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('tries again after a deadlock and returns the later answer', async () => {
    let attempts = 0;
    const work = async () => {
      attempts += 1;
      if (attempts < 3) throw wrapped(pgError('40P01'));
      return 'done';
    };

    expect(await withSerializationRetry(work, noWait)).toBe('done');
    expect(attempts).toBe(3);
  });

  it('stops at the bound rather than retrying forever', async () => {
    // An unbounded retry turns a contended row into a queue with no end, and the caller waiting
    // on it learns nothing.
    const work = vi.fn(async () => {
      throw wrapped(pgError('40001'));
    });

    await expect(withSerializationRetry(work, noWait)).rejects.toThrow(/Failed query/);
    expect(work).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('rethrows the database’s own error rather than one it invented', async () => {
    const original = wrapped(pgError('40P01'));

    const thrown = await withSerializationRetry(async () => {
      throw original;
    }, noWait).catch((error: unknown) => error);

    expect(thrown).toBe(original);
  });

  it('does not retry a domain refusal, and does not wait before rethrowing it', async () => {
    // The property that keeps a retry from repeating work the caller was refused. A conflict, a
    // forbidden and a validation failure all arrive here as ordinary errors.
    const wait = vi.fn(async () => {});
    const work = vi.fn(async () => {
      throw new Error('A sales order cannot move from confirmed to confirmed');
    });

    await expect(withSerializationRetry(work, { wait })).rejects.toThrow(/cannot move/);
    expect(work).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits between attempts, and for longer each time', async () => {
    // Bounded backoff, per section 10.3. Jittered, so two transactions that deadlocked against
    // each other do not wake together and do it again, which is why this compares ranges.
    const waits: number[] = [];
    const work = async () => {
      throw wrapped(pgError('40P01'));
    };

    await withSerializationRetry(work, {
      wait: async (ms) => {
        waits.push(ms);
      },
    }).catch(() => undefined);

    expect(waits).toHaveLength(MAX_ATTEMPTS - 1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
  });
});
