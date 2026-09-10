/**
 * Repository implementations. INTERNAL.
 *
 * Nothing in this file is re-exported from the data layer's public entry point. The classes are
 * constructed only by `UnitOfWork`, inside a transaction whose tenant context is already set.
 * Contract section 6.3: constructing an unscoped query must not be possible through the public
 * interface of the data layer.
 *
 * Two rules every method here follows, and a reviewer should check for:
 *
 * 1. The scope predicate is in the query, not applied afterwards. Section 6.3 is explicit that
 *    fetching by id and then checking ownership is the wrong shape: it is correct only if every
 *    endpoint remembers, and one forgotten endpoint is a breach. A scoped query returns nothing
 *    instead.
 * 2. Writes stamp `tenant_id` and `company_id` from the scope, never from the input. The input
 *    types in `types.ts` have no field to supply them, which is the first line of defence, and
 *    this is the second. Section 14.3 forbids binding a request body to an entity for the same
 *    reason.
 *
 * Row level security is the third line. If a predicate here were ever forgotten, the policy
 * still denies. Section 2.4 requires both layers and permits neither to stand alone.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  companies,
  memberships,
  sessions,
  users,
} from '../schema/identity.js';
import type { ActorScope, Scope, SystemScope } from '../scope.js';
import { actingUserId } from '../scope.js';
import {
  ConcurrencyConflictError,
  RecordNotFoundError,
  type AuditEventInput,
  type AuditEventRecord,
  type AuditRepository,
  type CompanyRecord,
  type CompanyRepository,
  type MembershipRecord,
  type MembershipRepository,
  type SessionRecord,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * The tenant a scope may act within.
 *
 * A system scope with no tenant has none, and every tenant-scoped repository method then has
 * nothing legitimate to query. Rather than silently returning empty results, the methods throw,
 * because a caller reaching a tenant-scoped repository without a tenant has a bug rather than an
 * empty database.
 */
function requireTenantId(scope: Scope): string {
  const tenantId = scope.kind === 'actor' ? scope.tenantId : scope.tenantId;
  if (!tenantId) {
    throw new Error(
      `A tenant-scoped repository was used under a system scope with no tenant (${
        (scope as SystemScope).reason
      }). Name the tenant with systemScope(reason, { tenantId }).`,
    );
  }
  return tenantId;
}

function requireCompanyId(scope: Scope): string {
  const companyId = scope.kind === 'actor' ? scope.companyId : scope.companyId;
  if (!companyId) {
    throw new Error(
      `A company-partitioned repository was used under a system scope with no company (${
        (scope as SystemScope).reason
      }). Name the company with systemScope(reason, { tenantId, companyId }).`,
    );
  }
  return companyId;
}

// ---------------------------------------------------------------------------------------
// Companies. Tenant scoped.
// ---------------------------------------------------------------------------------------

export class DrizzleCompanyRepository implements CompanyRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<CompanyRecord | null> {
    const tenantId = requireTenantId(this.scope);

