/**
 * The public repository surface.
 *
 * These are interfaces only. The implementations are not exported, and there is no exported
 * constructor, factory or raw database handle anywhere in this layer. The only way to obtain a
 * repository is to be handed one inside a `UnitOfWork` callback, which has already opened a
 * transaction and set the tenant context. Contract section 6.3: constructing an unscoped query
 * must not be possible through the public interface of the data layer.
 *
 * Read every signature below with that in mind. No method takes a `tenantId` or `companyId`
 * argument, because the scope is not the caller's to supply. Passing one would reintroduce
 * exactly the vulnerability this layer exists to prevent: a caller who reads an identifier out
 * of a request body and hands it in as authority.
 */

export interface CompanyRecord {
  id: string;
  tenantId: string;
  name: string;
  legalName: string | null;
  baseCurrency: string;
  status: string;
  version: number;
}

export interface MembershipRecord {
  id: string;
  tenantId: string;
  companyId: string;
  userId: string;
  status: string;
  version: number;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  status: string;
  externalSubjectId: string | null;
  version: number;
}

export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  changes?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The actor's roles as they were at the time, per contract section 7.3. */
  actorRoles?: string[];
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  tenantId: string | null;
  companyId: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}

/**
 * Tenant scoped. Every read is confined to the acting tenant, and every write stamps the
 * tenant from the scope rather than from the payload.
 *
 * Note there is no `list all companies`. Reads return what the tenant may see, which is what
 * makes cross-tenant enumeration impossible rather than merely discouraged.
 */
export interface CompanyRepository {
  findById(id: string): Promise<CompanyRecord | null>;
  listForTenant(): Promise<CompanyRecord[]>;
  create(input: { id: string; name: string; legalName?: string | null; baseCurrency: string }): Promise<CompanyRecord>;
  /**
   * Optimistic locking per contract section 10.1. The caller supplies the version it read; a
   * mismatch is a conflict rather than a silent overwrite.
   */
  rename(input: { id: string; name: string; expectedVersion: number }): Promise<CompanyRecord>;
}

/** Company partitioned: reads and writes are confined to the acting company as well. */
export interface MembershipRepository {
  findById(id: string): Promise<MembershipRecord | null>;
  listForCompany(): Promise<MembershipRecord[]>;
  /** Across the tenant, which is what company switching needs. Still never across tenants. */
  listCompanyIdsForUser(userId: string): Promise<string[]>;
  create(input: { id: string; userId: string }): Promise<MembershipRecord>;
}

/**
 * Global, per contract section 4.6. Users are not tenant scoped, and pretending otherwise
 * would force a user row per tenant, which section 2.6 rejected.
 *
 * Section 4.6 also says absence of a tenant column is not absence of authorization: this
 * interface offers lookup by identity, never enumeration.
 */
export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(input: {
    id: string;
    email: string;
    name: string;
    passwordHash?: string | null;
    externalSubjectId?: string | null;
  }): Promise<UserRecord>;
}

/**
 * Append only, and the interface says so by having nowhere to put an update.
 *
 * Contract section 7.1 revokes `UPDATE` and `DELETE` from the application database role, so a
 * tampering attempt fails at the database even if code tried. This interface removes the
 * temptation one layer earlier: there is no method to call.
 */
export interface AuditRepository {
  append(event: AuditEventInput): Promise<AuditEventRecord>;
  listForEntity(entityType: string, entityId: string): Promise<AuditEventRecord[]>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  activeCompanyId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Global, per contract section 4.6. A session belongs to a global user and carries the active
 * company as state rather than as scope.
 *
 * NOTE WHAT IS ABSENT. There is no method that returns a token, and no field that holds one.
 * The raw token exists only in the moment it is issued and in the cookie afterwards; the
 * database holds a SHA-256 hash and this interface never speaks in anything else.
 */
export interface SessionRepository {
  /** Looks a session up by the hash of a presented token. Never by the token itself. */
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SessionRecord>;
  /** Extends the idle window on use. Never extends the absolute lifetime. */
  touch(input: { id: string; idleExpiresAt: Date }): Promise<void>;
  /** Server side revocation. Contract section 5.3. */
  revoke(id: string): Promise<void>;
  /** Revokes every live session for a user, for password change and dismissal. */
  revokeAllForUser(userId: string): Promise<number>;
}

/** What is being counted. Contract section 5.2 requires both per address and per account. */
export type AuthThrottleScopeKind = 'address' | 'account';

export interface AuthThrottleStatus {
  failureCount: number;
  /** Null when not locked. A time in the future means locked until then. */
  lockedUntil: Date | null;
}

/** Deployment level, per contract section 5.3. Never per company at authentication time. */
export interface AuthThrottlePolicy {
  maxAttempts: number;
  windowMinutes: number;
  lockoutMinutes: number;
}

/**
 * Login throttling state. Global, per contract section 4.6 as amended 2026-09-10.
 *
 * Global by necessity rather than convenience: authentication precedes tenant resolution, and
 * an attempt against an address matching no account has no user and no tenant to attribute it
 * to. That attempt is exactly what a per-address limit exists to catch.
 */
export interface AuthThrottleRepository {
  status(kind: AuthThrottleScopeKind, key: string): Promise<AuthThrottleStatus>;
  /**
   * Records one failure and locks if the limit is reached, in a single atomic statement.
   *
   * Atomic matters here more than it looks. A read, then a decision, then a write would let
   * concurrent attempts each read the same count and each conclude they were under the limit,
   * which is precisely the bypass a limiter exists to prevent.
   */
  recordFailure(
    kind: AuthThrottleScopeKind,
    key: string,
    policy: AuthThrottlePolicy,
  ): Promise<AuthThrottleStatus>;
  /**
   * Clears the counter after a successful authentication.
   *
   * Refuses while a lock is in force, so a correct password part way through a lockout cannot
   * end it early. Earlier typos are forgiven; an active lock is not.
   */
  clearOnSuccess(kind: AuthThrottleScopeKind, key: string): Promise<void>;
}
/** What an actor scoped unit of work hands to its callback. */
export interface ScopedRepositories {
  readonly companies: CompanyRepository;
  readonly sessions: SessionRepository;
  readonly memberships: MembershipRepository;
  readonly users: UserRepository;
  readonly audit: AuditRepository;
  readonly authThrottle: AuthThrottleRepository;
}

/**
 * What a system scoped unit of work hands to its callback.
 *
 * Deliberately narrower. Without a tenant in the scope, row level security denies every
 * tenant-scoped row, so offering those repositories would be offering methods that return
 * nothing. Provisioning names its tenant and gets the full set.
 */
export interface SystemRepositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly companies: CompanyRepository;
  readonly memberships: MembershipRepository;
  readonly audit: AuditRepository;
  readonly authThrottle: AuthThrottleRepository;
}

/** Thrown when an optimistic locking check fails. Contract section 10.1. */
export class ConcurrencyConflictError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified by someone else. Re-read it and try again.`);
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * Thrown when a scoped operation finds nothing.
 *
 * Contract section 6.1: a failure at the tenant dimension is indistinguishable from the record
 * not existing. Callers get the same error either way, so identifiers cannot be probed to learn
 * what other tenants hold.
 */
export class RecordNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`);
    this.name = 'RecordNotFoundError';
  }
}
