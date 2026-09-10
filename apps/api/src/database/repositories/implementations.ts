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

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { isPermission } from '../../authorization/permissions.js';
import {
  auditEvents,
  companies,
  memberships,
  membershipRoles,
  rolePermissions,
  roles,
  sessions,
  users,
} from '../schema/identity.js';
import type { ActorScope, PrincipalScope, Scope, SystemScope } from '../scope.js';
import { actingUserId, companyIdOf, tenantIdOf } from '../scope.js';
import {
  ConcurrencyConflictError,
  RecordNotFoundError,
  UnknownPermissionError,
  type AuditEventInput,
  type AuditEventRecord,
  type AuditRepository,
  type CompanyRecord,
  type CompanyRepository,
  type MembershipRecord,
  type MembershipRepository,
  type RoleRecord,
  type RoleRepository,
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
  const tenantId = tenantIdOf(scope);
  if (!tenantId) {
    throw new Error(
      `A tenant-scoped repository was used under a system scope with no tenant (${
        (scope as SystemScope).reason
      }). Name the tenant with systemScope(reason, { tenantId }).`,
    );
  }
  return tenantId;
}

/**
 * The person a scope acts as, when the operation is about that person specifically.
 *
 * A system scope has no person, so an operation defined as "my own rows" has no meaning under
 * one and refuses rather than guessing. An actor scope does have a person, but its tenant
 * context confines the read to one tenant, which is the opposite of what discovery needs, so it
 * is refused too and the caller is told which scope to use.
 */
function requirePrincipal(scope: Scope): PrincipalScope {
  if (scope.kind !== 'principal') {
    throw new Error(
      `Own-membership discovery requires a principal scope, received ${scope.kind}. It is cross-tenant by design and a scope carrying a tenant would narrow it to one.`,
    );
  }
  return scope;
}

function requireActorUserId(scope: Scope): string {
  if (scope.kind !== 'actor') {
    throw new Error(
      `This method reads the acting user's own row and requires an actor scope, received ${scope.kind}.`,
    );
  }
  return scope.userId;
}

