/**
 * Claiming an idempotency key, and storing what the operation answered.
 *
 * TWO METHODS, AND THE FIRST ONE IS THE LOCK. `claim` inserts the record and does nothing on
 * conflict. That single statement is the whole concurrency design of section 11: two requests
 * carrying one key both reach it, and PostgreSQL makes the second wait for the first transaction
 * to finish rather than letting it proceed. If the first commits, the second's insert affects no
 * row and it finds the stored response; if the first rolls back, the second's insert succeeds and
 * it does the work itself. Nothing else has to be locked, and no record can outlive the
 * transaction that claimed it.
 *
 * THE ONLY DELETE IS THE EXPIRING ONE. Section 11 makes expiry a retention job's work, and a
 * request path able to remove its own record could replay an operation by forgetting it first.
 * Migration 0011 answers that with a restrictive policy rather than with trust: every delete is
 * ANDed with an expiry test in the database, so no statement from this role can remove a record
 * whose window is still open, whatever predicate a future caller writes here.
 */

import { and, eq, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { idempotencyRecords } from '../schema/idempotency.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import type {
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyRepository,
  StoredResponse,
} from './types.js';

/** The same handle every other repository takes: a transaction, never the pool. */
type Db = NodePgDatabase<Record<string, never>>;

export class DrizzleIdempotencyRepository implements IdempotencyRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  /**
   * The acting user, which section 11 makes part of the key's identity.
   *
   * Required rather than optional: a system scope has nobody to attribute an intent to, and an
   * idempotency record without a user would be one anybody could replay.
   */
  private actor(): string {
    const userId = actingUserId(this.scope);
    if (!userId) throw new Error('Idempotency needs an acting user, per section 11');
    return userId;
  }

  async find(endpoint: string, key: string): Promise<IdempotencyRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Idempotency');

    const rows = await this.db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.tenantId, tenantId),
          eq(idempotencyRecords.companyId, companyId),
          // The user is part of the identity, per section 11. One person's key is not another's.
          eq(idempotencyRecords.userId, this.actor()),
          eq(idempotencyRecords.endpoint, endpoint),
          eq(idempotencyRecords.idempotencyKey, key),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Takes the key for this transaction, or reports that somebody already has it.
   *
   * Returns the record when this transaction now owns it, and null when the key was already
   * claimed by a transaction that has since committed. In the second case the caller re-reads and
   * answers with what was stored, which is section 11's replay.
   */
  async claim(input: IdempotencyClaim): Promise<IdempotencyRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Idempotency');
    const actor = this.actor();

    const rows = await this.db
      .insert(idempotencyRecords)
      .values({
        id: input.id,
        // From the scope, never from the request. A caller cannot claim a key in another company.
        tenantId,
        companyId,
        userId: actor,
        endpoint: input.endpoint,
        idempotencyKey: input.key,
        requestFingerprint: input.fingerprint,
        expiresAt: input.expiresAt,
        createdBy: actor,
        updatedBy: actor,
      })
      // The wait, and the decision. See the note at the top of this file.
      .onConflictDoNothing()
      .returning();

    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Stores what the operation answered, in the transaction that claimed the key.
   *
   * A record without a response is one whose transaction is still running, and no other
   * transaction can see it: a competing claim is either blocked on the unique index or looking at
   * a row whose writer has already committed.
   */
  async complete(id: string, response: StoredResponse): Promise<void> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Idempotency');

    await this.db
      .update(idempotencyRecords)
      .set({
        responseStatus: response.status,
        responseBody: response.body,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(idempotencyRecords.id, id),
          eq(idempotencyRecords.tenantId, tenantId),
          eq(idempotencyRecords.companyId, companyId),
        ),
      );
  }
  /**
   * Removes this scope's expired records.
   *
   * Takes the moment rather than reading the clock, so a caller sweeping many companies uses one
   * instant for all of them and a test can place a record either side of a boundary it chose.
   * The database applies its own `now()` as well, through the restrictive policy, so a caller
   * passing a future time still cannot remove a live record.
   */
  async deleteExpired(now: Date): Promise<number> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Idempotency');

    const removed = await this.db
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.tenantId, tenantId),
          eq(idempotencyRecords.companyId, companyId),
          // Expired means the moment has arrived, not passed. `session-policy.ts` reads its own
          // expiry the same way, and migration 0011 writes the same rule into the policy.
          lte(idempotencyRecords.expiresAt, now),
        ),
      )
      .returning({ id: idempotencyRecords.id });

    return removed.length;
  }
}

function toRecord(row: typeof idempotencyRecords.$inferSelect): IdempotencyRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    userId: row.userId,
    endpoint: row.endpoint,
    key: row.idempotencyKey,
    fingerprint: row.requestFingerprint,
    response:
      row.responseStatus === null || row.responseBody === null
        ? null
        : { status: row.responseStatus, body: row.responseBody as Record<string, unknown> },
    expiresAt: row.expiresAt,
  };
}