    // The tenant predicate is part of the lookup. A company belonging to another tenant does
    // not fail an ownership check here; it is simply not among the rows this query can return.
    const rows = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.tenantId, tenantId)))
      .limit(1);

    return rows[0] ? toCompany(rows[0]) : null;
  }

  async listForTenant(): Promise<CompanyRecord[]> {
    const tenantId = requireTenantId(this.scope);

    const rows = await this.db
      .select()
      .from(companies)
      .where(eq(companies.tenantId, tenantId))
      .orderBy(companies.name);

    return rows.map(toCompany);
  }

  async create(input: {
    id: string;
    name: string;
    legalName?: string | null;
    baseCurrency: string;
  }): Promise<CompanyRecord> {
    const tenantId = requireTenantId(this.scope);

    const rows = await this.db
      .insert(companies)
      .values({
        id: input.id,
        // From the scope, not from the input. `input` has no tenantId field to supply.
        tenantId,
        name: input.name,
        legalName: input.legalName ?? null,
        baseCurrency: input.baseCurrency,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toCompany(row);
  }

  async rename(input: { id: string; name: string; expectedVersion: number }): Promise<CompanyRecord> {
    const tenantId = requireTenantId(this.scope);

    // Version is part of the WHERE clause, so a stale write updates nothing rather than
    // overwriting someone else's edit. Contract section 10.1.
    const rows = await this.db
      .update(companies)
      .set({
        name: input.name,
        version: sql`${companies.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(companies.id, input.id),
          eq(companies.tenantId, tenantId),
          eq(companies.version, input.expectedVersion),
        ),
      )
      .returning();

    const row = rows[0];
    if (row) return toCompany(row);

    // Nothing updated. Distinguish "gone or not yours" from "someone else got there first",
    // without leaking which. Both look identical to a caller from another tenant.
    const current = await this.findById(input.id);
    if (!current) throw new RecordNotFoundError('Company', input.id);
    throw new ConcurrencyConflictError('Company', input.id);
  }
}

// ---------------------------------------------------------------------------------------
// Memberships. Company partitioned.
// ---------------------------------------------------------------------------------------

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<MembershipRecord | null> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    const rows = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, id),
          eq(memberships.tenantId, tenantId),
          eq(memberships.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toMembership(rows[0]) : null;
  }

  async listForCompany(): Promise<MembershipRecord[]> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.companyId, companyId)));

    return rows.map(toMembership);
  }

  /**
   * Tenant scoped but not company scoped, deliberately, and the only method here that is.
   *
   * Company switching has to know which companies a user may enter, which cannot be answered
   * from inside one company. It stays inside the tenant, which is the boundary that matters.
   * Section 2.4 records the same reasoning for why the row level security policy on this table
   * is tenant-only.
   */
  async listCompanyIdsForUser(userId: string): Promise<string[]> {
    const tenantId = requireTenantId(this.scope);

    const rows = await this.db
      .select({ companyId: memberships.companyId })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      );

    return rows.map((row) => row.companyId);
  }

  async create(input: { id: string; userId: string }): Promise<MembershipRecord> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    const rows = await this.db
      .insert(memberships)
      .values({
        id: input.id,
        tenantId,
        companyId,
        userId: input.userId,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toMembership(row);
  }
}

// ---------------------------------------------------------------------------------------
// Users. Global, per contract section 4.6.
// ---------------------------------------------------------------------------------------

export class DrizzleUserRepository implements UserRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    // Matches the functional unique index the migration creates on lower(email).
    const rows = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);

    return rows[0] ? toUser(rows[0]) : null;
  }

  async create(input: {
    id: string;
    email: string;
    name: string;
    passwordHash?: string | null;
    externalSubjectId?: string | null;
  }): Promise<UserRecord> {
    const rows = await this.db
      .insert(users)
      .values({
        id: input.id,
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash ?? null,
        externalSubjectId: input.externalSubjectId ?? null,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toUser(row);
  }
}

// ---------------------------------------------------------------------------------------
// Audit. Append only.
// ---------------------------------------------------------------------------------------

export class DrizzleAuditRepository implements AuditRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async append(event: AuditEventInput): Promise<AuditEventRecord> {
    // Scope and actor come from the context, never from the event. Contract section 7.1: the
    // actor is taken from the authenticated session, never from a request body.
    const tenantId = this.scope.kind === 'actor' ? this.scope.tenantId : (this.scope.tenantId ?? null);
    const companyId =
      this.scope.kind === 'actor' ? this.scope.companyId : (this.scope.companyId ?? null);

    const rows = await this.db
      .insert(auditEvents)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        companyId,
        actorUserId: actingUserId(this.scope),
        actorRoles: event.actorRoles ?? [],
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        summary: event.summary,
        changes: event.changes ?? null,
        requestId: event.requestId ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toAuditEvent(row);
  }

  async listForEntity(entityType: string, entityId: string): Promise<AuditEventRecord[]> {
    const tenantId = requireTenantId(this.scope);

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.entityType, entityType),
          eq(auditEvents.entityId, entityId),
        ),
      )
      .orderBy(auditEvents.occurredAt);

    return rows.map(toAuditEvent);
  }

  // There is deliberately no update and no delete. Contract section 7.1.
}

// ---------------------------------------------------------------------------------------
// Row mapping. Persistence rows are not the shape the application passes around.
// ---------------------------------------------------------------------------------------

type Row<T> = Record<string, unknown> & T;

function toCompany(row: Row<typeof companies.$inferSelect>): CompanyRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    legalName: row.legalName,
    baseCurrency: row.baseCurrency,
    status: row.status,
    version: row.version,
  };
}

function toMembership(row: Row<typeof memberships.$inferSelect>): MembershipRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    userId: row.userId,
    status: row.status,
    version: row.version,
  };
}

function toUser(row: Row<typeof users.$inferSelect>): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    externalSubjectId: row.externalSubjectId,
    version: row.version,
  };
}

function toAuditEvent(row: Row<typeof auditEvents.$inferSelect>): AuditEventRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    actorUserId: row.actorUserId,
    actorRoles: row.actorRoles,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    changes: row.changes,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    occurredAt: row.occurredAt,
  };
}

export type { ActorScope };

// ---------------------------------------------------------------------------------------
// Sessions. Global, per contract section 4.6.
// ---------------------------------------------------------------------------------------

export class DrizzleSessionRepository implements SessionRepository {
  /**
   * No scope parameter, unlike every other repository here, and the absence is deliberate
   * rather than an oversight. Sessions are global per contract section 4.6: they belong to a
   * global user and exist before any company is chosen. Taking a scope and then ignoring it
   * would suggest a filter that is not applied.
   *
   * Section 4.6 also says a global table is not unprotected. What protects this one is that
   * every method is keyed by a value the caller must already hold: a token hash they were
   * given, or a session id they resolved from one. There is no listing.
   */
  constructor(private readonly db: Db) {}

  /**
   * Lookup is by token hash and nothing else.
   *
   * Expiry and revocation are evaluated by the caller rather than filtered out here, because
   * the reasons differ and the caller needs to know which one applied: an idle session can be
   * refused with "sign in again", a revoked one means something happened to the account.
   */
  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);

    return rows[0] ? toSession(rows[0]) : null;
  }

  async create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SessionRecord> {
    const rows = await this.db
      .insert(sessions)
      .values({
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        idleExpiresAt: input.idleExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        // activeCompanyId stays null. Authentication establishes identity; company context is
        // a later increment, per contract section 5.4.
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toSession(row);
  }

  /**
   * Extends the idle window only.
   *
   * There is deliberately no way to move `absoluteExpiresAt`. Section 5.3 requires an absolute
   * lifetime that use never extends, and the way that requirement usually dies is a helper
   * that updates both because it looked symmetric.
   */
  async touch(input: { id: string; idleExpiresAt: Date }): Promise<void> {
    await this.db
      .update(sessions)
      .set({ idleExpiresAt: input.idleExpiresAt, lastSeenAt: new Date() })
      .where(and(eq(sessions.id, input.id), isNull(sessions.revokedAt)));
  }

  async revoke(id: string): Promise<void> {
    // Only unrevoked rows, so the original revocation time survives a repeated logout.
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.length;
  }
}

function toSession(row: Row<typeof sessions.$inferSelect>): SessionRecord {
  // The token hash is deliberately not mapped through. Nothing above this layer needs it, and
  // a field nobody needs is a field that ends up in a log line.
  return {
    id: row.id,
    userId: row.userId,
    activeCompanyId: row.activeCompanyId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
  };
}