function requireCompanyId(scope: Scope): string {
  const companyId = companyIdOf(scope);
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

  async listByIds(ids: string[]): Promise<CompanyRecord[]> {
    const tenantId = requireTenantId(this.scope);
    // An empty list is a legitimate answer, not a query. `inArray` with no values produces SQL
    // that some drivers reject and others turn into a match-everything, and the second is the
    // dangerous one.
    if (ids.length === 0) return [];

    const rows = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), inArray(companies.id, ids)))
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

  async findOwnForActiveCompany(): Promise<MembershipRecord | null> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);
    const userId = requireActorUserId(this.scope);

    // All three predicates are in the query. The company context is only trustworthy because
    // this returns nothing when the membership is absent, revoked or belongs to another tenant,
    // rather than returning a row for the caller to inspect and possibly forget to check.
    const rows = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.companyId, companyId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);

    return rows[0] ? toMembership(rows[0]) : null;
  }

  async listOwn(): Promise<MembershipRecord[]> {
    const { userId } = requirePrincipal(this.scope);

    // No tenant predicate, which is the one place in this file that is deliberate rather than
    // an omission. The user predicate is the boundary here, and migration 0004 applies the same
    // predicate again as a policy, so a mistake in this line returns nothing rather than
    // everything.
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));

    return rows.map(toMembership);
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

  async findPasswordHash(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return rows[0]?.passwordHash ?? null;
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
// Roles. Company partitioned.
// ---------------------------------------------------------------------------------------

export class DrizzleRoleRepository implements RoleRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  /**
   * The roles held by one membership in the acting company.
   *
   * Both sides of the join carry the scope predicate. A membership identifier from another
   * company returns nothing rather than that company's roles, which is the shape section 6.3
   * asks for: the identifier does not fail a check, it simply matches no row.
   */
  async listForMembership(membershipId: string): Promise<RoleRecord[]> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    const rows = await this.db
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        description: roles.description,
      })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(
          eq(roles.id, membershipRoles.roleId),
          eq(roles.tenantId, tenantId),
          eq(roles.companyId, companyId),
        ),
      )
      .where(
        and(
          eq(membershipRoles.membershipId, membershipId),
          eq(membershipRoles.tenantId, tenantId),
          eq(membershipRoles.companyId, companyId),
        ),
      )
      .orderBy(roles.name);

    return rows;
  }

  async listPermissionsForMembership(membershipId: string): Promise<string[]> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    // Three tables, and the scope predicate is on all three. Filtering only the membership rows
    // and joining outward would let a role or a grant belonging to another company ride in on a
    // join, which is the shape section 6.3 rejects.
    const rows = await this.db
      .selectDistinct({ permission: rolePermissions.permission })
      .from(membershipRoles)
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.roleId, membershipRoles.roleId),
          eq(rolePermissions.tenantId, tenantId),
          eq(rolePermissions.companyId, companyId),
        ),
      )
      .where(
        and(
          eq(membershipRoles.membershipId, membershipId),
          eq(membershipRoles.tenantId, tenantId),
          eq(membershipRoles.companyId, companyId),
        ),
      );

    return rows.map((row) => row.permission).sort();
  }

  async create(input: {
    id: string;
    key: string;
    name: string;
    description?: string | null;
  }): Promise<RoleRecord> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    const rows = await this.db
      .insert(roles)
      .values({
        id: input.id,
        // From the scope. A role is owned by one company, per section 2.7, and the input has no
        // field with which to claim another.
        tenantId,
        companyId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return { id: row.id, key: row.key, name: row.name, description: row.description };
  }

  async grantPermissions(input: {
    roleId: string;
    permissions: readonly string[];
  }): Promise<void> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    // Section 2.7, the write-time half of the two checks. There is no permissions table and so
    // no foreign key to refuse an invented string; this is what refuses it instead. Every string
    // is checked before any row is written, so a batch containing one bad value writes none of
    // them rather than half.
    const unknown = input.permissions.filter((permission) => !isPermission(permission));
    if (unknown.length > 0) {
      throw new UnknownPermissionError(unknown);
    }
    if (input.permissions.length === 0) return;

    await this.db
      .insert(rolePermissions)
      .values(
        input.permissions.map((permission) => ({
          tenantId,
          companyId,
          roleId: input.roleId,
          permission,
          createdBy: actingUserId(this.scope),
        })),
      )
      // Granting what is already granted is not an error. The pair is the primary key, so the
      // second grant is simply a no-op rather than a duplicate row or a failure.
      .onConflictDoNothing();
  }

  async revokePermission(input: { roleId: string; permission: string }): Promise<void> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    await this.db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, input.roleId),
          eq(rolePermissions.permission, input.permission),
          eq(rolePermissions.tenantId, tenantId),
          eq(rolePermissions.companyId, companyId),
        ),
      );
  }

  async assignToMembership(input: { membershipId: string; roleId: string }): Promise<void> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    await this.db
      .insert(membershipRoles)
      .values({
        tenantId,
        companyId,
        membershipId: input.membershipId,
        roleId: input.roleId,
        createdBy: actingUserId(this.scope),
      })
      .onConflictDoNothing();
  }

  async removeFromMembership(input: { membershipId: string; roleId: string }): Promise<void> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    await this.db
      .delete(membershipRoles)
      .where(
        and(
          eq(membershipRoles.membershipId, input.membershipId),
          eq(membershipRoles.roleId, input.roleId),
          eq(membershipRoles.tenantId, tenantId),
          eq(membershipRoles.companyId, companyId),
        ),
      );
  }

  async listStoredPermissions(): Promise<string[]> {
    const tenantId = requireTenantId(this.scope);
    const companyId = requireCompanyId(this.scope);

    const rows = await this.db
      .selectDistinct({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(
        and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.companyId, companyId)),
      );

    return rows.map((row) => row.permission).sort();
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
    const tenantId = tenantIdOf(this.scope) ?? null;
    const companyId = companyIdOf(this.scope) ?? null;

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
   *
   * The scope arrived later and is used by exactly one method, `setActiveCompany`, which writes
   * the acting company rather than accepting one. Every other method here ignores it, and that
   * is stated rather than left to be inferred from reading them all.
   */
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

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

  async setActiveCompany(input: { id: string }): Promise<void> {
    const companyId = requireCompanyId(this.scope);

    // Live sessions only. A revoked or expired session must not acquire a company context it
    // could be replayed with if it were ever un-revoked.
    await this.db
      .update(sessions)
      .set({ activeCompanyId: companyId, lastSeenAt: new Date() })
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
